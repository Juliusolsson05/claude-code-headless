import type { CompactionState } from '../parsers/CompactionParser.js'
import type { PermissionPromptState } from '../parsers/PermissionPromptParser.js'
import type { ResumePromptState } from '../parsers/ResumePromptParser.js'
import type { SlashPickerState } from '../parsers/SlashPickerParser.js'
import type { TrustDialogState } from '../parsers/TrustDialogParser.js'

export type ConditionPtyAction = {
  kind: 'pty'
  id: string
  label: string
  data: string
}

export type ConditionCustomAction = {
  kind: 'custom'
  id: string
  label: string
  name: string
}

export type ConditionAction = ConditionPtyAction | ConditionCustomAction

export type ClaudeTrustDialogCondition = {
  kind: 'claude.trust-dialog'
  state: TrustDialogState
  actions: ConditionAction[]
}

export type ClaudeResumePromptCondition = {
  kind: 'claude.resume-prompt'
  state: ResumePromptState
  actions: ConditionAction[]
}

export type ClaudePermissionPromptCondition = {
  kind: 'claude.permission-prompt'
  state: PermissionPromptState
  actions: ConditionAction[]
}

export type ClaudeCompactionCondition = {
  kind: 'claude.compaction'
  state: CompactionState
  actions: ConditionAction[]
}

export type ClaudeSlashPickerCondition = {
  kind: 'claude.slash-picker'
  state: SlashPickerState
  actions: ConditionAction[]
}

export type ClaudeCondition =
  | ClaudeTrustDialogCondition
  | ClaudeResumePromptCondition
  | ClaudePermissionPromptCondition
  | ClaudeCompactionCondition
  | ClaudeSlashPickerCondition

export type ClaudeConditionKind = ClaudeCondition['kind']

export type ClaudeConditionMap = Partial<{
  [K in ClaudeConditionKind]: Extract<ClaudeCondition, { kind: K }>
}>

export type ClaudeConditionSnapshot = {
  provider: 'claude'
  conditions: ClaudeConditionMap
  ts: number
}
