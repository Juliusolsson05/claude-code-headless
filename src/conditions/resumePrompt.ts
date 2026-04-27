import type { ResumePromptState } from '../parsers/ResumePromptParser.js'
import type { ClaudeResumePromptCondition } from './types.js'

export function buildClaudeResumePromptCondition(
  state: ResumePromptState,
): ClaudeResumePromptCondition | null {
  if (!state.visible) return null
  return {
    kind: 'claude.resume-prompt',
    state,
    actions: [
      { kind: 'pty', id: 'confirm', label: 'Confirm', data: '\r' },
      { kind: 'pty', id: 'cancel', label: 'Cancel', data: '\x1b' },
    ],
  }
}
