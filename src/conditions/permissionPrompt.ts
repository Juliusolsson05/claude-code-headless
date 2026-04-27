import {
  PERMISSION_PROMPT_APPROVE_KEYS,
  PERMISSION_PROMPT_DENY_KEYS,
  type PermissionPromptState,
} from '../parsers/PermissionPromptParser.js'
import type { ClaudePermissionPromptCondition } from './types.js'

export function buildClaudePermissionPromptCondition(
  state: PermissionPromptState,
): ClaudePermissionPromptCondition | null {
  if (!state.visible) return null
  return {
    kind: 'claude.permission-prompt',
    state,
    actions: [
      { kind: 'pty', id: 'approve', label: 'Approve', data: PERMISSION_PROMPT_APPROVE_KEYS },
      { kind: 'pty', id: 'deny', label: 'Deny', data: PERMISSION_PROMPT_DENY_KEYS },
    ],
  }
}
