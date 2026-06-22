// claude-code-headless / conditions / slashPicker.ts
//
// Slash-command picker condition module.
//
// WHY this module exists:
//   The slash picker was the last Claude overlay still riding a bespoke
//   per-event path (`slash-picker` + sticky `runtime.picker`) while trust,
//   permission, resume, compaction, and AskUserQuestion had moved onto the
//   unified conditions snapshot. That split is exactly the maintenance debt the
//   conditions framework is meant to remove: every overlay should be one parser
//   + one module + one snapshot relay. This module makes slash picker presence a
//   normal deduped condition while preserving the parser's cell-color logic.

import { defineModule } from './core/contract.js'
import type {
  ClaudeConditionInputs,
  ClaudeSlashPickerCondition,
} from './types.js'
import type { SlashPickerState } from '../parsers/SlashPickerParser.js'

export const slashPickerModule = defineModule<
  'claude.slash-picker',
  ClaudeConditionInputs,
  SlashPickerState
>({
  kind: 'claude.slash-picker',
  detect: (inputs) => inputs.slashPicker.visible ? inputs.slashPicker : null,
  // The slash picker is controlled by the composer keybindings, not by modal
  // buttons. It still belongs in the conditions snapshot for liveness and
  // selected-row state, but there is no condition action to dispatch here.
  actions: () => [],
})

export function buildClaudeSlashPickerCondition(
  state: SlashPickerState,
): ClaudeSlashPickerCondition | null {
  const detected = slashPickerModule.detect({
    trustDialog: { visible: false },
    permissionPrompt: { visible: false },
    resumePrompt: { visible: false },
    compaction: { visible: false },
    askUserQuestion: null,
    slashPicker: state,
  })
  if (detected === null) return null
  return {
    kind: 'claude.slash-picker',
    state: detected,
    actions: slashPickerModule.actions(detected),
  }
}
