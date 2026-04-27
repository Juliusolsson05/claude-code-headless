import type { CompactionState } from '../parsers/CompactionParser.js'
import type { ClaudeCompactionCondition } from './types.js'

export function buildClaudeCompactionCondition(
  state: CompactionState,
): ClaudeCompactionCondition | null {
  if (!state.visible) return null
  return {
    kind: 'claude.compaction',
    state,
    actions: [],
  }
}
