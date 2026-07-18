import { describe, expect, it } from 'vitest'

import { shouldFilterSuggestion } from './suggestionFilter.js'

describe('shouldFilterSuggestion', () => {
  it('keeps short actionable suggestions and commands', () => {
    expect(shouldFilterSuggestion('run the tests')).toBe(false)
    expect(shouldFilterSuggestion('commit this')).toBe(false)
    expect(shouldFilterSuggestion('yes')).toBe(false)
    expect(shouldFilterSuggestion('/compact')).toBe(false)
  })

  it('drops empty, meta, and silence responses', () => {
    expect(shouldFilterSuggestion('')).toBe(true)
    expect(shouldFilterSuggestion('   ')).toBe(true)
    expect(shouldFilterSuggestion(null)).toBe(true)
    expect(shouldFilterSuggestion('silence')).toBe(true)
    expect(shouldFilterSuggestion('(silence — nothing obvious)')).toBe(true)
    expect(shouldFilterSuggestion('no suggestion')).toBe(true)
  })

  it('drops evaluative, assistant-voice, formatted, and over-long responses', () => {
    expect(shouldFilterSuggestion('looks good')).toBe(true)
    expect(shouldFilterSuggestion('Let me run the tests')).toBe(true)
    expect(shouldFilterSuggestion('do this.\nThen that')).toBe(true)
    expect(shouldFilterSuggestion('a '.repeat(60))).toBe(true)
    expect(shouldFilterSuggestion('x'.repeat(120))).toBe(true)
  })
})
