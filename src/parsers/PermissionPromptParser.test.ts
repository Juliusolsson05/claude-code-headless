// PermissionPromptParser — dialog-shape detection contracts.
//
// The regression these tests fence: Claude Code 2.1.263 renders the reject
// option of its Write/Edit/Bash permission dialogs as a bare 'No', and gives
// the file dialogs their own question wording. The parser used to require the
// literal substrings 'Do you want to proceed?' + 'Yes' + 'No, and tell Claude',
// so it reported `visible: false` on live prompts — the SDK never surfaced a
// modal, nobody pressed a key, and the turn hung behind the PTY.
//
// The screens below are reconstructed from the 2.1.263 render tree in
// vendor/claude-code-src (read-only source drop, never imported), not invented:
//   · the top-only round border + bold title + dim subtitle come from
//     PermissionDialog.tsx:62 / PermissionRequestTitle.tsx:23
//   · the question line from FileWritePermissionRequest.tsx:121,
//     FileEditPermissionRequest.tsx:66 and BashPermissionRequest.tsx:464
//   · the `❯ ` pointer column from design-system/ListItem.tsx:127 and the
//     `${i}.`.padEnd(maxIndexWidth + 2) numbering from CustomSelect/select.tsx:575
//   · the option labels verbatim from FilePermissionDialog/permissionOptions.tsx
//     and BashPermissionRequest/bashToolUseOptions.tsx
//   · the 'Esc to cancel · Tab to amend' footer from FilePermissionDialog.tsx:198

import { describe, expect, it } from 'vitest'

import { detectPermissionPrompt } from './PermissionPromptParser.js'

const RULE = '─'.repeat(76)

// Write, 2.1.263. Note the question: 'Do you want to create <basename>?' —
// FileWritePermissionRequest passes its own `question` prop, so the string the
// old parser demanded ('Do you want to proceed?') is nowhere on this screen.
const SCREEN_WRITE_2_1_263 = [
  '⏺ Write(src/lib/tokenBudget.ts)',
  '',
  RULE,
  ' Create file',
  ' src/lib/tokenBudget.ts',
  '',
  '      1 +export const TOKEN_BUDGET = 32_000',
  '',
  ' Do you want to create tokenBudget.ts?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')

// Edit, 2.1.263 — the other file dialog wording.
const SCREEN_EDIT_2_1_263 = [
  '⏺ Update(src/index.ts)',
  '',
  RULE,
  ' Edit file',
  ' src/index.ts',
  '',
  '      12 -export const LIMIT = 10',
  '      12 +export const LIMIT = 25',
  '',
  ' Do you want to make this edit to index.ts?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')

