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
