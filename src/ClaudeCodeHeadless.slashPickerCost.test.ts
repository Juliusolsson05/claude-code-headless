import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import { expect, it, vi } from 'vitest'

// #1253 review b (surviving mutant): the picker-selection gate signature must
// cost nothing while no picker is visible. The flush gate is text-only because
// per-frame attribute work pinned main at ~80% CPU (agent-code#390), and
// Claude's TUI repaints identical chrome many times a second while working. So
// on identical no-picker frames the picker parser must run only for frames that
// are actually emitted, never once per dropped flush.
const calls = vi.hoisted(() => ({ detect: 0 }))
vi.mock('./parsers/SlashPickerParser.js', async importOriginal => {
  const original = await importOriginal<typeof import('./parsers/SlashPickerParser.js')>()
  return { ...original, detectSlashPicker: (...args: Parameters<typeof original.detectSlashPicker>) => { calls.detect += 1; return original.detectSlashPicker(...args) } }
})
const { ClaudeCodeHeadless } = await import('./ClaudeCodeHeadless.js')

function fakePty(): IPty {
  const disposable = { dispose: vi.fn() }
  return {
    pid: 1, process: 'claude', cols: 80, rows: 24, handleFlowControl: false,
    write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(),
    onData: vi.fn(() => disposable), onExit: vi.fn(() => disposable),
  } as unknown as IPty
}

it('does not parse the picker on dropped flushes while no picker is visible', async () => {
  const headless = new ClaudeCodeHeadless({ pty: fakePty(), cwd: '/tmp', cols: 80, rows: 24, snapshotIntervalMs: 1 })
  const terminal = (headless as unknown as { terminal: EventEmitter & { writeForTest(data: string): Promise<void> } }).terminal
  let screens = 0
  terminal.on('screen', () => { screens += 1 })
  const RULE = '─'.repeat(60)
  // Home the cursor and repaint the same composer: every flush after the first
  // sees byte-identical text, the shape of Claude's idle chrome redraws.
  const frame = `\x1b[H${RULE}\r\n❯ \r\n${RULE}`
  for (let i = 0; i < 20; i++) {
    await terminal.writeForTest(frame)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(screens).toBeGreaterThan(0)
  // The screen handler parses once per emitted frame; nothing else may.
  expect(calls.detect).toBe(screens)
})

// #1253 review a, on the real 2.1.283 recording: (1) the signature recorded
// for an emitted frame must be the POST-parse one, or a picker that just
// opened emits a duplicate frame on the next no-op write; (2) a frame whose
// text changed is emitted anyway, so the live signature must not re-parse the
// grid for it (the screen handler's parse is the only one).
it('neither duplicates a frame after the picker opens nor parses a changed frame twice', async () => {
  const { readFileSync } = await import('node:fs')
  const recording = JSON.parse(readFileSync(new URL('../test/fixtures/slash-picker/colour-only-selection-2.1.283.json', import.meta.url), 'utf8')) as { cols: number; rows: number; steps: Array<{ step: string; chunks: string[] }> }
  const headless = new ClaudeCodeHeadless({ pty: fakePty(), cwd: '/tmp', cols: recording.cols, rows: recording.rows, snapshotIntervalMs: 1 })
  const terminal = (headless as unknown as { terminal: EventEmitter & { writeForTest(data: string): Promise<void> } }).terminal
  let screens = 0
  terminal.on('screen', () => { screens += 1 })
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  const play = async (step: string) => {
    for (const chunk of recording.steps.find(entry => entry.step === step)!.chunks) await terminal.writeForTest(chunk)
    await settle()
  }
  await play('open-filtered')
  expect(headless.getSlashPickerState().visible).toBe(true)

  // (1) No-op writes (cursor home: no text, no colour change).
  const afterOpen = screens
  await terminal.writeForTest('\x1b[H'); await settle()
  await terminal.writeForTest('\x1b[H'); await settle()
  expect(screens).toBe(afterOpen)

  // (2) A scroll changes the text: one parse per emitted frame, no more.
  const [screensBefore, detectBefore] = [screens, calls.detect]
  await play('arrow-down-2')
  expect(screens).toBeGreaterThan(screensBefore)
  expect(calls.detect - detectBefore).toBe(screens - screensBefore)
})
