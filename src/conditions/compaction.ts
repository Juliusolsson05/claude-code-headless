// claude-code-headless / conditions / compaction.ts
//
// The `claude.compaction` condition module. Detects Claude Code's compaction UI
// (running / error / done) and exposes NO actions — it is a read-only status
// strip.
//
// WHY THIS MODULE EXISTS — IT RESTORES A DEAD STRIP (see trustDialog.ts header
// for the full "Claude emitted no snapshot" story; the compaction strip is the
// status-only member of that same dead set).
//
// WHY `actions` IS EMPTY.
// -----------------------
// Compaction is not an interactive prompt — there is no choice to make. The
// renderer's compaction view (CompactionStrip in CLAUDE_VIEWS) renders phase /
// status text only; it dispatches nothing. So this module returns `[]`. We do
// NOT invent a "dismiss"/"cancel" keystroke: Claude's compaction has no such
// affordance in the TUI, and a fabricated action would be a keystroke the
// terminal would misinterpret. An empty array is the honest, correct surface.
// (Returning a fresh `[]` per call is still required by the isolation contract —
// see below.)

import { defineModule } from './core/contract.js'
import type {
  ClaudeConditionInputs,
  ClaudeCompactionCondition,
} from './types.js'
import type { CompactionState } from '../parsers/CompactionParser.js'

// compactionModule — headless-module form of the compaction condition.
//
// `detect` returns `inputs.compaction` verbatim when visible, else null. The
// state carries `phase` / `statusText` / `errorText` which the strip renders.
export const compactionModule = defineModule<
  'claude.compaction',
  ClaudeConditionInputs,
  CompactionState
>({
  kind: 'claude.compaction',
  detect: (inputs) =>
    inputs.compaction.visible ? inputs.compaction : null,
  // A FRESH empty array per call. Even though there are no action objects to
  // clone, returning a brand-new `[]` each time (rather than one shared
  // module-level empty array) preserves the isolation invariant uniformly: a
  // consumer that does `actions.push(...)` on a returned array must not affect
  // the next evaluation. Cheap, and keeps every module's `actions()` honest
  // about ownership.
  actions: () => [],
})

export function buildClaudeCompactionCondition(
  state: CompactionState,
): ClaudeCompactionCondition | null {
  const detected = compactionModule.detect({
    trustDialog: { visible: false },
    permissionPrompt: { visible: false },
    resumePrompt: { visible: false },
    compaction: state,
    askUserQuestion: null,
  })
  if (detected === null) return null
  return {
    kind: 'claude.compaction',
    state: detected,
    actions: compactionModule.actions(detected),
  }
}
