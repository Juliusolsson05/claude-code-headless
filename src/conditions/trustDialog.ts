// claude-code-headless / conditions / trustDialog.ts
//
// The `claude.trust-dialog` condition module. Detects Claude Code's "Quick
// safety check" trust dialog and exposes the two keystroke actions the UI may
// dispatch to resolve it.
//
// WHY THIS MODULE EXISTS — IT RESTORES A DEAD MODAL.
// -------------------------------------------------
// Until this PR, ClaudeCodeHeadless emitted NO conditions snapshot, so the
// renderer's `onSessionConditions` path never fired for Claude and
// `applyConditionSnapshot`'s Claude branch was dead code. The TrustDialogModal
// (already built in PR-1, wired into CLAUDE_VIEWS) therefore never rendered from
// the snapshot. This module — together with publishConditionSnapshot in
// ClaudeCodeHeadless — makes Claude emit `claude.trust-dialog` so that modal
// finally lights up.
//
// THE KEYSTROKES ARE THE CONTRACT WITH THE TUI — sourced from the modal itself.
// TrustDialogModal.tsx resolves the dialog by sending exactly:
//   accept  → '\r'   (Enter confirms the pre-highlighted "Yes, I trust" option)
//   decline → '\x1b' (ESC dismisses)
// We mirror those two strings verbatim. If TrustDialogModal's keystrokes ever
// change, these must change with them — they are the same bytes written to the
// PTY whether the user clicks the native modal button or dispatches the
// condition action. (Note the accept keystroke is ALSO '\r' in the parser's
// TRUST_DIALOG_ACCEPT_KEYS, so all three agree.)

import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type {
  ClaudeConditionInputs,
  ClaudeTrustDialogCondition,
} from './types.js'
import type { TrustDialogState } from '../parsers/TrustDialogParser.js'

// The action TEMPLATE — DATA ONLY. `actions()` clones this into a fresh array of
// fresh objects on every call (see the module below). This mirrors codex's
// TRUST_DIALOG_ACTIONS pattern exactly. The ids/labels/keystrokes here are the
// wire contract; nothing in this literal changes without a matching change in
// TrustDialogModal.tsx.
//
// `readonly` marks the template as not-for-mutation; the per-call clone is what
// callers receive and may freely own.
const TRUST_DIALOG_ACTIONS: readonly ConditionAction[] = [
  { kind: 'pty', id: 'accept', label: 'Yes, I trust this folder', data: '\r' },
  { kind: 'pty', id: 'decline', label: 'No, exit', data: '\x1b' },
]

// trustDialogModule — headless-module form of the trust-dialog condition.
//
// `detect` reads `inputs.trustDialog` and returns it VERBATIM when visible, else
// null. Returning the same state object the screen-tick handler stored (not a
// copy) keeps the serialized `state` identical to what the legacy per-event
// `trust-dialog` emission carries — both surface the exact parser output.
export const trustDialogModule = defineModule<
  'claude.trust-dialog',
  ClaudeConditionInputs,
  TrustDialogState
>({
  kind: 'claude.trust-dialog',
  detect: (inputs) =>
    inputs.trustDialog.visible ? inputs.trustDialog : null,
  // Fresh array of fresh objects per call. The conditions-core isolation
  // contract (verified out-of-band, see modules.ts) requires that a consumer
  // mutating a returned `actions[0]` cannot poison the next evaluation. `{ ...a }`
  // is a sufficient clone because every ConditionAction field is a primitive.
  actions: () => TRUST_DIALOG_ACTIONS.map((a) => ({ ...a })),
})

// Convenience builder mirroring codex's `buildCodex*Condition` helpers, for any
// caller that has a bare state and wants the typed record. Not on a hot path;
// present for symmetry and so external importers have the same affordance codex
// exposes.
export function buildClaudeTrustDialogCondition(
  state: TrustDialogState,
): ClaudeTrustDialogCondition | null {
  const detected = trustDialogModule.detect({
    trustDialog: state,
    permissionPrompt: { visible: false },
    resumePrompt: { visible: false },
    compaction: { visible: false },
  })
  if (detected === null) return null
  return {
    kind: 'claude.trust-dialog',
    state: detected,
    actions: trustDialogModule.actions(detected),
  }
}
