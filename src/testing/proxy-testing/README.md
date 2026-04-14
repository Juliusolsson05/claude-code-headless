# Proxy Testing

This directory is an isolated experiment for proving whether `claude-code-headless`
can observe Claude's live assistant stream through a per-session HTTPS MITM proxy.

It is intentionally separate from the production runtime:

- no exports from `src/index.ts`
- no changes to `ClaudeCodeHeadless`
- no assumptions baked into the stable package API

The experiment uses `mitmproxy` as an external helper instead of shipping a
custom MITM implementation inside the package. The goal here is validation, not
yet another proxy stack to maintain.

## Files

- `bootstrap.ts`
  Creates `.proxy-testing/venv` and installs `mitmproxy` there.
- `proxyServer.ts`
  Starts `mitmdump` with a custom addon and exposes proxy/CA paths.
- `mitmAddon.py`
  Emits decrypted Anthropic request/response metadata and response chunks as JSONL.
- `spawnClaudeWithProxy.ts`
  Spawns Claude in a PTY with per-session proxy env vars.
- `sseParser.ts`
  Parses Anthropic SSE payloads into typed events and text deltas.
- `run.ts`
  End-to-end experiment runner. Launches the proxy, launches Claude through it,
  mirrors screen parsing with `ClaudeCodeHeadless`, and writes logs under
  `.proxy-testing/runs/<timestamp>/`.

## Usage

Bootstrap `mitmproxy` once:

```bash
npm run proxy-test-bootstrap
```

Run the experiment:

```bash
npm run proxy-test
```

Optional environment variables:

- `CC_PROXY_TEST_CWD`
  Working directory for Claude. Defaults to the current package directory.
- `CC_PROXY_TEST_CLAUDE_BINARY`
  Claude binary path. Defaults to `claude`.
- `CC_PROXY_TEST_PROMPT`
  If set, sends the prompt automatically after startup.
- `CC_PROXY_TEST_DURATION_MS`
  Optional timeout for automatic shutdown.

## Output

Each run creates:

- `meta.json`
- `proxy-events.jsonl`
- `screen-events.jsonl`
- `jsonl-events.jsonl`
- `summary.txt`

The point is to compare three signals:

1. proxy-captured text deltas
2. screen-parsed assistant text
3. transcript/jsonl entries

## Caveats

- This depends on `mitmproxy` being installed in the local experiment venv.
- This is for local standard Claude sessions. CCR / remote / unix-socket auth
  paths are expected to be partial or non-working in this experiment.
- Tool subprocesses inherit the proxy env in the spawned Claude process. That is
  part of what this experiment is meant to surface.
