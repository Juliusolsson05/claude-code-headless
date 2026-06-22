// claude-code-headless / conditions / modules.ts
//
// CLAUDE_MODULES — the ordered registry the generic evaluator loops over to
// build a `claude` conditions snapshot. Mirrors codex-headless's CODEX_MODULES.
//
// ORDER IS A WIRE CONTRACT, NOT A STYLE CHOICE.
// ---------------------------------------------
// The evaluator inserts each LIVE module's record into a plain object in THIS
// array's order, and the dedupe key is `JSON.stringify(conditions)`, which
// serializes object keys in insertion order. So two snapshots with the same
// records inserted in a different order produce DIFFERENT keys and would be
// treated as a spurious change by the dedupe latch. The order below is therefore
// frozen and observable.
//
// WHY THIS PARTICULAR ORDER (trust → permission → resume → compaction).
// --------------------------------------------------------------------
// There is no legacy snapshot to stay byte-compatible with here (Claude never
// emitted one before — that's the whole point of this PR), so we are free to
// CHOOSE the order. We pick a STABLE, INTENTIONAL one and document it:
//   1. trust-dialog      — the earliest-in-lifecycle modal (shown at session
//                          start before anything else can happen).
//   2. permission-prompt — the most frequent mid-session interactive modal.
//   3. resume-prompt     — the resume-time interactive modal.
//   4. compaction        — last, because it is the only READ-ONLY member (a
//                          status strip with no actions); ordering the
//                          interactive prompts ahead of the passive strip reads
//                          naturally.
// In practice at most one of these is live at a time (they are mutually
// exclusive screen states), so the cross-record ordering rarely matters at
// runtime — but the dedupe key still depends on it, so we freeze it regardless.
//
// Slash picker is appended after AskUserQuestion because it joined the snapshot
// later. Appending preserves the insertion order (and therefore dedupe key) for
// every snapshot that does not contain a live slash picker.
//
// `readonly` + `as const`: the order is load-bearing, so we freeze it at the type
// level. The `ConditionModule<string, ClaudeConditionInputs, any>` element type
// is the erased form the evaluator routes over (it reads only `kind` and calls
// `actions`); each module's concrete state type is preserved at its definition
// site, erased only here where the list is heterogeneous.

import type { ConditionModule } from './core/contract.js'
import { askUserQuestionModule } from './askUserQuestion.js'
import { compactionModule } from './compaction.js'
import { permissionPromptModule } from './permissionPrompt.js'
import { resumePromptModule } from './resumePrompt.js'
import { slashPickerModule } from './slashPicker.js'
import { trustDialogModule } from './trustDialog.js'
import type { ClaudeConditionInputs } from './types.js'

// Order recap (see the header for why order is a wire contract): trust →
// permission → resume → compaction → ask-user-question → slash-picker.
export const CLAUDE_MODULES: readonly ConditionModule<
  string,
  ClaudeConditionInputs,
  any,
  any
>[] = [
  trustDialogModule,
  permissionPromptModule,
  resumePromptModule,
  compactionModule,
  askUserQuestionModule,
  slashPickerModule,
] as const
