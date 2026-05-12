# Proxy Streaming

This document is a technical breakdown of Claude Code proxy behavior as it
relates to `claude-code-headless`, with emphasis on:

- how Claude itself handles proxies
- what traffic paths exist
- how TLS trust works
- what is easy vs. brittle
- how the current proxy-streaming experiment is wired
- what failed in the first attempt
- what the chunk-streaming fix changed

This is intentionally deeper than a feature note. The point is to capture the
 tricky parts and source-backed constraints so future work does not need to
 re-derive them from scratch.

## Executive Summary

Proxy-based Claude streaming is technically possible.

The hard parts are not:

- "special Claude encryption"
- inability to decrypt traffic in principle
- inability to observe the upstream model stream at all

The hard parts are:

- getting the Claude process onto a proxy path consistently
- making the Claude process trust a MITM CA
- dealing with multiple Claude transport branches
- distinguishing the *visible assistant turn* from other `/v1/messages` calls
- handling streaming incrementally instead of after full buffering
- preserving screen parsing for UI state that does not live in the network stream

The biggest mistake in the first experiment was not "proxying Claude". The
mistake was buffering the full SSE body and only parsing it after the turn had
finished.

## Scope

This document is specifically about proxy behavior for Claude Code as observed
through the upstream Claude source included in the Agent Code workspace and the
experimental work in `claude-code-headless`.

Relevant upstream source areas:

- `claude-code-src/full/utils/proxy.ts`
- `claude-code-src/full/services/api/client.ts`
- `claude-code-src/full/services/api/claude.ts`
- `claude-code-src/full/upstreamproxy/upstreamproxy.ts`
- `claude-code-src/full/upstreamproxy/relay.ts`
- `claude-code-src/full/utils/auth.ts`
- `claude-code-src/full/remote/SessionsWebSocket.ts`
- `claude-code-src/full/entrypoints/init.ts`
- `claude-code-src/full/utils/subprocessEnv.ts`

Relevant experiment files here:

- `src/testing/proxy-testing/bootstrap.ts`
- `src/testing/proxy-testing/proxyServer.ts`
- `src/testing/proxy-testing/mitmAddon.py`
- `src/testing/proxy-testing/sseParser.ts`
- `src/testing/proxy-testing/spawnClaudeWithProxy.ts`
- `src/testing/proxy-testing/run.ts`

Root repo demo:

- `experiments/claude-proxy-stream-app/`

## Why We Care

`claude-code-headless` today gets live Claude state primarily from:

- PTY bytes
- headless xterm screen snapshots
- screen parsers
- JSONL transcript tailing

That is sufficient, but it is not ideal for assistant streaming text.

Screen parsing is inherently heuristic:

- terminal layout can change
- tool chrome can look like content
- in-progress markers can scroll out of the viewport
- the UI can be correct while the parser is wrong

By contrast, the upstream Anthropic stream is the canonical source of:

- `message_start`
- `content_block_start`
- `content_block_delta`
- `text_delta`
- `thinking_delta`
- tool-related content blocks

If we can observe that stream cleanly, we can get a better assistant text
signal than screen parsing alone.

## Claude Proxy Architecture In Upstream Source

Claude has more than one "proxy" concept.

### 1. Generic HTTP/WebSocket Proxy Support

This is the standard proxy plumbing in:

- `claude-code-src/full/utils/proxy.ts`

This file centralizes:

- `HTTPS_PROXY` / `HTTP_PROXY` lookup
- `NO_PROXY` lookup and bypass matching
- axios proxy agent setup
- undici global dispatcher setup
- WebSocket proxy handling
- mTLS and custom CA handling
- the special `ANTHROPIC_UNIX_SOCKET` path for Anthropic API transport

Key facts from source:

- `getProxyUrl()` prefers lowercase env vars over uppercase.
- `shouldBypassProxy()` implements `NO_PROXY` matching itself.
- `configureGlobalAgents()` wires axios and undici to use the configured proxy.
- `getWebSocketProxyAgent()` and `getWebSocketProxyUrl()` support WebSocket
  transport through the same proxy path.
