import { describe, expect, it } from 'vitest'

import { parseClaudeComposerState } from './ScreenParser.js'

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
