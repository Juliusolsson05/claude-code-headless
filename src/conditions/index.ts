// claude-code-headless / conditions / index.ts
//
// Barrel for the Claude conditions migration. Mirrors
// codex-headless/src/conditions/index.ts: exports the modules, the ordered
// registry, the typed shapes, and re-exports the generic evaluator from the
// vendored core so CodexHeadless's Claude counterpart (ClaudeCodeHeadless) can
// import `makeEvaluator` from the conditions barrel rather than reaching into
// ./core directly.

export { trustDialogModule, buildClaudeTrustDialogCondition } from './trustDialog.js'
export {
  permissionPromptModule,
  buildClaudePermissionPromptCondition,
} from './permissionPrompt.js'
export {
  resumePromptModule,
  buildClaudeResumePromptCondition,
} from './resumePrompt.js'
export { compactionModule, buildClaudeCompactionCondition } from './compaction.js'
export {
  askUserQuestionModule,
  buildClaudeAskUserQuestionCondition,
} from './askUserQuestion.js'
export { CLAUDE_MODULES } from './modules.js'

// Re-export the generic headless evaluator from the vendored core, exactly as
// codex-headless does. Consumers that drive Claude conditions through the
// registry (ClaudeCodeHeadless's long-lived latch) import it from here.
export { makeEvaluator } from './core/evaluator.js'
export type { ConditionEvaluator } from './core/evaluator.js'

export type {
  ClaudeCondition,
  ClaudeConditionInputs,
  ClaudeConditionKind,
  ClaudeConditionMap,
  ClaudeConditionSnapshot,
  ClaudeTrustDialogCondition,
  ClaudePermissionPromptCondition,
  ClaudeResumePromptCondition,
  ClaudeCompactionCondition,
  ClaudeAskUserQuestionCondition,
  ConditionAction,
  ConditionCustomAction,
  ConditionPtyAction,
} from './types.js'
