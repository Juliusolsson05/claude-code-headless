import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import { HeadlessTerminal, type ScreenSnapshot } from './HeadlessTerminal.js'

// agent-code#765: a spinner tick must still produce a 'screen' event (the
// spinner is the activity signal) but must not pay for the per-cell markdown
// walks; anything a user can act on must take the full path.

function fakePty(): IPty {
  const disposable = { dispose: vi.fn() }
  return {
    pid: 1,
    process: 'claude',
    cols: 120,
    rows: 40,
    handleFlowControl: false,
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => disposable),
    onExit: vi.fn(() => disposable),
  } as unknown as IPty
}

const RULE = '─'.repeat(60)
const CHROME = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents      /rc connecting…'
const PERMISSION_PROMPT = [
  '⏺ Bash(npm test)',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for npm test",
  '  3. No, and tell Claude what to do differently',
]
const SLASH_PICKER = ['  /help    Show help', '  /clear   Clear conversation history']

type FrameOptions = {
  glyph: string
  secs: number
  tokens: string
  draft?: string
  output?: string[]
  prompt?: boolean
  picker?: boolean
}

function frame(o: FrameOptions): string[] {
  return [
    '> fix the flaky test',
    '',
    ...(o.output ?? []),
    `${o.glyph} Beboppin'… (${o.secs}s · ↓ ${o.tokens} tokens · thinking…)`,
    ...(o.prompt ? PERMISSION_PROMPT : []),
    '',
    RULE,
    `❯ ${o.draft ?? ''}`,
    RULE,
    ...(o.picker ? SLASH_PICKER : []),
    CHROME,
  ]
}

async function paint(term: HeadlessTerminal, lines: string[]): Promise<ScreenSnapshot> {
  const next = new Promise<ScreenSnapshot>(resolve => term.once('screen', resolve))
  // Erase-in-display + home repaints in place the way Claude's synchronized
  // output frames do: every row is rewritten, nothing scrolls into history.
  await term.writeForTest('\x1b[2J\x1b[H' + lines.join('\r\n'))
  return next
}

function terminalWithSpies() {
  const term = new HeadlessTerminal({ pty: fakePty(), snapshotIntervalMs: 5 })
  return {
    term,
    markdownWalk: vi.spyOn(term, 'snapshotMarkdown'),
    recentWalk: vi.spyOn(term, 'snapshotRecentMarkdown'),
  }
}

