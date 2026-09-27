import { readFileSync } from 'node:fs'
import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeCodeHeadless } from './ClaudeCodeHeadless.js'

// agent-code#1253, on a REAL Claude Code 2.1.283 recording (test/fixtures/
// slash-picker/README.md): arrowing through the slash picker can change only
// the highlight colour, with byte-identical text. HeadlessTerminal's flush gate
// compares text only, so no screen frame fired, the picker was never reparsed,
// and `claude.slash-picker` kept the old selected row until the text changed.
//
// Asserted through the published conditions snapshot, not the private picker
// state, because the producer was unpinned too: an empty picker in the
// evaluator input survived every suite.

type Recording = { cols: number; rows: number; steps: Array<{ step: string; chunks: string[] }> }
const recording = JSON.parse(readFileSync(
  new URL('../test/fixtures/slash-picker/colour-only-selection-2.1.283.json', import.meta.url), 'utf8',
)) as Recording

function fakePty(cols: number, rows: number): IPty {
  const disposable = { dispose: vi.fn() }
  return {
    pid: 1, process: 'claude', cols, rows, handleFlowControl: false,
    write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(),
    onData: vi.fn(() => disposable), onExit: vi.fn(() => disposable),
  } as unknown as IPty
}

describe('slash picker on a real recording (#1253)', () => {
  it('publishes every selection change, including colour-only ones', async () => {
    const headless = new ClaudeCodeHeadless({ pty: fakePty(recording.cols, recording.rows), cwd: '/tmp', cols: recording.cols, rows: recording.rows })
    const terminal = (headless as unknown as { terminal: EventEmitter & { writeForTest(data: string): Promise<void> } }).terminal
    const published = (): { visible: boolean; selected: string | null } => {
      const condition = (headless.getConditionSnapshot().conditions as Record<string, { state?: { items: Array<{ id: string; selected: boolean }> } } | undefined>)['claude.slash-picker']
      if (!condition?.state) return { visible: false, selected: null }
      return { visible: true, selected: condition.state.items.find(item => item.selected)?.id ?? null }
    }
    const play = async (step: string): Promise<void> => {
      for (const chunk of recording.steps.find(entry => entry.step === step)!.chunks) await terminal.writeForTest(chunk)
    }

    await play('open-filtered')
    await vi.waitFor(() => expect(published()).toEqual({ visible: true, selected: '/copy' }), { timeout: 2000 })

    // The text of every picker row is identical to `open-filtered`: only the colour moved.
    await play('arrow-down-1')
    await vi.waitFor(() => expect(published()).toEqual({ visible: true, selected: '/color' }), { timeout: 2000 })

    await play('arrow-down-2')
    await vi.waitFor(() => expect(published()).toEqual({ visible: true, selected: '/config' }), { timeout: 2000 })

    // Scrolls back to the exact text of `arrow-down-1`, colour on /color.
    await play('arrow-up-1')
    await vi.waitFor(() => expect(published()).toEqual({ visible: true, selected: '/color' }), { timeout: 2000 })

    await play('escape')
    await vi.waitFor(() => expect(published()).toEqual({ visible: false, selected: null }), { timeout: 2000 })
  })
})
