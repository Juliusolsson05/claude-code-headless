// claude-code-headless / conditions / resumePrompt.ts
//
// The `claude.resume-prompt` condition module. Detects Claude Code's
// resume-choice prompt (shown when resuming a large/old session) and exposes a
// minimal, HONEST set of representative keystroke actions.
//
// WHY THIS MODULE EXISTS — IT RESTORES A DEAD MODAL (see trustDialog.ts header).
//
// WHY THE ACTIONS HERE ARE DELIBERATELY MINIMAL — AND WHY THAT IS CORRECT.
// -----------------------------------------------------------------------
// The resume prompt is a LIST with a moving selection (`❯`). ResumePromptModal.tsx
// does NOT consume the condition's `actions` to drive movement: it computes the
// arrow-key keystroke sequence ITSELF from the current vs. target index
// (`moveSelection`: `'\x1b[A'` / `'\x1b[B'` repeated, then `'\r'`), and sends
// '\r' to confirm / '\x1b' to cancel. So the snapshot's `actions` are NOT
// load-bearing for this view — the modal would ignore a full options list even
// if we built one.
//
// Rather than fabricate a per-option action array that pretends to encode
// selection (which would be a lie the renderer ignores, and would also have to
// recompute movement keystrokes the modal already computes correctly), we expose
// only the two TERMINAL keystrokes that ARE unambiguous and view-independent:
//   confirm → '\r'   (Enter confirms the currently highlighted option)
//   cancel  → '\x1b' (ESC cancels)
// These match ResumePromptModal.tsx's confirm()/cancel() and the legacy
// per-event `resume_prompt` emission's confirm()/cancel() closures exactly. This
// keeps the actions honest: they are real keystrokes the TUI accepts, and we
// document that movement lives in the view, not here.

import { defineModule } from './core/contract.js'
import type { ConditionAction } from './core/contract.js'
import type {
  ClaudeConditionInputs,
  ClaudeResumePromptCondition,
} from './types.js'
import type { ResumePromptState } from '../parsers/ResumePromptParser.js'

// Action TEMPLATE — DATA ONLY; cloned fresh per call. See the header for why this
// is intentionally just the two terminal keystrokes and NOT the option list.
const RESUME_PROMPT_ACTIONS: readonly ConditionAction[] = [
  { kind: 'pty', id: 'confirm', label: 'Confirm selection', data: '\r' },
  { kind: 'pty', id: 'cancel', label: 'Cancel', data: '\x1b' },
]

// resumePromptModule — headless-module form of the resume-prompt condition.
//
// `detect` returns `inputs.resumePrompt` verbatim when visible, else null. The
// state still carries `selectedIndex` (and age/token text) so a future view that
// DOES want to render the highlighted row has it; we just don't encode it into
// `actions`.
export const resumePromptModule = defineModule<
  'claude.resume-prompt',
  ClaudeConditionInputs,
  ResumePromptState
>({
  kind: 'claude.resume-prompt',
  detect: (inputs) =>
    inputs.resumePrompt.visible ? inputs.resumePrompt : null,
  // Fresh objects per call — isolation contract (see trustDialog.ts).
  actions: () => RESUME_PROMPT_ACTIONS.map((a) => ({ ...a })),
})

export function buildClaudeResumePromptCondition(
  state: ResumePromptState,
): ClaudeResumePromptCondition | null {
  const detected = resumePromptModule.detect({
    trustDialog: { visible: false },
    permissionPrompt: { visible: false },
    resumePrompt: state,
    compaction: { visible: false },
    askUserQuestion: null,
  })
  if (detected === null) return null
  return {
    kind: 'claude.resume-prompt',
    state: detected,
    actions: resumePromptModule.actions(detected),
  }
}
