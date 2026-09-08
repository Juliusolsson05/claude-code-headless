/**
 * ink-feed — render the claude-code-headless semantic channel as a live
 * terminal feed, the way Claude Code itself paints a turn: dim streaming
 * thinking that collapses to a "Thought…" line, streaming text, tool calls
 * as ⏺/⎿ rows, and a usage footer per completed message.
 *
 * WHY this example exists: the SDK's whole value is that a consumer gets
 * token-level model output as structured events — but until you SEE it
 * rendered, "message_completed with assembled blocks" is abstract. This is
 * the reference consumer: every visual element maps 1:1 to a semantic
 * event type, so it doubles as living documentation of the channel.
 *
 * WHY React.createElement (h) instead of JSX: the package tsconfig has no
 * `jsx` setting and this file lives outside src/ — a no-JSX .mts keeps the
 * example runnable via `npx vite-node examples/ink-feed.mts` with zero
 * build-config changes.
 *
 * Usage:
 *   npx vite-node examples/ink-feed.mts ["your prompt"]
 * Defaults to a small tool-using task so the feed shows ⏺ tool rows too.
 * Press q to quit early.
 */
import net from 'node:net'
import { join } from 'node:path'
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'

import {
  ClaudeCodeHeadless,
  createProxyServer,
  spawnClaudeWithProxy,
} from '../src/index.js'
import type { SemanticEvent } from '../src/index.js'

// --- feed model -----------------------------------------------------------

type Block =
  | { kind: 'thinking'; text: string; done: boolean }
  | { kind: 'text'; text: string; done: boolean }
  | { kind: 'tool'; name: string; preview: string; done: boolean }
  | { kind: 'tool_result'; preview: string; isError: boolean }

type Turn = {
  id: string
  blocks: Block[]
  /** Usage snapshot from the most recent usage-bearing event. */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  stopReason?: string
  completed: boolean
}

/**
 * Fold a semantic event into the feed model. This is intentionally a dumb
 * reducer — the point of the example is showing WHICH events carry WHAT,
 * not clever state handling.
 */
function foldEvent(turns: Turn[], ev: SemanticEvent): Turn[] {
  const t = turns[turns.length - 1]
  const patchLast = (fn: (turn: Turn) => Turn): Turn[] => [
    ...turns.slice(0, -1),
    fn(t ?? { id: 't0', blocks: [], completed: false }),
  ]

  switch (ev.type) {
    case 'turn_started':
      return [...turns, { id: ev.turnId, blocks: [], completed: false }]
    case 'thinking_delta':
      return patchLast(turn => ({
        ...turn,
        blocks: upsertStream(turn.blocks, 'thinking', ev.thinkingDelta),
      }))
    case 'text_delta':
      return patchLast(turn => ({
        ...turn,
        blocks: upsertStream(turn.blocks, 'text', ev.textDelta),
      }))
    case 'tool_input_delta':
      return patchLast(turn => ({
        ...turn,
        blocks: upsertToolPreview(turn.blocks, ev.toolName ?? 'tool', ev.partialJson),
      }))
    case 'block_completed':
      return patchLast(turn => ({
        ...turn,
        blocks: turn.blocks.map(b =>
          b.kind === 'tool_result' ? b : { ...b, done: true },
        ) as Block[],
      }))
    case 'tool_result':
      return patchLast(turn => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          {
            kind: 'tool_result',
            preview: firstLine(ev.content),
            isError: ev.isError,
          },
        ],
      }))
    case 'usage_updated':
      return patchLast(turn => ({
        ...turn,
        usage: {
          input: ev.usage.input_tokens ?? turn.usage?.input,
          output: ev.usage.output_tokens ?? turn.usage?.output,
          cacheRead: ev.usage.cache_read_input_tokens ?? turn.usage?.cacheRead,
          cacheWrite: ev.usage.cache_creation_input_tokens ?? turn.usage?.cacheWrite,
        },
      }))
    case 'message_completed':
      return patchLast(turn => ({ ...turn, stopReason: ev.stopReason, completed: true }))
    case 'turn_completed':
      return patchLast(turn => ({ ...turn, completed: true }))
    default:
      return turns
  }
}

