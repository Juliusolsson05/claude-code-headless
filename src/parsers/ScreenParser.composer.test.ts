import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import { HeadlessTerminal } from '../terminal/HeadlessTerminal.js'
import { parseClaudeComposerState, type ComposerAttributes } from './ScreenParser.js'

const RULE = '─'.repeat(40)
const NARROW_RULE = '─'.repeat(30)
const box = (composerRow: string): string => [RULE, composerRow, RULE].join('\n')

// Real SGR sequences, matching what chalk emits upstream: chalk.dim -> SGR 2,
// chalk.inverse -> SGR 7. Writing genuine escape codes (rather than asserting
// on a hand-built descriptor) is the point of these cases — they prove the cell
// walk reads what a terminal actually paints.
const DIM = (s: string): string => `\x1b[2m${s}\x1b[22m`
const INV = (s: string): string => `\x1b[7m${s}\x1b[27m`

function fakePty(): IPty {
  const disposable = { dispose: vi.fn() }
  return {
    pid: 1, process: 'claude', cols: 80, rows: 12, handleFlowControl: false,
    write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(),
    resume: vi.fn(), kill: vi.fn(),
    onData: vi.fn(() => disposable), onExit: vi.fn(() => disposable),
  } as unknown as IPty
}

async function paint(...rows: string[]): Promise<HeadlessTerminal> {
  const term = new HeadlessTerminal({ pty: fakePty(), cols: 80, rows: 12 })
  // \r\n so xterm advances lines exactly as it would for PTY output.
  await term.writeForTest(rows.join('\r\n'))
  return term
}

describe('parseClaudeComposerState', () => {
  it.each([
    '❯',
    '>',
    '❯ Press up to edit',
    ['> Press up to edit', 'shift+tab to cycle'].join('\n'),
    ['old user output', '────────────────────', '> Press up to edit', '────────────────────'].join('\n'),
  ])('recognizes captured and compatible empty composer shapes', screen => {
    expect(parseClaudeComposerState(screen)).toBe('empty')
  })

  it.each([
    '❯ fix the bug',
    '> human draft',
    ['────────────────────', '❯ first line', 'second line', '────────────────────'].join('\n'),
    '❯ a future unknown provider hint',
  ])('fails closed for text that could be a human draft', screen => {
    expect(parseClaudeComposerState(screen)).toBe('drafted')
  })

  it('does not promote an old scrollback prompt when no active composer is painted', () => {
    const screen = ['❯ old prompt', ...Array.from({ length: 12 }, (_, i) => `startup ${i}`)].join('\n')
    expect(parseClaudeComposerState(screen)).toBe('unpainted')
  })

  it('uses the first marker inside the final composer box', () => {
    const screen = [
      '❯ old prompt',
      '────────────────────',
      '❯ human draft',
      '❯ quoted text',
      '────────────────────',
    ].join('\n')
    expect(parseClaudeComposerState(screen)).toBe('drafted')
  })
})

describe('parseClaudeComposerState with cell attributes', () => {
  // WHY these cases exist: upstream renders EVERY composer placeholder through
  // chalk.dim, and only when the composer value is empty
  // (vendor/claude-code-src/full/hooks/renderPlaceholder.ts:33-45). So dim
  // content is positive proof of emptiness no matter what the words say. Each
  // string below is real text a live Claude 2.1.215 painted into an EMPTY
  // composer — the last two are unbounded by construction (generated from the
  // user's git history, and model-authored prose), which is exactly why the
  // string allowlist this replaces could never be completed.
  it.each([
    'Press up to edit queued messages',
    'now count backwards from 30 to 1',
    'Message @some-teammate…',
    'write a test for parseClaudeComposerState',
  ])('treats fully dim composer text as empty: %s', text => {
    const attrs: ComposerAttributes = { dim: text.length, inverse: 0, plain: 0 }
    expect(parseClaudeComposerState(box(`❯ ${text}`), attrs)).toBe('empty')
  })

  it('treats the focused placeholder (inverted first char) as empty', () => {
    // Focused composer renders invert(placeholder[0]) + chalk.dim(rest), so the
    // cursor cell must not be mistaken for human-owned text.
    const attrs: ComposerAttributes = { dim: 31, inverse: 1, plain: 0 }
    expect(parseClaudeComposerState(box('❯ now count backwards from 30 to 1'), attrs))
      .toBe('empty')
  })

  it('treats any non-dim content cell as a human draft', () => {
    const attrs: ComposerAttributes = { dim: 0, inverse: 0, plain: 26 }
    expect(parseClaudeComposerState(box('❯ this is a real human draft'), attrs))
      .toBe('drafted')
  })

  it('treats a human draft with the cursor mid-text as a draft', () => {
    const attrs: ComposerAttributes = { dim: 0, inverse: 1, plain: 25 }
    expect(parseClaudeComposerState(box('❯ this is a real human draft'), attrs))
      .toBe('drafted')
  })

  it('treats a bare marker with no content cells as empty', () => {
    const attrs: ComposerAttributes = { dim: 0, inverse: 0, plain: 0 }
    expect(parseClaudeComposerState(box('❯ '), attrs)).toBe('empty')
  })

  it('returns unpainted when no composer row exists, even with attributes', () => {
    // Attributes describing a row we never located prove nothing, so the
    // marker search still decides whether a composer exists at all.
    const attrs: ComposerAttributes = { dim: 5, inverse: 0, plain: 0 }
    expect(parseClaudeComposerState('', attrs)).toBe('unpainted')
  })

  it('falls back to string classification when attributes are absent', () => {
    // Callers with no terminal access (replayed recordings, existing fixtures)
    // must keep the old behaviour rather than crash or silently flip.
    expect(parseClaudeComposerState(box('❯ this is a real human draft'))).toBe('drafted')
    expect(parseClaudeComposerState(box('❯ Press up to edit'))).toBe('empty')
  })

  it('does not treat a null descriptor as an all-dim composer', () => {
    expect(parseClaudeComposerState(box('❯ this is a real human draft'), null))
      .toBe('drafted')
  })

  it('recognizes the queued-messages hint through the string fallback', () => {
    // Defense in depth: this exact string is proven provider chrome from a
    // captured screen, and the fallback path is what replayed recordings take.
    expect(parseClaudeComposerState(box('❯ Press up to edit queued messages')))
      .toBe('empty')
  })
})