// Bash, 2.1.263. Keeps 'Do you want to proceed?' but the reject row is bare 'No'.
const SCREEN_BASH_2_1_263 = [
  '⏺ Bash(npm test)',
  '  ⎿  Running…',
  '',
  RULE,
  ' Bash command',
  '',
  ' npm test',
  ' Run the unit suite',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test commands in agent-code",
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')

// Bash with always-allow suppressed (shouldShowAlwaysAllowOptions() false, or
// no suggestion was generated): bashToolUseOptions pushes only Yes and No, so
// the reject row is #2. This is the screen that proves the reject option's
// position is not fixed.
const SCREEN_BASH_TWO_OPTIONS = [
  '⏺ Bash(rm -rf build)',
  '',
  RULE,
  ' Bash command',
  '',
  ' rm -rf build',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')

// Pre-2.1.263 layout: the long reject label, which survives today only in the
// Sandbox and WebFetch dialogs. Detection must not have traded one format for
// the other.
const SCREEN_LEGACY = [
  '⏺ Bash(npm test)',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test",
  '   3. No, and tell Claude what to do differently',
].join('\n')

describe('detectPermissionPrompt', () => {
  it('detects the 2.1.263 Write dialog, whose question never says "proceed"', () => {
    const state = detectPermissionPrompt(SCREEN_WRITE_2_1_263)

    expect(state.visible).toBe(true)
    expect(state.title).toBe('Do you want to create tokenBudget.ts?')
    expect(state.toolName).toBe('Write')
    expect(state.command).toBe('src/lib/tokenBudget.ts')
    // Both the bare 'No' and the session-scope label are reported verbatim:
    // consumers label their buttons off this array, so a stale hardcoded list
    // would put the wrong words on the modal.
    expect(state.options).toEqual([
      { key: '1', label: 'Yes' },
      { key: '2', label: 'Yes, allow all edits during this session (shift+tab)' },
      { key: '3', label: 'No' },
    ])
    expect(state.selectedIndex).toBe(0)
  })

  it('detects the 2.1.263 Edit dialog', () => {
    const state = detectPermissionPrompt(SCREEN_EDIT_2_1_263)

    expect(state.visible).toBe(true)
    expect(state.title).toBe('Do you want to make this edit to index.ts?')
    expect(state.toolName).toBe('Update')
    expect(state.options?.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, allow all edits during this session (shift+tab)',
      'No',
    ])
  })

  it('detects the 2.1.263 Bash dialog with its bare "No" reject row', () => {
    const state = detectPermissionPrompt(SCREEN_BASH_2_1_263)

    expect(state.visible).toBe(true)
    expect(state.title).toBe('Do you want to proceed?')
    expect(state.toolName).toBe('Bash')
    // The inline argument wins over the ⎿ tree line beneath it.
    expect(state.command).toBe('npm test')
    expect(state.options?.at(-1)).toEqual({ key: '3', label: 'No' })
    expect(state.selectedIndex).toBe(0)
  })

  it('detects a two-option Bash dialog and reports "No" at key 2, not 3', () => {
    // PERMISSION_PROMPT_DENY_KEYS ('3\r') is wrong for this screen. The parser
    // is not what fixes that — but it must at least tell the truth about which
    // row rejects, so a consumer can stop hardcoding the position.
    const state = detectPermissionPrompt(SCREEN_BASH_TWO_OPTIONS)

    expect(state.visible).toBe(true)
    expect(state.options).toEqual([
      { key: '1', label: 'Yes' },
      { key: '2', label: 'No' },
    ])
  })

  it('still detects the legacy "No, and tell Claude…" layout', () => {
    const state = detectPermissionPrompt(SCREEN_LEGACY)

    expect(state.visible).toBe(true)
    expect(state.title).toBe('Do you want to proceed?')
    expect(state.options?.at(-1)).toEqual({
      key: '3',
      label: 'No, and tell Claude what to do differently',
    })
  })

  it('ignores a busy agent screen whose output merely contains "No" and "Yes"', () => {
    // The bare-'No' relaxation is the dangerous half of this change: 'No' shows
    // up constantly in tool output. A false positive here opens a modal and
    // writes keystrokes into a PTY that is not waiting for them, so none of
    // this may be enough on its own — only a numbered option row below a
    // 'Do you want to …?' line counts.
    const screen = [
      '⏺ Bash(npm test)',
      '  ⎿  > vitest run',
      '     ✓ src/parsers/ScreenParser.test.ts (12 tests)',
      '     ✗ No matching snapshot found for "Yes" branch',
      '     Notice: 3 files changed, 0 insertions',
      '',
      '⏺ The suite is green. No further changes are needed — I will not touch',
      '  the Yes/No handling in the composer.',
      '',
      '✻ Cogitating… (6s · ↓ 1.3k tokens · esc to interrupt)',
    ].join('\n')

    expect(detectPermissionPrompt(screen).visible).toBe(false)
  })

  it('ignores a "Do you want to …?" line with no option rows under it', () => {
    // Claude asking the question in prose is not a dialog. Without the numbered
    // Select rows there is nothing to press, so surfacing a modal would strand
    // the user pressing buttons that go nowhere.
    const screen = [
      '⏺ I can either rewrite the parser or patch the marker list.',
      '  Do you want to proceed?',
      '',
      'Do you want to proceed?',
      '',
      '✻ Cogitating… (2s · esc to interrupt)',
    ].join('\n')

    expect(detectPermissionPrompt(screen).visible).toBe(false)
  })

  it('ignores option rows that sit above the question line', () => {
    // Ordering is evidence: upstream renders <Text>{question}</Text> and then
    // the <Select>. Rows above the question belong to something else (a slash
    // picker, a previous dialog's scrollback).
    const screen = [
      ' ❯ 1. Yes',
      '   2. No',
      '',
      'Do you want to proceed?',
    ].join('\n')

    expect(detectPermissionPrompt(screen).visible).toBe(false)
  })

  it('ignores a Yes/No pair in the wrong order', () => {
    const screen = [
      'Do you want to proceed?',
      ' ❯ 1. No',
      '   2. Yes',
    ].join('\n')

    expect(detectPermissionPrompt(screen).visible).toBe(false)
  })

  it('is not fooled by labels that merely start with the letters No/Yes', () => {
    const screen = [
      'Do you want to proceed?',
      ' ❯ 1. Yesterday’s snapshot',
      '   2. Notebook cell 3',
    ].join('\n')

    expect(detectPermissionPrompt(screen).visible).toBe(false)
  })

  it('returns not-visible for an empty screen', () => {
    expect(detectPermissionPrompt('')).toEqual({ visible: false })
  })
})
