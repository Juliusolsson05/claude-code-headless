// TrustDialogParser — layout extraction contracts.
//
// The regression these tests fence (agent-code#705): Claude Code 2.1.251
// re-ordered the trust dialog and pre-highlights "No, exit", while the parser
// used to hardcode "Yes first, Yes highlighted". The 2.1.251 screen below is
// the REAL dialog recorded in debug bundle 2026-08-30T23-51-06-471-9bd68e14
// (trace/screen/latest-tail.txt), with only the workspace path swapped for a
// neutral one — layout, indentation, pointer glyph, and footer are verbatim.

import { describe, expect, it } from 'vitest'

import { detectTrustDialog } from './TrustDialogParser.js'

const SCREEN_2_1_251 = [
  '────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' /tmp/fresh-project',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

// The pre-2.1.251 layout: numbered rows, "Yes" first and pre-highlighted
// (the row shape ScreenParser.composer.test.ts has always used).
const SCREEN_LEGACY = [
  ' Accessing workspace:',
  '',
  ' /tmp/legacy-project',
  '',
  ' Quick safety check',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
].join('\n')

describe('detectTrustDialog layout extraction', () => {
  it('reads the 2.1.251 dialog: No first, No highlighted', () => {
    const state = detectTrustDialog(SCREEN_2_1_251)
    expect(state.visible).toBe(true)
    expect(state.workspace).toBe('/tmp/fresh-project')
    expect(state.options).toEqual([
      { key: '1', label: 'No, exit', highlighted: true },
      { key: '2', label: 'Yes, I trust this folder', highlighted: false },
    ])
  })

  it('reads the legacy numbered dialog: Yes first, Yes highlighted', () => {
    const state = detectTrustDialog(SCREEN_LEGACY)
    expect(state.visible).toBe(true)
    expect(state.workspace).toBe('/tmp/legacy-project')
    expect(state.options).toEqual([
      { key: '1', label: 'Yes, I trust this folder', highlighted: true },
      { key: '2', label: 'No, exit', highlighted: false },
    ])
  })

  it('reports no highlight rather than guessing when the pointer is absent', () => {
    // A frame captured mid-repaint can carry the labels without the pointer.
    // The driver must be able to SEE that uncertainty — a defaulted highlight
    // here would reintroduce the exact class of blind Enter this parser change
    // exists to kill.
    const state = detectTrustDialog(SCREEN_2_1_251.replace('❯', ' '))
    expect(state.visible).toBe(true)
    expect(state.options?.every(option => !option.highlighted)).toBe(true)
  })

  it('still treats a post-dialog frame with status markers as not visible', () => {
    const state = detectTrustDialog(`${SCREEN_2_1_251}\n⏵ accept edits`)
    expect(state.visible).toBe(false)
  })
})