function upsertStream(blocks: Block[], kind: 'thinking' | 'text', delta: string): Block[] {
  const last = blocks[blocks.length - 1]
  if (last && last.kind === kind && !last.done) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + delta } as Block]
  }
  if (kind === 'thinking') return [...blocks, { kind, text: delta, done: false }]
  return [...blocks, { kind: 'text', text: delta, done: false }]
}

function upsertToolPreview(blocks: Block[], name: string, delta: string): Block[] {
  const last = blocks[blocks.length - 1]
  if (last && last.kind === 'tool' && !last.done) {
    return [...blocks.slice(0, -1), { ...last, preview: (last.preview + delta).slice(0, 60) }]
  }
  return [...blocks, { kind: 'tool', name, preview: delta.slice(0, 60), done: false }]
}

function firstLine(s: string): string {
  return s.split('\n').find(l => l.trim().length > 0)?.slice(0, 72) ?? ''
}

// --- components ------------------------------------------------------------

function ThinkingBlock({ block }: { block: Extract<Block, { kind: 'thinking' }> }) {
  // Claude Code behaviour: stream thinking dim while live, then collapse to
  // one summary line once the block settles — the content is scaffolding,
  // not the answer.
  if (!block.done) {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { dimColor: true, italic: true }, `✻ ${block.text.slice(-320)}`),
    )
  }
  // WHY skip empties: models without extended thinking still emit a thinking
  // block with empty text; painting "(0 chars)" is pure noise.
  if (block.text.length === 0) return null
  return h(Text, { dimColor: true }, `✻ Thinking… (${block.text.length} chars)`)
}

function ToolRow({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  return h(
    Box,
    null,
    h(Text, { color: 'magenta' }, '⏺ '),
    h(Text, { bold: true }, block.name),
    h(Text, { dimColor: true }, `(${block.preview})`),
  )
}

function ToolResultRow({ block }: { block: Extract<Block, { kind: 'tool_result' }> }) {
  return h(
    Box,
    null,
    h(Text, { color: block.isError ? 'red' : 'green' }, '  ⎿  '),
    h(Text, { dimColor: true }, block.preview),
  )
}

function TurnView({ turn }: { turn: Turn }) {
  return h(
    Box,
    { flexDirection: 'column' },
    ...turn.blocks.map((b, i) => {
      if (b.kind === 'thinking') return h(ThinkingBlock, { key: i, block: b })
      if (b.kind === 'tool') return h(ToolRow, { key: i, block: b })
      if (b.kind === 'tool_result') return h(ToolResultRow, { key: i, block: b })
      return h(Text, { key: i }, b.text)
    }),
    turn.usage
      ? h(
          Text,
          { dimColor: true },
          `  ↑ ${turn.usage.input ?? 0} in · ${turn.usage.output ?? 0} out · ` +
            `${(turn.usage.cacheRead ?? 0) + (turn.usage.cacheWrite ?? 0)} cached` +
            (turn.stopReason ? ` · ${turn.stopReason}` : ''),
        )
      : null,
  )
}

function App({ events, phase }: { events: SemanticEvent[]; phase: string }) {
  const { exit } = useApp()
  useInput(input => {
    if (input === 'q') exit()
  })
  const turns = useMemo(() => events.reduce(foldEvent, [] as Turn[]), [events])
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true }, 'claude-code-headless · live semantic feed'),
    ...turns.map((t, i) => h(TurnView, { key: i, turn: t })),
    h(Text, { dimColor: true }, phase === 'idle' ? '·' : `◌ ${phase}…`),
    h(Text, { dimColor: true }, 'q quit'),
  )
}

// --- driver ----------------------------------------------------------------

const prompt =
  process.argv[2] ??
  'Do not use the Skill tool for this task. Use Glob to list the markdown files in this directory, Read package.json, then summarize in two sentences what this package is.'

