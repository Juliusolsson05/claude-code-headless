<p align="center">
  <strong>claude-code-headless</strong>
</p>

<p align="center">
  Programmatically drive the <em>real</em> Claude Code CLI — structured
  events, live token streaming, full transcript access. No SDK shortcuts.
</p>

<p align="center">
  <a href="https://github.com/Juliusolsson05/claude-code-headless/stargazers"><img src="https://img.shields.io/github/stars/Juliusolsson05/claude-code-headless?style=flat" alt="Stars"></a>
  <a href="https://github.com/Juliusolsson05/claude-code-headless/network/members"><img src="https://img.shields.io/github/forks/Juliusolsson05/claude-code-headless?style=flat" alt="Forks"></a>
  <a href="https://github.com/Juliusolsson05/claude-code-headless/issues"><img src="https://img.shields.io/github/issues/Juliusolsson05/claude-code-headless?style=flat" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Juliusolsson05/claude-code-headless?style=flat" alt="License"></a>
  <a href="https://github.com/Juliusolsson05/claude-code-headless/commits/main"><img src="https://img.shields.io/github/last-commit/Juliusolsson05/claude-code-headless?style=flat" alt="Last commit"></a>
</p>

---

## Why this exists

Claude Code is a terminal application. If you want to build on top of it
programmatically, today's options are bad:

- **The SDK** gives you a reduced surface — send a message, get a message
  back. It throws away most of what makes Claude Code good in practice:
  the slash-command system, permission prompts, compaction, session
  resume, the full tool loop, the real streaming behaviour.
- **Screen-scraping the TUI** is brittle and gives you pixels, not
  meaning.

`claude-code-headless` takes the opposite approach. It runs the **actual
`claude` binary** inside a pseudo-terminal and exposes everything the CLI
does as structured, typed events. The full command surface, the real
prompts, the real flows stay intact. You get the real product,
programmatically.

This is a control layer. Build an editor, an automation, a multi-agent
orchestrator, a harness — anything that needs to drive Claude Code
without giving up what Claude Code actually is.

## What you get

- **The real CLI, in a PTY.** Every command, prompt, tool, and flow the
  `claude` binary has, you have. Nothing is reimplemented or reduced.
- **A three-channel event model.** Observation is split into three typed
  streams so you never confuse "the model produced this" with "this is
  on screen" with "this is durably committed":
  - `semantic` — what the model is producing (text, thinking, tool calls)
  - `screen` — terminal visual state (overlays, activity, pickers)
  - `committed` — the durable transcript, as written to disk
- **Live token streaming.** An optional proxy adapter taps Claude Code's
  network traffic and surfaces assistant text, thinking, and tool input
  token-by-token — well ahead of the transcript file.
- **Transcript access.** Structured, typed tailing of Claude Code's own
  JSONL transcripts under `~/.claude/projects/`.
- **TUI parsers.** Trust dialogs, permission prompts, slash-command
  pickers, compaction banners, resume prompts — detected and handed to
  you as typed state, not regex soup.
- **Embeddable.** Pure-function parsers, a consumer-owned PTY, no global
  state. Drop it into an Electron app, a server, a CLI tool.

## Use it

`claude-code-headless` is **not published to npm**. Use it one of two
ways.

**Install from git** — npm can install straight from the repository:

```bash
npm install github:Juliusolsson05/claude-code-headless node-pty
```

**Or vendor it** — clone (or add as a submodule) and build from source:

```bash
git clone https://github.com/Juliusolsson05/claude-code-headless.git
cd claude-code-headless
npm install
npm run build
```

Either way you also need the `claude` CLI itself installed and on your
`PATH` — this package drives the real binary. `node-pty` is a peer
dependency; the consumer provides it (and owns the PTY).

## Quick start

```ts
import { ClaudeCodeHeadless } from 'claude-code-headless'
import { spawn } from 'node-pty'

// You own the PTY. The library never spawns or kills processes for you.
const pty = spawn('claude', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
})

const claude = new ClaudeCodeHeadless({ pty, cwd: process.cwd() })

// Live assistant text, token by token.
claude.semantic.on('text_delta', (e) => process.stdout.write(e.textDelta))

// Durable transcript turns, as they commit to disk.
claude.committed.on('turn_committed', (e) => {
  console.log(`\n[${e.role}] committed`)
})

await claude.start()
await claude.sendPrompt('Explain this repository in two sentences.')
```

## How it works

The package combines four pieces:

| Piece | Role |
|---|---|
| **PTY mirror** | `claude` runs in a pseudo-terminal; an `@xterm/headless` instance mirrors the screen so visual state is always queryable. |
| **Transcript tailer** | Claude Code's JSONL transcript is tailed with a poll-based watcher; durable history surfaces on the `committed` channel. |
| **Proxy adapter** *(optional)* | A mitmproxy-style runtime taps the network stream and drives the `semantic` channel with token-level events, ahead of the transcript. |
| **Parsers** | Pure functions turn screen snapshots into typed overlay state for the `screen` channel. |

Three documents describe the package in depth:

- [`API.md`](API.md) — the complete API reference: every export, every
  class and method, every event and option, with usage.
- [`EVENT_SPEC.md`](EVENT_SPEC.md) — every semantic event, every content
  block, every stop reason and usage shape.
- [`PROXY_STREAMING.md`](PROXY_STREAMING.md) — the proxy architecture,
  why it exists, and how live streaming is wired.

## Project structure

```
src/
  index.ts               Public API surface
  ClaudeCodeHeadless.ts   The orchestrator class
  channels/              The three-channel event model (semantic/screen/committed)
  terminal/              @xterm/headless + node-pty wrapper
  parsers/               Pure-function TUI parsers (dialogs, pickers, banners)
  proxy/                 mitmproxy adapter, Anthropic SSE parsing, the launcher
  transcript/            JSONL tailing, session discovery, transcript types
```

## Status

Early and moving. This is `0.x` — the API surface is still settling and
breaking changes land without ceremony. Pin a version.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the branch workflow,
and PR guidelines.

## Security

This package spawns the real `claude` CLI and — when the proxy is enabled
— intercepts its network traffic locally. That has real security
implications. Read [`SECURITY.md`](SECURITY.md) before enabling the
proxy, and to report a vulnerability.

## License

[MIT](LICENSE) © Julius Olsson
