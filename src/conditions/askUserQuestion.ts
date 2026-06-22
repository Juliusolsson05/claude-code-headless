// claude-code-headless / conditions / askUserQuestion.ts
//
// The `claude.ask-user-question` condition module. Makes Claude Code's
// `AskUserQuestion` TUI picker a FIRST-CLASS, DEDUPED condition in the unified
// snapshot — the modular replacement for the screen-snapshot shortcut we
// explicitly rejected (a raw per-tick `snap.askUserQuestion` field that the
// renderer consumed directly as a render gate, which flickered with every
// terminal repaint and hardcoded picker knowledge into the feed).
//
// WHY THIS MODULE EXISTS — AND WHAT IT IS *NOT* RESPONSIBLE FOR.
// ------------------------------------------------------------------------------
// The native in-feed picker (AskUserQuestionRow, app-side) is driven by the
// SEMANTIC tool block (`block.parsedInput` for the option labels, `resultAt` for
// dismissal). That transcript-backed path is the source of truth for whether the
// row RENDERS and when it goes away — it is flicker-immune because it never reads
// terminal paint. This module does NOT try to own that; gating the row's render
// on a screen-derived condition is exactly the brittleness we are avoiding.
//
// What ONLY the live screen can tell us — and therefore what this module owns:
//   1. Is the picker actually ON SCREEN RIGHT NOW? (presence) — used as a
//      SECONDARY, non-render signal: an attention badge ("this agent is asking
//      a question") and, in the follow-up driver PR, an answerability gate that
//      closes the "answered via terminal → stray digit" race. It is deliberately
//      NOT wired as the row's render gate.
//   2. The live cursor / per-option toggle state + the on-screen number→option
//      mapping needed to ANSWER multi-select / free-text / multi-question calls.
//      That answering is the NEXT PR (the `sendThenReparse` driver, which lands
//      via this module's dormant `resolve`/`Ctx` slot — see core/contract.ts).
//      We capture the full parser state now so the payload is already complete
//      when the driver arrives; this PR only consumes the PRESENCE.
//
// So: detection is screen-derived (the parser), liveness/dismissal of the row is
// semantic (app-side). The two halves are intentionally split — that split is
// the whole point of the conditions framework over the old snapshot shortcut.

import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type {
  ClaudeConditionInputs,
  ClaudeAskUserQuestionCondition,
} from './types.js'
import {
  resolveAskUserQuestionAction,
  type AskUserQuestionResolveCtx,
} from './askUserQuestionDriver.js'
import type { AskUserQuestionState } from '../parsers/AskUserQuestionParser.js'

// Build the answer keystrokes from the LIVE parsed state.
//
// WHY actions are derived from state (not a static template like the other
// Claude modules): trust/permission/resume have a fixed set of choices, so their
// actions are a frozen literal cloned per call. An AskUserQuestion picker's
// choices are DYNAMIC — they are exactly the options the agent passed, parsed off
// the live screen — so the action list must be computed from `state.options`.
//
// THE KEYSTROKE CONTRACT (single-select only, this PR):
//   For a single, single-select question Claude's picker SELECTS AND SUBMITS the
//   whole tool ATOMICALLY the instant a digit is pressed — the on-screen number
//   `N` of an option IS the complete answer keystroke (no Enter, no navigation).
//   This is the same trick AskUserQuestionRow already uses (`String(i+1)`); the
//   module formalizes it as the wire contract so the answering driver and the
//   renderer share ONE source of truth for "how do I answer option N".
//
// WHAT IS DELIBERATELY EXCLUDED from the atomic pty actions:
//   - MULTI-SELECT: a digit TOGGLES a checkbox, it does NOT submit. Answering is
//     a multi-step exchange (toggle… toggle… focus Submit… Enter) that needs the
//     `sendThenReparse` driver via `resolve` — NOT a single keystroke. So we emit
//     NO pty actions for multi mode; the renderer keeps it read-only until PR-5.
//   - The auto-injected "Type something" free-text row (`otherNumber`): pressing
//     its number opens a TEXT PROMPT rather than committing, so it is not an
//     atomic answer either. Excluded here; free-text answering is also PR-5.
//   - "Chat about this" is already absent from `state.options` (the parser drops
//     the below-divider footer), so it can never become an action.
function buildAskUserQuestionActions(state: AskUserQuestionState): ConditionAction[] {
  // Only the single-select shape has an atomic single-keystroke answer. For
  // everything else the answer is a multi-step exchange owned by the driver PR,
  // so there is no correct pty action to expose yet.
  if (state.mode !== 'single') return []

  const actions: ConditionAction[] = []
  for (const option of state.options) {
    // Skip the free-text row — its number opens a text field, it does not
    // commit, so it is not an atomic answer. (Single-digit number → instant
    // commit is the invariant that makes a pty action valid here.)
    if (state.otherNumber !== null && option.number === state.otherNumber) continue
    actions.push({
      kind: 'pty',
      // `answer-N` keys the action by the on-screen number, which is also the
      // keystroke — stable and human-legible for any consumer enumerating them.
      id: `answer-${option.number}`,
      label: option.label,
      data: String(option.number),
    })
  }
  return actions
}

// askUserQuestionModule — headless-module form of the AskUserQuestion condition.
//
// `detect` returns `inputs.askUserQuestion` VERBATIM when a picker is on screen,
// else null. The input field is the parser's own `AskUserQuestionState | null`
// (NOT a `{ visible: false }` sentinel like the other modules) because the
// AskUserQuestionParser returns null when no picker is present — there is no
// "inactive picker" state to carry. So the presence check is a null check.
export const askUserQuestionModule = defineModule<
  'claude.ask-user-question',
  ClaudeConditionInputs,
  AskUserQuestionState,
  AskUserQuestionResolveCtx
>({
  kind: 'claude.ask-user-question',
  detect: (inputs) => inputs.askUserQuestion,
  // Fresh objects per call — the conditions-core isolation contract (a consumer
  // mutating a returned action must not poison the next evaluation). Unlike the
  // static-template modules we build the array fresh from state each call, so the
  // freshness is inherent; `buildAskUserQuestionActions` always allocates anew.
  actions: (state) => buildAskUserQuestionActions(state),
  // PR-5: structured answering lives behind `resolve`, not more renderer
  // keystroke guesses. The renderer knows the semantic answer the user chose;
  // this resolver maps that answer onto the LIVE numbered TUI rows, sends one
  // key, reparses, and repeats until Claude advances or closes the picker.
  resolve: resolveAskUserQuestionAction,
})

// Convenience builder mirroring the other `buildClaude*Condition` helpers, for a
// caller that has a bare parser state and wants the typed record. Off the hot
// path; present for symmetry with trustDialog/permissionPrompt/etc.
export function buildClaudeAskUserQuestionCondition(
  state: AskUserQuestionState | null,
): ClaudeAskUserQuestionCondition | null {
  const detected = askUserQuestionModule.detect({
    trustDialog: { visible: false },
    permissionPrompt: { visible: false },
    resumePrompt: { visible: false },
    compaction: { visible: false },
    askUserQuestion: state,
  })
  if (detected === null) return null
  return {
    kind: 'claude.ask-user-question',
    state: detected,
    actions: askUserQuestionModule.actions(detected),
  }
}