- `getProxyFetchOptions({ forAnthropicAPI: true })` is what the Anthropic API
  client uses.

This is the path that matters most for local MITM experiments.

### 1a. Startup Ordering Matters

Claude does not "just happen" to use proxy settings. The order in which startup
 code applies CA and proxy configuration is deliberate.

In `claude-code-src/full/entrypoints/init.ts`, startup does this in order:

1. configure extra CA certs
2. configure global mTLS
3. call `configureGlobalAgents()`
4. optionally preconnect to the Anthropic API
5. optionally initialize CCR upstream proxy

That order matters because:

- proxy settings need the final CA store
- preconnect must not warm the wrong transport
- CCR upstream proxy is layered on top after normal proxy setup

The source comment around `preconnectAnthropicApi()` is especially useful:
preconnect is intentionally skipped when proxy, mTLS, or unix-socket transport
is active because the custom dispatcher/agent path would not reuse the warmed
connection pool anyway.

Implication for our experiment:

- we should not assume Claude always uses one shared default fetch path
- proxy-related behavior depends on startup configuration already being settled

### 1b. Proxy Config Is Re-applied After Settings Load

In `claude-code-src/full/utils/managedEnv.ts`, Claude applies trusted settings
 env vars into `process.env`, clears proxy/CA/mTLS caches, and calls
 `configureGlobalAgents()` again.

This is tricky for experiments because it means:

- spawn env is not the only source of proxy-related config
- user settings or managed settings can overwrite or augment proxy behavior
- a proxy that worked at process launch can later be affected by settings-based
  env application

This file also strips some env vars under special circumstances:

- `ANTHROPIC_UNIX_SOCKET` and related auth placeholders are stripped from
  settings-sourced env in SSH tunnel mode
- provider-managed env vars can be stripped when the host controls routing
- desktop-host spawn env keys are protected from settings override in some
  modes

This is one of the main reasons a local proxy experiment can behave
 differently across launch environments even when "the same env vars" were
 passed at spawn time.

### 2. CCR Upstream Proxy

This is a different system:

- `claude-code-src/full/upstreamproxy/upstreamproxy.ts`
- `claude-code-src/full/upstreamproxy/relay.ts`

This code is only for CCR / remote container sessions.

It does all of this:

1. read a session token from `/run/ccr/session_token`
2. mark the process non-dumpable on Linux
3. download a CCR CA certificate
4. start a local CONNECT-to-WebSocket relay
5. delete the token file after relay startup
6. inject `HTTPS_PROXY` and CA env vars for subprocesses

This is not "general local Claude proxying". It is a specific remote/container
transport path.

The important implication for us:

- CCR has its own proxy branch
- local MITM assumptions do not automatically apply to CCR
- a "proxy works locally" result is not enough to claim "proxy works for all
  Claude modes"

### 3. `ANTHROPIC_UNIX_SOCKET` Auth Tunnel

This is another special branch:

- `claude-code-src/full/utils/proxy.ts`
- `claude-code-src/full/utils/auth.ts`

When `getProxyFetchOptions({ forAnthropicAPI: true })` sees
`ANTHROPIC_UNIX_SOCKET` under Bun, it returns `{ unix: ... }` instead of normal
proxy options for Anthropic API traffic.

This matters because:

- that path can bypass the proxy setup we expect
- it is only intended for Anthropic API traffic
- the upstream comments explicitly warn that it must not leak into unrelated
  fetch paths

So again: there is no single universal Claude transport path.

## What The Anthropic API Client Actually Does

The Anthropic client is constructed in:

- `claude-code-src/full/services/api/client.ts`

Important details:

- Claude sends `X-Claude-Code-Session-Id` on API requests.
- It uses `getProxyFetchOptions({ forAnthropicAPI: true })`.
- It builds a custom client with default headers and transport config.