// WHY the package root and not a temp dir: the default task Globs/Reads real
// files, and an empty temp cwd makes every tool call error out, which drags
// the turn past the demo timeout. Read/Glob/Grep are read-only, so pointing
// the session at the package's own directory is safe and self-documenting.
const cwd = join(import.meta.dirname, '..')
const proxyServer = await createProxyServer({})
await proxyServer.start()
await waitForPort(proxyServer.info.proxyUrl)

const pty = spawnClaudeWithProxy({
  cwd,
  proxyUrl: proxyServer.info.proxyUrl,
  caCertPath: proxyServer.info.caCertPath,
  cols: 100,
  rows: 30,
  args: [
    '-p',
    prompt,
    // Read-only tools pre-allowed: -p cannot answer permission prompts, and
    // this example must not hang on a Bash allow question.
    '--allowedTools',
    'Read',
    'Glob',
    'Grep',
  ],
})

const headless = new ClaudeCodeHeadless({
  pty,
  cwd,
  cols: 100,
  rows: 30,
  freshSessionStartedAtMs: Date.now(),
  proxy: { getSessionModel: () => 'claude-opus-5' },
})
proxyServer.on('event', (ev: unknown) => {
  void headless.handleProxyTransportEvent(ev as never)
})

// WHY immutable copies: App folds `events` inside useMemo keyed on the array
// reference. Pushing into the same array never changes the reference, so the
// memo returns the first (empty) fold forever and the feed paints nothing —
// exactly the bug this comment prevents coming back.
let events: SemanticEvent[] = []
let phase = 'starting'
const { rerender, unmount } = render(h(App, { events, phase }))
const push = (ev: SemanticEvent): void => {
  events = [...events, ev]
  if (ev.type === 'stream_phase') phase = ev.phase
  rerender(h(App, { events, phase }))
}
headless.semantic.on('event', push)
// WHY this bridge: tool OUTPUT is not model output — it is committed by the
// CLI to the transcript JSONL, so it surfaces on the committed channel. The
// desktop app installs the same bridge (claudeSession.ts); a bare SDK
// consumer must do it too or the feed shows tool calls without results.
// KNOWN LIMIT: in -p mode the JsonlTailer may not emit committed entries
// (verified 2026-09-08: zero committed events on a live -p run), so the ⎿
// rows light up in interactive sessions and can stay empty here.
headless.committed.on('tool_result', (ev: { toolUseId: string; content: string; isError: boolean }) => {
  push({
    type: 'tool_result',
    turnId: 'bridged',
    toolUseId: ev.toolUseId,
    content: ev.content,
    isError: ev.isError,
    source: 'committed',
    confidence: 'high',
    ts: Date.now(),
  } as never)
})

// Auto-exit once the turn completes (plus a beat so message_completed lands).
const done = waitForTurnCompleted(headless, 180_000)
await done
await new Promise(r => setTimeout(r, 1500))
unmount()
await proxyServer.stop().catch(() => {})
pty.kill()
process.exit(0)

// --- helpers ---------------------------------------------------------------

async function waitForPort(proxyUrl: string): Promise<void> {
  // WHY: start() resolves when the CA is ready; with a pre-existing shared CA
  // that is BEFORE mitmdump binds (observed ~2s). Spawned claude would race
  // the listener and produce zero events.
  const port = Number(proxyUrl.split(':').pop())
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise<boolean>(res => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); res(true) })
      sock.once('error', () => res(false))
    })
    if (ok) return
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`proxy port ${port} never opened`)
}

function waitForTurnCompleted(headless: ClaudeCodeHeadless, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    const onEvent = (ev: SemanticEvent): void => {
      if (ev.type === 'turn_completed') {
        clearTimeout(timer)
        // Leave the listener attached for the trailing message_completed,
        // resolved by the caller's settle delay.
        setTimeout(resolve, 50)
      }
    }
    headless.semantic.on('event', onEvent)
  })
}
