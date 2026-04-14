# Proxy Streaming

This document explains the current proxy-streaming experiment in
`claude-code-headless`, what it proves, and what remains brittle.

## Goal

The goal is to capture Claude's live assistant output from decrypted upstream
Anthropic SSE traffic instead of inferring in-progress text only from terminal
screen parsing.

This is explicitly experimental.

- The stable runtime still relies on PTY mirroring, screen parsing, and JSONL
  transcript tailing.
- Proxy capture is being explored as a parallel signal, not yet as the sole
  product contract.

## What The Claude Source Proves

Claude does receive incremental upstream stream events.

In the upstream Claude source:

- `content_block_delta` events are handled during streaming.
- `text_delta` payloads are appended incrementally.

Relevant upstream file:

- `claude-code-src/full/services/api/claude.ts`

That means the stream exists and can, in principle, be observed before the turn
is complete.

## What Failed In The First Experiment

The first proxy experiment decrypted traffic successfully, but it did **not**
produce real-time UI streaming.

The reason was architectural:

1. The mitmproxy addon captured `text/event-stream` in the `response(flow)`
   hook.
2. That hook only saw the response body after buffering/completion.
3. The Electron demo then parsed the full SSE blob after the turn finished.

So the stream was decrypted, but not surfaced incrementally.

In short:

- decryption worked
- full-body capture worked
- live chunk capture did not exist yet

## Current Experimental Design

The isolated experiment lives under:

- `src/testing/proxy-testing/`

Key files:

- `bootstrap.ts`
  Creates a local Python virtualenv and installs `mitmproxy`.
- `proxyServer.ts`
  Starts `mitmdump`, manages runtime directories, and exposes the local proxy
  URL and generated CA path.
- `mitmAddon.py`
  mitmproxy addon that records requests and streamed response chunks.
- `spawnClaudeWithProxy.ts`
  Spawns Claude with per-session proxy env vars and CA trust settings.
- `sseParser.ts`
  Parses Anthropic SSE payloads into structured events.
- `run.ts`
  End-to-end harness for comparing proxy capture against screen parsing.

There is also a standalone Electron demo in the root repo:

- `experiments/claude-proxy-stream-app/`

That app shows:

- left: live Claude terminal
- right: decrypted streamed response assembled from proxy-captured SSE chunks

## The Important Fix

The experiment now uses **chunk-level streaming** instead of full-body capture.

The relevant mitmproxy mechanism is:

- set `flow.response.stream` in `responseheaders`

This causes mitmproxy to call a chunk-transform function for each response
chunk as it arrives.

The current addon now emits:

- `request`
- `response`
- `response-chunk`
- `response-end`

for the `/v1/messages` path.

The Electron demo then:

1. groups chunks by flow id
2. incrementally decodes bytes to UTF-8
3. incrementally parses SSE event boundaries
4. appends `text_delta` content to the right-hand stream pane in real time

## Why This Is Still Brittle

Even with chunk-level capture, proxy streaming is still not a perfect
replacement for screen parsing.

Reasons:

1. Claude can issue multiple `/v1/messages` requests for different purposes.
   Request selection and turn attribution still need to be tightened.
2. Remote / CCR / unix-socket auth paths are different transport branches.
3. Child tools inherit proxy env and can create noisy or surprising traffic.
4. The UI still needs screen parsing for:
   - trust dialogs
   - slash picker state
   - activity indicators
   - terminal chrome
   - generic PTY state

So the realistic long-term shape is:

- proxy streaming for assistant text when available
- screen parsing as fallback and for UI-only state
- transcript tailing as eventual truth

## Practical Conclusion

Proxy streaming is **not** a dead end.

The dead end was the original full-body interception design.

What works now:

- Claude traffic can be forced through a per-session local proxy.
- The proxy can decrypt Anthropic SSE responses.
- The experiment can observe those responses at chunk granularity.

What remains to improve:

- request filtering
- turn correlation
- reconciliation with screen/parser state
- hardening across Claude versions and transport modes

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