This session header is important for request attribution in any proxy-based
experiment. A per-session proxy URL helps attribution, but the request headers
give another correlation signal.

Another subtle point: this is the Claude API client path, not the entire Claude
 product. Other subsystems use the proxy utilities too, but via different
 transports and wrappers.

## What The Stream Actually Looks Like

Claude's stream handling in:

- `claude-code-src/full/services/api/claude.ts`

shows that the upstream stream is not just a blob of text. It is a structured
event stream with typed events.

Important event shapes:

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_stop`

And inside `content_block_delta`, Claude handles:

- `text_delta`
- `thinking_delta`
- `input_json_delta`
- `signature_delta`
- other block-specific deltas

This is the source-backed reason proxy streaming is worth exploring at all:

- Claude itself is already incrementally consuming these deltas
- the upstream stream is expressive enough to reconstruct visible assistant text

There is one more nuance in the source:

- some comments in `claude.ts` note that certain text can appear first in
  `content_block_start` and then again in `content_block_delta`

That means a naive proxy parser can accidentally duplicate content if it does
 not mirror Claude's own event handling logic carefully.

## What "MITM" Means In Practice

If Claude is using HTTPS, a plain proxy is not enough to inspect response
bodies.

A plain proxy can:

- see destination hostnames
- see CONNECT setup
- route traffic

It cannot automatically see plaintext HTTPS payloads.

To see the actual stream content, the proxy must do MITM:

1. present a forged leaf certificate to Claude
2. have that forged leaf signed by a CA Claude trusts
3. decrypt the TLS session locally
4. open a separate TLS session upstream
5. forward bytes between the two

So the key requirement is not "breaking encryption". It is:

- getting Claude to trust our local CA

That is why our experiment injects:

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `NODE_EXTRA_CA_CERTS`
- `SSL_CERT_FILE`
- `REQUESTS_CA_BUNDLE`
- `CURL_CA_BUNDLE`

in `spawnClaudeWithProxy.ts`.

## Why `NODE_EXTRA_CA_CERTS` Matters

Upstream Claude source explicitly cares about this.

There are comments in Claude about:

- loading extra CAs early
- using `NODE_EXTRA_CA_CERTS`
- corporate proxies / TLS interception
- Bun/Node trust behavior

This is not a hypothetical path. The source itself already acknowledges that
Claude may run behind TLS-intercepting proxies.

That is why the local experiment is technically plausible.

In practical terms for our harness:

- `NODE_EXTRA_CA_CERTS` is the main trust path for Claude itself
- `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE` are defensive
  additions for child tools, not the core Claude runtime

## Why `NO_PROXY` Is Dangerous

One subtle but critical trap:

If `NO_PROXY` includes Anthropic hosts, Claude will bypass your local proxy for
the exact traffic you want to observe.

This is especially easy to get wrong because the CCR upstream proxy code
intentionally sets:

- `anthropic.com`
- `.anthropic.com`
- `*.anthropic.com`

in its own `NO_PROXY_LIST`.

That is correct for CCR's use case.
It is wrong for our local MITM experiment.

So for the local proxy experiment:

- loopback should stay in `NO_PROXY`
- Anthropic should **not** be in `NO_PROXY`

This distinction is load-bearing.

## Bun vs Node Differences

Claude's proxy code has separate paths for Bun and Node-ish behavior.

Examples:

- WebSocket under Bun uses a `proxy` URL string
- WebSocket under Node uses an `agent`
- fetch options differ
- `ANTHROPIC_UNIX_SOCKET` handling is gated to Bun

This means our experimental results are partly runtime-sensitive.

In practice:

- the `claude` binary on this machine is running in the real Claude runtime
- our experiment should assume that transport behavior may differ across
  versions and across environments

This is one reason proxy streaming can be valid and still brittle.

The practical implication is that "works in a Node test harness" and "works in
 the Claude binary" are not equivalent claims.

Claude's upstream source contains Bun-specific branches in exactly the proxy
 and WebSocket areas we care about most.

## Other Proxy Consumers Inside Claude

The proxy utilities are not only used by the core Anthropic client.

### HTTP Hooks

`claude-code-src/full/utils/hooks/execHttpHook.ts` uses:

- `getProxyUrl()`
- `shouldBypassProxy()`
- axios with `configureGlobalAgents()`-installed interceptors

Important consequence:

- when env-var proxying is active, hook traffic can also route through a proxy
- SSRF lookup protections are skipped when a proxy is active, because the proxy
  resolves DNS for the target

That means proxy enablement changes more than just "model traffic". It changes
 the security and networking behavior of HTTP hooks too.

### MCP Clients

`claude-code-src/full/services/mcp/client.ts` routes several transport types
 through the proxy helpers:

- SSE MCP transports call `getProxyFetchOptions()`
- HTTP MCP transports call `getProxyFetchOptions()`
- WebSocket MCP transports call `getWebSocketProxyUrl()` or
  `getWebSocketProxyAgent()`
- claude.ai-proxy MCP transport also layers on proxy fetch options

This matters for experiments because a single Claude session can generate proxy
 traffic from:

- core Anthropic model requests
- MCP SSE streams
- MCP HTTP requests
- MCP WebSocket sessions

So "all proxy traffic for this session belongs to assistant streaming" is not
 true even when attribution to the session itself is solved.

### Remote Session WebSockets

`claude-code-src/full/remote/SessionsWebSocket.ts` shows that remote sessions
 use WebSocket transport with:

- `getWebSocketProxyUrl()` under Bun
- `getWebSocketProxyAgent()` under Node

This is a distinct branch from the normal Anthropic `/v1/messages` flow.

For local MITM streaming work, the main point is:

- remote session support proves proxying is broader than plain HTTPS POSTs
- a proxy stack that only thinks about `/v1/messages` is incomplete as a model
  of Claude's total network surface

## Preconnect Is A Real Edge Case

`claude-code-src/full/utils/apiPreconnect.ts` intentionally performs a
 fire-and-forget `HEAD` to the Anthropic base URL during init, but only when:

- there is no proxy
- there is no mTLS
- there is no `ANTHROPIC_UNIX_SOCKET`
- no alternate cloud provider is active

This is easy to miss, but technically important:

- when proxying is enabled, preconnect is skipped on purpose
- therefore a proxied session may differ slightly in startup timing and
  connection behavior from a direct session

For our experiments, this is not a blocker, but it is another reason proxy
 interception changes runtime behavior rather than merely observing it.

## Child Process Inheritance

Claude subprocesses inherit environment.

This includes:

- shell tools
- Python
- curl
- git
- MCP stdio/http children

So when we inject proxy env into the top-level Claude PTY process, we also
inject it into tool execution unless Claude scrubs or overrides those vars for
some branch.

Why this matters:

- it creates extra traffic noise
- it can create TLS surprises in child tools
- it can generate false positives in proxy capture
- it makes "all traffic on this proxy belongs to the assistant turn" false

This is one of the strongest arguments for keeping screen parsing as fallback
and not letting proxy capture become the only signal.

There is also a product-architecture consequence:

- if `claude-code-headless` owns proxy experimentation, it still needs to
  clearly distinguish "Claude API stream" from "everything else inherited from
  Claude's env"
- otherwise library consumers will overestimate what the captured stream means

## Why The First Experiment Failed

The first experiment successfully proved:

- we could force Claude through a local proxy
- we could get decrypted `text/event-stream` for `/v1/messages`

But it did **not** produce live right-pane streaming.

The reason was not the upstream stream.
The reason was not TLS.
The reason was not Claude refusing proxies.

The reason was the mitmproxy hook design.

### The Mistake

The original addon read SSE in `response(flow)` and called:

- `response.get_text(strict=False)`

That only gave us the body after full buffering / response completion.

So the Electron app parsed a completed SSE transcript after the turn was over.

That is fundamentally incompatible with real-time UI streaming.

### Why This Happens In mitmproxy

mitmproxy's own local code makes the mechanism explicit:

- `Message.stream` must be configured in `requestheaders` or `responseheaders`
- if not, mitmproxy buffers the message body
- `response(flow)` is too late for live chunk handling

The local installed mitmproxy source under the experiment venv states exactly
that in `mitmproxy/http.py`.

## The Streaming Fix

The correct mitmproxy mechanism is:

- set `flow.response.stream` in `responseheaders`

That causes mitmproxy to invoke a function for each response chunk.

We changed the addon to:

1. detect `/v1/messages` + `text/event-stream`
2. set `flow.response.stream = _make_stream_tap(flow)`
3. emit JSONL events for:
   - `request`
   - `response`
   - `response-chunk`
   - `response-end`

Each `response-chunk` includes:

- `flow_id`
- URL metadata
- base64 encoded chunk bytes

We also force:

- `Accept-Encoding: identity`

for Anthropic `/v1/messages` requests in the addon so chunk data is easier to
interpret incrementally instead of having to handle gzip stream decoding
ourselves at the capture layer.

## The Incremental SSE Parser

Once chunk capture existed, the app still needed an incremental parser.

The initial `sseParser.ts` only handled "whole blob in, events out".

We added:

- `IncrementalSseParser`

which:

1. appends decoded text to an internal buffer
2. splits on SSE event boundaries (`\n\n`)
3. yields complete SSE records incrementally
4. keeps partial records buffered until more bytes arrive

Then the Electron demo:

1. groups by `flow_id`
2. decodes chunk bytes incrementally with `TextDecoder(..., { stream: true })`
3. feeds decoded text into `IncrementalSseParser`
4. parses SSE records into Anthropic event objects
5. appends `text_delta` to the visible right-side stream

That is the minimum architecture needed for truly live proxy streaming.

One more subtle implementation detail:

- we use base64 for chunk payloads in JSONL because mitmproxy stream callbacks
  hand us bytes, not guaranteed UTF-8 text boundaries
- decoding to text before the app-level parser would risk corrupting
  multi-byte splits across chunks

## Why Streaming Still May Look Wrong

Even after chunk-level capture, "we are seeing live text" does not mean
"we are seeing the right visible assistant turn".

The remaining big problem is request selection.

### Not Every `/v1/messages` Call Is The Main Turn

Claude can use `/v1/messages` for multiple things.

In practice we have already seen a proxy-captured stream that produced JSON-like
title output instead of the visible user-facing answer.

So even with perfect SSE capture, the app can still show the wrong stream if it
simply picks "anything whose URL contains `/v1/messages`".

### `message_start` Reset Is Too Naive By Itself

If multiple `/v1/messages` requests are in flight over time, resetting the right
pane on any `message_start` is incorrect.

We need stronger request attribution and filtering:

- `X-Claude-Code-Session-Id`
- maybe flow ordering relative to user prompt
- message ids from `message_start`
- possibly request body inspection if necessary

This is currently the most likely next source of weirdness after transport.

Another subtle risk is that a transport can be correct while the UI decision is
 wrong. For example:

- the proxy can correctly show a valid Claude SSE stream
- the app can still attach that stream to the wrong visible turn

So there are two independent correctness problems:

1. transport capture correctness
2. UI attribution correctness

## Why Proxy Streaming Will Never Replace Everything

Even if proxy capture becomes excellent for assistant text, it still does not
replace screen parsing for all headless state.

Network stream gives:

- assistant text deltas
- thinking deltas
- tool-use related content blocks
- message lifecycle

Screen parsing still gives:

- trust dialogs
- slash picker
- compaction UI
- resume prompt UI
- Claude's activity spinner
- exact terminal rendering state

Transcript tailing still gives:

- on-disk truth after Claude writes the transcript
- resumable session history
- post-turn reconciliation

So the likely long-term architecture is:

- proxy stream for preferred assistant-text signal
- screen parser for UI-only state and fallback
- transcript tailer for eventual truth

## Current Experimental Layout

Inside `claude-code-headless`:

- `src/testing/proxy-testing/bootstrap.ts`
  Creates a local virtualenv and installs `mitmproxy`.
- `src/testing/proxy-testing/proxyServer.ts`
  Starts `mitmdump`, manages runtime directory, proxy URL, CA path, addon path.
- `src/testing/proxy-testing/mitmAddon.py`
  The actual mitmproxy addon.
- `src/testing/proxy-testing/sseParser.ts`
  Whole-blob and incremental SSE parsing helpers.
- `src/testing/proxy-testing/spawnClaudeWithProxy.ts`
  Spawns Claude with the env needed for local MITM.
- `src/testing/proxy-testing/run.ts`
  Non-GUI harness for comparing proxy stream vs screen parser vs transcript.

In the root repo:

- `experiments/claude-proxy-stream-app/`
  Standalone Electron demo showing left terminal, right decrypted stream.

## Known Failure Modes

This list is intentionally explicit.

### 1. Dead Proxy Port

If the proxy process fails before Claude connects, Claude shows:

- `Unable to connect to API (ConnectionRefused)`

We hit this once because the built JS looked for `mitmAddon.py` under `dist/`,
but the Python file only existed in `src/`.

### 2. Anthropic Accidentally Bypassed

If `NO_PROXY` includes Anthropic hosts, the upstream model stream bypasses the
local MITM entirely.

### 3. Full-Body Buffering

If the addon reads `response.get_text()` in `response(flow)` without streaming,
the capture is post-hoc instead of live.

### 4. Wrong `/v1/messages` Stream

A valid stream can still be the wrong one for the visible assistant answer.

### 5. Child Tool Noise

Subprocess network traffic can muddy flow attribution.

### 6. Special Transport Branches

CCR upstream proxy and `ANTHROPIC_UNIX_SOCKET` mean not all Claude runs are
created equal.

### 7. Version Drift

Proxy behavior is real source code, not a stable public API contract.
Minor Claude releases can change enough to break assumptions.

### 8. Settings Reconfiguration

Settings-sourced env can reapply proxy or CA state after startup behavior has
 already begun to settle.

### 9. Non-Core Proxy Traffic

MCP, hooks, remote session machinery, or child tools can generate traffic that
 is valid for the session but irrelevant to the main assistant reply.

### 10. Duplicate Or Non-Visible Deltas

Some delta handling in upstream Claude is more nuanced than "append every text
 field you see". A simplistic parser can produce duplicated or misleading text.

## Source-Backed Conclusions

These are the conclusions that are strong enough to rely on:

1. Claude has real proxy support in normal local runtime.
2. Claude has separate special-case transport branches beyond normal proxy env.
3. Claude consumes incremental upstream Anthropic stream events.
4. MITM is sufficient to decrypt those events if Claude trusts the CA.
5. Full-body interception is not enough for live UI streaming.
6. Chunk-level response streaming in mitmproxy is the correct capture mechanism.
7. Proxy streaming is useful, but not sufficient to replace all other headless
   observation layers.
8. Proxy behavior in Claude is affected by startup ordering, settings-sourced
   env, runtime-specific Bun/Node branches, and non-core transport consumers.

## What To Do Next

The next technical improvements should focus on correctness, not just capture.

Priority order:

1. tighten request selection for the visible assistant turn
2. add better flow correlation in the Electron demo and harness
3. record request headers/body metadata needed to distinguish title generation
   from visible assistant answers
4. compare proxy deltas against screen extraction and JSONL writes over time
5. only then consider promoting any of this into non-experimental library API

## Commands

Inside `claude-code-headless`:

```bash
npm run proxy-test-bootstrap
npm run proxy-test
```

From the root repo:

```bash
npm run proxy-demo-bootstrap
npm run proxy-demo
```
