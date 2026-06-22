// claude-code-headless / conditions / permissionPrompt.ts
//
// The `claude.permission-prompt` condition module. Detects Claude Code's
// "Do you want to proceed?" tool-permission overlay and exposes the approve/deny
// keystroke actions.
//
// WHY THIS MODULE EXISTS — IT RESTORES A DEAD MODAL (see trustDialog.ts header
// for the full "Claude emitted no snapshot, so the modal never rendered" story).
//
// THE KEYSTROKES ARE THE CONTRACT WITH THE TUI — sourced from the modal itself.
// PermissionPromptModal.tsx resolves the prompt by sending exactly:
//   approve → '\r'   (Enter confirms the highlighted "Yes")
//   deny    → '3\r'  (selects option 3, "No, and tell Claude…")
// These agree with the parser's PERMISSION_PROMPT_APPROVE_KEYS ('\r') /
// PERMISSION_PROMPT_DENY_KEYS ('3\r') and the legacy per-event `permission_prompt`
// emission's approve()/deny() closures. All three must stay in lockstep.

import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type {
  ClaudeConditionInputs,
  ClaudePermissionPromptCondition,
} from './types.js'
import type { PermissionPromptState } from '../parsers/PermissionPromptParser.js'

// Action TEMPLATE — DATA ONLY; cloned fresh per call (see codex's
// APPROVAL_ACTIONS pattern + the isolation note in trustDialog.ts). The exact
// ids/labels/keystrokes are the wire contract with PermissionPromptModal.tsx.
const PERMISSION_PROMPT_ACTIONS: readonly ConditionAction[] = [
  { kind: 'pty', id: 'approve', label: 'Yes', data: '\r' },
  {
    kind: 'pty',
    id: 'deny',
    label: 'No, and tell Claude what to do differently',
    data: '3\r',
  },
]

// permissionPromptModule — headless-module form of the permission condition.
//
// `detect` returns `inputs.permissionPrompt` verbatim when visible, else null —
// the same state object the screen-tick handler stored, keeping the serialized
// `state` identical to the legacy per-event emission.
export const permissionPromptModule = defineModule<
  'claude.permission-prompt',
  ClaudeConditionInputs,
  PermissionPromptState
>({
  kind: 'claude.permission-prompt',
  detect: (inputs) =>
    inputs.permissionPrompt.visible ? inputs.permissionPrompt : null,
  // Fresh objects per call — isolation contract (see trustDialog.ts).
  actions: () => PERMISSION_PROMPT_ACTIONS.map((a) => ({ ...a })),
})

export function buildClaudePermissionPromptCondition(
  state: PermissionPromptState,
): ClaudePermissionPromptCondition | null {
  const detected = permissionPromptModule.detect({
    trustDialog: { visible: false },
    permissionPrompt: state,
    resumePrompt: { visible: false },
    compaction: { visible: false },
    askUserQuestion: null,
  })
  if (detected === null) return null
  return {
    kind: 'claude.permission-prompt',
    state: detected,
    actions: permissionPromptModule.actions(detected),
  }
}
