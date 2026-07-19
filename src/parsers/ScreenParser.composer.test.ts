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

  it('does not mistake a trust-dialog menu row for a composer draft', async () => {
    // '❯ 1. Yes, I trust this folder' matches the marker regex. Conditions are
    // checked before the composer in derivePromptGateState so this is latent
    // today, but it is the same class of bug and must not regress.
    const term = await paint(
      'Do you trust the files in this folder?', '❯ 1. Yes, I trust this folder',
    )
    expect(term.snapshotComposerAttributes()).toBeNull()
  })
})