describe('HeadlessTerminal spinner-only snapshots', () => {
  it.each([
    ['wait 5s', 'wait 6s'],
    ['budget 100 tokens', 'budget 200 tokens'],
    ['/rc connecting…', '/rc'],
    ['paste\r\n✻ Working… (5s)', 'paste\r\n✽ Working… (6s)'],
  ])('rebuilds snapshots for draft edits from %s to %s during a spinner tick', async (before, after) => {
    const { term, markdownWalk } = terminalWithSpies()
    await paint(term, frame({ glyph: '✻', secs: 5, tokens: '1.2k', draft: before }))
    const changed = await paint(term, frame({ glyph: '✽', secs: 6, tokens: '1.3k', draft: after }))
    expect(changed.spinnerOnly).toBe(false)
    expect(markdownWalk).toHaveBeenCalledTimes(2)
  })
  it('emits a spinner tick as spinnerOnly with the raw text but without re-walking cells', async () => {
    const { term, markdownWalk, recentWalk } = terminalWithSpies()

    const first = await paint(term, frame({ glyph: '✻', secs: 5, tokens: '1.2k' }))
    expect(first.spinnerOnly).toBe(false)
    expect(markdownWalk).toHaveBeenCalledTimes(1)
    expect(recentWalk).toHaveBeenCalledTimes(1)

    const tick = await paint(term, frame({ glyph: '✽', secs: 6, tokens: '1.3k' }))
    expect(tick.spinnerOnly).toBe(true)
    // Consumers still see the live spinner: the raw text moved on…
    expect(tick.plain).not.toBe(first.plain)
    expect(tick.plain).toContain("✽ Beboppin'… (6s · ↓ 1.3k tokens")
    // …while the derived strings were reused instead of rebuilt.
    expect(tick.markdown).toBe(first.markdown)
    expect(tick.recentMarkdown).toBe(first.recentMarkdown)
    expect(markdownWalk).toHaveBeenCalledTimes(1)
    expect(recentWalk).toHaveBeenCalledTimes(1)

    const tickAgain = await paint(term, frame({ glyph: '✶', secs: 7, tokens: '1.3k' }))
    expect(tickAgain.spinnerOnly).toBe(true)
    expect(markdownWalk).toHaveBeenCalledTimes(1)
  })

  it.each<[string, FrameOptions, string]>([
    ['a permission prompt appearing', { glyph: '✽', secs: 6, tokens: '1.3k', prompt: true }, 'Do you want to proceed?'],
    ['a composer keystroke', { glyph: '✽', secs: 6, tokens: '1.3k', draft: 'g' }, '❯ g'],
    ['a new output line', { glyph: '✽', secs: 6, tokens: '1.3k', output: ['⏺ Read(README.md)'] }, '⏺ Read(README.md)'],
    ['a slash picker opening', { glyph: '✽', secs: 6, tokens: '1.3k', draft: '/', picker: true }, '/clear'],
  ])('treats %s as a real change even when the spinner ticks in the same frame', async (_label, next, marker) => {
    const { term, markdownWalk, recentWalk } = terminalWithSpies()
    await paint(term, frame({ glyph: '✻', secs: 5, tokens: '1.2k' }))

    const changed = await paint(term, frame(next))
    expect(changed.spinnerOnly).toBe(false)
    expect(changed.markdown).toContain(marker)
    expect(markdownWalk).toHaveBeenCalledTimes(2)
    expect(recentWalk).toHaveBeenCalledTimes(2)

    // The tick after a real change is spinner-only against the NEW frame.
    const tick = await paint(term, frame({ ...next, glyph: '✶', secs: 7 }))
    expect(tick.spinnerOnly).toBe(true)
    expect(tick.markdown).toBe(changed.markdown)
    expect(markdownWalk).toHaveBeenCalledTimes(2)
  })

  it('treats the spinner verb changing and the spinner finishing as real changes', async () => {
    const { term, markdownWalk } = terminalWithSpies()
    await paint(term, frame({ glyph: '✻', secs: 5, tokens: '1.2k' }))

    const verb = await paint(term, [
      '> fix the flaky test',
      '',
      '✽ Ionizing… (6s · ↓ 1.3k tokens · thinking…)',
      '',
      RULE, '❯ ', RULE, CHROME,
    ])
    expect(verb.spinnerOnly).toBe(false)
    expect(markdownWalk).toHaveBeenCalledTimes(2)

    const done = await paint(term, [
      '> fix the flaky test',
      '',
      '✻ Cogitated for 7s · done 2:03 PM',
      '',
      RULE, '❯ ', RULE, CHROME,
    ])
    expect(done.spinnerOnly).toBe(false)
    expect(markdownWalk).toHaveBeenCalledTimes(3)
  })
})

describe('HeadlessTerminal scrollback cap', () => {
  it('retains at most 2000 scrollback rows while snapshotRecent still sees its full window', async () => {
    const rows = 24
    const term = new HeadlessTerminal({ pty: fakePty(), rows, snapshotIntervalMs: 5 })
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    await term.writeForTest(lines.join('\r\n'))

    // xterm bounds the buffer at rows + scrollback; 10000 would keep all 3000.
    expect(term.getTerminal().buffer.active.length).toBeLessThanOrEqual(rows + 2000)

    const recent = term.snapshotRecent().split('\n')
    expect(recent).toHaveLength(200)
    expect(recent[0]).toBe('line 2800')
    expect(recent[recent.length - 1]).toBe('line 2999')
  })
})
