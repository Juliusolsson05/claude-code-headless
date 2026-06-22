// claude-code-headless / conditions / types.ts
//
// The per-tick INPUT BUNDLE every Claude condition module detects against,
// plus the typed condition record shapes the modules produce. Mirrors
// codex-headless/src/conditions/types.ts exactly in spirit.
//
// WHY this is its own leaf file (cycle avoidance — the lesson codex already learned).
// ---------------------------------------------------------------------------------
// The four modules (trustDialog.ts, permissionPrompt.ts, resumePrompt.ts,
// compaction.ts) all need `ClaudeConditionInputs`, and modules.ts imports the
// modules. If the input type lived in modules.ts the modules would import from
// modules.ts while modules.ts imports them — a cycle. types.ts is the leaf both
// sides depend on, so it is the cycle-free home. This is the identical structure
// codex-headless arrived at after the same problem (see its types.ts header).

import type { CompactionState } from '../parsers/CompactionParser.js'
import type { PermissionPromptState } from '../parsers/PermissionPromptParser.js'
import type { ResumePromptState } from '../parsers/ResumePromptParser.js'
import type { TrustDialogState } from '../parsers/TrustDialogParser.js'
import type { ConditionAction } from './core/contract.js'

// Re-export the wire action union from the vendored core so condition consumers
// inside this package import action types from the conditions barrel rather than
// reaching into ./core. Same convenience codex-headless/types.ts provides.
export type {
  ConditionAction,
  ConditionPtyAction,
  ConditionCustomAction,
} from './core/contract.js'

// ── The input bundle ────────────────────────────────────────────────────────
//
// One field per MODAL condition this PR restores. Each is the LATEST parsed
// state the screen-tick handler stored on the ClaudeCodeHeadless instance
// (trustDialogState / permissionPromptState / resumePromptState /
// compactionState). The slash-picker is INTENTIONALLY ABSENT — it is NOT
// migrated to the snapshot path in this PR (it keeps its existing `snap.picker`
// / `slash-picker` event path untouched), so it has no field here.
//
// Every field is non-optional and carries the parser's own `{ visible: false }`
// resting value when its condition isn't live, so a module's `detect` can gate
// purely on `state.visible` without a presence check.
export type ClaudeConditionInputs = {
  trustDialog: TrustDialogState
  permissionPrompt: PermissionPromptState
  resumePrompt: ResumePromptState
  compaction: CompactionState
}

// ── Typed condition records (mirrors the ClaudeCondition union app-side) ─────
//
// These are the strongly-typed forms of the records the evaluator inserts into
// the snapshot's `conditions` map. They are structurally identical to the
// `ClaudeCondition` union in src/shared/types/providerConditions.ts (the app
// side) — kept here too so this package typechecks standalone without importing
// the host app's shared types (the submodule import wall). The `kind` strings
// MUST match the app-side union byte-for-byte; the renderer's CLAUDE_VIEWS keys
// off exactly these strings.

export type ClaudeTrustDialogCondition = {
  kind: 'claude.trust-dialog'
  state: TrustDialogState
  actions: ConditionAction[]
}

export type ClaudePermissionPromptCondition = {
  kind: 'claude.permission-prompt'
  state: PermissionPromptState
  actions: ConditionAction[]
}

export type ClaudeResumePromptCondition = {
  kind: 'claude.resume-prompt'
  state: ResumePromptState
  actions: ConditionAction[]
}

export type ClaudeCompactionCondition = {
  kind: 'claude.compaction'
  state: CompactionState
  actions: ConditionAction[]
}

// NOTE: `claude.slash-picker` is deliberately NOT part of this union. It is OUT
// OF SCOPE for PR-3 — it stays on its existing per-event `snap.picker` path and
// is migrated to the snapshot in a later PR. Adding it here would imply a module
// that doesn't exist yet.
export type ClaudeCondition =
  | ClaudeTrustDialogCondition
  | ClaudePermissionPromptCondition
  | ClaudeResumePromptCondition
  | ClaudeCompactionCondition

export type ClaudeConditionKind = ClaudeCondition['kind']

export type ClaudeConditionMap = Partial<{
  [K in ClaudeConditionKind]: Extract<ClaudeCondition, { kind: K }>
}>

export type ClaudeConditionSnapshot = {
  provider: 'claude'
  conditions: ClaudeConditionMap
  ts: number
}
