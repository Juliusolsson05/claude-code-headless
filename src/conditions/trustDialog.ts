import {
  TRUST_DIALOG_ACCEPT_KEYS,
  type TrustDialogState,
} from '../parsers/TrustDialogParser.js'
import type { ClaudeTrustDialogCondition } from './types.js'

export function buildClaudeTrustDialogCondition(
  state: TrustDialogState,
): ClaudeTrustDialogCondition | null {
  if (!state.visible) return null
  return {
    kind: 'claude.trust-dialog',
    state,
    actions: [
      { kind: 'pty', id: 'accept', label: 'Trust folder', data: TRUST_DIALOG_ACCEPT_KEYS },
      { kind: 'pty', id: 'reject', label: 'Exit', data: '2\r' },
    ],
  }
}
