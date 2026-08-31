// claude-code-headless / conditions / trustDialog.ts
//
// The `claude.trust-dialog` condition module. Detects Claude Code's "Quick
// safety check" trust dialog and exposes the two actions the UI may dispatch to
// resolve it.
//
// WHY THIS MODULE EXISTS — IT RESTORES A DEAD MODAL.
// -------------------------------------------------
// Until the conditions-snapshot PR, ClaudeCodeHeadless emitted NO conditions
// snapshot, so the renderer's `onSessionConditions` path never fired for Claude
// and `applyConditionSnapshot`'s Claude branch was dead code. The
// TrustDialogModal (already built in PR-1, wired into CLAUDE_VIEWS) therefore
// never rendered from the snapshot. This module — together with
// publishConditionSnapshot in ClaudeCodeHeadless — makes Claude emit
// `claude.trust-dialog` so that modal lights up.
//
// WHY ACCEPT IS A `custom` ACTION, NOT A KEYSTROKE (agent-code#705).
// -----------------------------------------------------------------
// Accept used to be the pty action '\r', mirroring TrustDialogModal, on the
// assumption CC pre-highlights "Yes, I trust this folder". Claude Code 2.1.251
// re-ordered the dialog and pre-highlights "No, exit", so that Enter confirmed
// the exit option and terminated the CLI. No single keystroke can be correct
// across layouts, so accept now routes through the trust-dialog driver
// (trustDialogDriver.ts), which reads the live highlight, walks it onto the
// affirmative row with verified arrow presses, and only then confirms —
// failing closed when the screen cannot prove the layout.
//
// Decline stays a pty action: the dialog itself states "Esc to cancel" and
// upstream maps cancel to exit (TrustDialog's Select onCancel → "exit"), and
// unlike Enter, Escape's meaning does not depend on which row is highlighted.
// The old decline keystroke '2\r' (numbered-list selection) died with the
// numbered layout.

import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type {
  ClaudeConditionInputs,
  ClaudeTrustDialogCondition,
} from './types.js'
import type { TrustDialogState } from '../parsers/TrustDialogParser.js'
import {
  TRUST_DIALOG_ACCEPT_LABEL,
  TRUST_DIALOG_DECLINE_LABEL,
} from '../parsers/TrustDialogParser.js'
import {
  driveTrustDialogAccept,
  type TrustDialogResolveCtx,
} from './trustDialogDriver.js'

// The resolver name is the wire contract between the renderer (which dispatches
// the custom action through session:resolveCondition) and this module's
// `resolve` claim below. Exported so agent-code's TrustDialogModal and this
// module cannot drift apart on a string literal.
export const TRUST_DIALOG_ACCEPT_RESOLVER = 'claude.trust-dialog.accept'

// The action TEMPLATE — DATA ONLY. `actions()` clones this into a fresh array of
// fresh objects on every call (see the module below). This mirrors codex's
// TRUST_DIALOG_ACTIONS pattern exactly. The ids/labels here are the wire
// contract; nothing in this literal changes without a matching change in
// TrustDialogModal.tsx.
//
// `readonly` marks the template as not-for-mutation; the per-call clone is what
// callers receive and may freely own.
const TRUST_DIALOG_ACTIONS: readonly ConditionAction[] = [
  {
    kind: 'custom',
    id: 'accept',
    label: TRUST_DIALOG_ACCEPT_LABEL,
    name: TRUST_DIALOG_ACCEPT_RESOLVER,
  },
  { kind: 'pty', id: 'decline', label: TRUST_DIALOG_DECLINE_LABEL, data: '\x1b' },
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
  TrustDialogState,
  TrustDialogResolveCtx
>({
  kind: 'claude.trust-dialog',
  detect: (inputs) =>
    inputs.trustDialog.visible ? inputs.trustDialog : null,
  // Fresh array of fresh objects per call. The conditions-core isolation
  // contract (verified out-of-band, see modules.ts) requires that a consumer
  // mutating a returned `actions[0]` cannot poison the next evaluation. `{ ...a }`
  // is a sufficient clone because every ConditionAction field is a primitive.
  actions: () => TRUST_DIALOG_ACTIONS.map((a) => ({ ...a })),
  // Returning `undefined` for foreign names keeps `name` as the routing key —
  // the evaluator tries each module's resolver in turn (see core/evaluator.ts).
  resolve: (action, ctx) =>
    action.name === TRUST_DIALOG_ACCEPT_RESOLVER
      ? driveTrustDialogAccept(ctx)
      : undefined,
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
    askUserQuestion: null,
    slashPicker: { visible: false, items: [] },
  })
  if (detected === null) return null
  return {
    kind: 'claude.trust-dialog',
    state: detected,
    actions: trustDialogModule.actions(detected),
  }
}
