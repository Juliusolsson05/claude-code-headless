import type { CompactionState } from '../parsers/CompactionParser.js'
import type { PermissionPromptState } from '../parsers/PermissionPromptParser.js'
import type { ResumePromptState } from '../parsers/ResumePromptParser.js'
import type { SlashPickerState } from '../parsers/SlashPickerParser.js'
import type { TrustDialogState } from '../parsers/TrustDialogParser.js'
import { buildClaudeCompactionCondition } from './compaction.js'
import { buildClaudePermissionPromptCondition } from './permissionPrompt.js'
import { buildClaudeResumePromptCondition } from './resumePrompt.js'
import { buildClaudeSlashPickerCondition } from './slashPicker.js'
import { buildClaudeTrustDialogCondition } from './trustDialog.js'
import type { ClaudeConditionMap, ClaudeConditionSnapshot } from './types.js'

export type ClaudeConditionInputs = {
  trustDialog: TrustDialogState
  resumePrompt: ResumePromptState
  permissionPrompt: PermissionPromptState
  compaction: CompactionState
  slashPicker: SlashPickerState
}

export function evaluateClaudeConditions(
  inputs: ClaudeConditionInputs,
): ClaudeConditionSnapshot {
  const conditions: ClaudeConditionMap = {}

  const trustDialog = buildClaudeTrustDialogCondition(inputs.trustDialog)
  if (trustDialog) conditions[trustDialog.kind] = trustDialog

  const resumePrompt = buildClaudeResumePromptCondition(inputs.resumePrompt)
  if (resumePrompt) conditions[resumePrompt.kind] = resumePrompt

  const permissionPrompt = buildClaudePermissionPromptCondition(inputs.permissionPrompt)
  if (permissionPrompt) conditions[permissionPrompt.kind] = permissionPrompt

  const compaction = buildClaudeCompactionCondition(inputs.compaction)
  if (compaction) conditions[compaction.kind] = compaction

  const slashPicker = buildClaudeSlashPickerCondition(inputs.slashPicker)
  if (slashPicker) conditions[slashPicker.kind] = slashPicker

  return {
    provider: 'claude',
    conditions,
    ts: Date.now(),
  }
}

export function claudeConditionSnapshotKey(
  snapshot: ClaudeConditionSnapshot,
): string {
  return JSON.stringify(snapshot.conditions)
}
