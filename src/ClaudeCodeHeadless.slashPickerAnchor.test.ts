import { readFileSync } from 'node:fs'
import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeCodeHeadless } from './ClaudeCodeHeadless.js'

// agent-code#1477, on a REAL Claude Code 2.1.296 recording (test/fixtures/
// slash-picker/README.md). While Claude runs a long Bash command, the wrapped
// continuation of its `$ …` line can start with `/` (`     /shots && sleep 30 …`)
// and is painted #999999, the exact colour of an unselected picker row. The old
// parser accepted any coloured `/`-led row anywhere in the viewport, so the
// composer showed that Bash line as a slash command with no picker open, and on
// 2.1.296 it also dropped the real selected row, which starts with `❯`.
//
// Each step waits for an EMITTED 'screen' frame showing that step's own content
// before asserting. The picker is reparsed in the same handler that emits it,
// so the condition snapshot is then current. Waiting on getScreen() is not
// enough: it reads the live grid, which runs ahead of the flushed frame, so a
// "picker hidden" assertion could pass or fail on the previous step's parse.

type Recording = { cols: number; rows: number; steps: Array<{ step: string; chunks: string[] }> }
const load = (name: string): Recording => JSON.parse(readFileSync(
  new URL(`../test/fixtures/slash-picker/${name}`, import.meta.url), 'utf8',
)) as Recording

// Both recordings open the same `/cl` picker, so they share the expectation.
const CL_PICKER = [
  { id: '/clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', selected: true },
  { id: '/claude-api', description: 'Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting…', selected: false },
]

function fakePty(cols: number, rows: number): IPty {
  const disposable = { dispose: vi.fn() }
  return {
    pid: 1, process: 'claude', cols, rows, handleFlowControl: false,
    write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(),
    onData: vi.fn(() => disposable), onExit: vi.fn(() => disposable),
  } as unknown as IPty
}

type Published = Array<{ id: string; description: string; selected: boolean }> | null

// Drives the real ClaudeCodeHeadless with a recording through HeadlessTerminal's
// test write path, exactly as the #1253 suite does.
function harness(recording: Recording) {
  const headless = new ClaudeCodeHeadless({ pty: fakePty(recording.cols, recording.rows), cwd: '/tmp', cols: recording.cols, rows: recording.rows })
  const terminal = (headless as unknown as { terminal: EventEmitter & { writeForTest(data: string): Promise<void> } }).terminal
  const published = (): Published => {
    const condition = (headless.getConditionSnapshot().conditions as Record<string, { state?: { items: Array<{ id: string; description: string; selected: boolean }> } } | undefined>)['claude.slash-picker']
    return condition?.state?.items.map(({ id, description, selected }) => ({ id, description, selected })) ?? null
  }
  let lastFrame = ''
  headless.on('screen', (snap: { plain: string }) => { lastFrame = snap.plain })
  const play = async (step: string, frameShows: (frame: string) => boolean): Promise<void> => {
    for (const chunk of recording.steps.find(entry => entry.step === step)!.chunks) await terminal.writeForTest(chunk)
    await vi.waitFor(() => expect(frameShows(lastFrame)).toBe(true), { timeout: 2000 })
  }
  return { published, play, frame: () => lastFrame }
}

describe('slash picker is anchored to the composer (#1477)', () => {
  it('ignores a wrapped Bash row and reports exactly the real picker', async () => {
    const { published, play, frame } = harness(load('transcript-bash-wrap-2.1.296.json'))

    await play('startup', f => f.includes('Claude Code v2.1.296'))
    await play('prompt', f => f.includes('do not explain'))

    // Bash is running and its wrapped row starts with `/`; no picker is open.
    await play('submit', f => /^\s+\/shots && sleep 30/m.test(f))
    expect(published()).toBeNull()

    // The real picker, opened while the Bash row is still on screen. The
    // descriptions are Claude's full text, joined across its continuation row.
    await play('open-filtered', f => f.includes('/claude-api'))
    expect(frame()).toMatch(/^\s+\/shots && sleep 30/m)
    expect(published()).toEqual(CL_PICKER)

    await play('escape', f => !f.includes('/claude-api'))
    expect(published()).toBeNull()
  })

  // #1293's inline-code case. These rows are painted the SELECTED picker colour,
  // and no indented row follows the last one, so only the "first non-picker
  // row ends the picker" rule stands between them and the composer.
  it('ignores slash-led inline code in a reply and in the prompt echo', async () => {
    const { published, play, frame } = harness(load('reply-inline-code-2.1.296.json'))

    await play('startup', f => f.includes('Claude Code v2.1.296'))
    await play('prompt', f => f.includes('nothing else:'))
    await play('submit', f => f.includes('✻ Baked for'))
    expect(frame()).toMatch(/^\s+\/clear starts over\.\s*$/m)
    expect(published()).toBeNull()

    await play('open-filtered', f => f.includes('/claude-api'))
    expect(published()).toEqual(CL_PICKER)

    await play('escape', f => !f.includes('/claude-api'))
    expect(published()).toBeNull()
  })
})