describe('HeadlessTerminal.snapshotComposerAttributes', () => {
  it('counts a dim placeholder as dim content with no plain cells', async () => {
    const term = await paint(RULE, `❯ ${DIM('Press up to edit queued messages')}`, RULE)
    const attrs = term.snapshotComposerAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!.plain).toBe(0)
    expect(attrs!.dim).toBeGreaterThan(0)
  })

  it('counts a focused placeholder as inverse-first plus dim remainder', async () => {
    const term = await paint(
      RULE, `❯ ${INV('n')}${DIM('ow count backwards from 30 to 1')}`, RULE,
    )
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBe(0)
    expect(attrs.inverse).toBe(1)
    expect(attrs.dim).toBeGreaterThan(0)
  })

  it('counts typed text as plain content', async () => {
    const term = await paint(RULE, '❯ this is a real human draft', RULE)
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBeGreaterThan(0)
    expect(attrs.dim).toBe(0)
  })

  it('returns null when no composer row is painted', async () => {
    const term = await paint('just some output', 'no composer here')
    expect(term.snapshotComposerAttributes()).toBeNull()
  })

  it('does not count the marker glyph itself as content', async () => {
    const term = await paint(RULE, '❯ ', RULE)
    expect(term.snapshotComposerAttributes()).toEqual({ dim: 0, inverse: 0, plain: 0 })
  })
})

describe('composer attribute edge cases', () => {
  it('classifies a wrapped dim placeholder as empty', async () => {
    // Long suggestions wrap past the marker row, and only the marker row is
    // sampled. Assert the wrapped case explicitly rather than assuming the
    // first row alone carries the verdict.
    const long = 'go, full attribute reader and include the recording change'
    const term = await paint(NARROW_RULE, `❯ ${DIM(long)}`, NARROW_RULE)
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBe(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('empty')
  })

  it('classifies the pasted-content marker as a human draft', async () => {
    // "[Pasted text #1 +5 lines]" is Claude's own chrome, but it stands in for
    // content the human actually pasted, so it MUST stay 'drafted'. It renders
    // non-dim, so the attribute path gets this right for free — lock it in.
    const term = await paint(RULE, '❯ [Pasted text #1 +5 lines]', RULE)
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBeGreaterThan(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('drafted')
  })

  it('reads a trust-dialog menu row as real content, not a placeholder', async () => {
    // '❯ 1. Yes, I trust this folder' matches the marker regex. An earlier
    // version of this test asserted the attributes were null and passed only
    // because the fixture had no divider — it would have passed for ANY
    // two-line screen, proving nothing about trust rows. Paint the divider so
    // the composer search actually succeeds, then assert the real property:
    // menu text is undimmed, so it must never be mistaken for a placeholder.
    const term = await paint(RULE, '❯ 1. Yes, I trust this folder', RULE)
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBeGreaterThan(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('drafted')
  })

  it('classifies a draft whose first line is empty as drafted', async () => {
    // Regression: the attribute descriptor samples ONLY the marker row, so a
    // draft written after shift+enter — or pasted starting with a newline —
    // leaves the marker row empty and every typed character on a continuation
    // row. Reading attrs.plain alone returned 'empty' and would let an agent
    // type over a half-written human message. Strictly worse than the
    // false-'drafted' bug, because that one only blocked delivery.
    const term = await paint(RULE, '❯ ', '  this is a real human draft', RULE)
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.plain).toBe(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('drafted')
  })

  it('extracts attributes from a composer painted without a divider box', async () => {
    // Older Claude layouts omit the upper rule. If only ScreenParser handles
    // that, the two marker searches disagree: it finds a composer, the terminal
    // returns null, and classification silently drops to the known-incomplete
    // allowlist — the original bug, intact, on exactly those layouts.
    const term = await paint('some earlier output', `❯ ${DIM('a suggestion nobody allowlisted')}`)
    const attrs = term.snapshotComposerAttributes()
    expect(attrs).not.toBeNull()
    expect(attrs!.plain).toBe(0)
    expect(attrs!.dim).toBeGreaterThan(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('empty')
  })

  it('counts wide CJK and emoji drafts without double-counting cells', async () => {
    // Depends on xterm representing a wide glyph's trailing half as an empty
    // cell, which the blank-cell skip relies on. Pin it: a silent change here
    // would inflate `plain` and could not be caught anywhere else.
    const term = await paint(RULE, '❯ 修复这个错误 🚀', RULE)
    const attrs = term.snapshotComposerAttributes()!
    expect(attrs.dim).toBe(0)
    expect(attrs.plain).toBeGreaterThan(0)
    expect(parseClaudeComposerState(term.snapshotPlain(), attrs)).toBe('drafted')
  })
})
