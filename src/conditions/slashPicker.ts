import type { SlashPickerState } from '../parsers/SlashPickerParser.js'
import type { ClaudeSlashPickerCondition } from './types.js'

export function buildClaudeSlashPickerCondition(
  state: SlashPickerState,
): ClaudeSlashPickerCondition | null {
  if (!state.visible) return null
  return {
    kind: 'claude.slash-picker',
    state,
    actions: [
      { kind: 'pty', id: 'confirm', label: 'Confirm', data: '\r' },
      { kind: 'pty', id: 'cancel', label: 'Cancel', data: '\x1b' },
    ],
  }
}
