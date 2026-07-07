import { describe, expect, it } from 'vitest'

import { headerMarksSubagent } from './ClaudeProxyAdapter.js'

// Real billing-header strings captured from a live session (agent-code #477):
// a Task subagent's request carries cc_is_subagent=true in the SAME header
// block that holds cc_entrypoint; the main agent's does not. cc_entrypoint is
// identical for both (process-scoped), which is exactly why it can't
// disambiguate and this flag is needed.
const MAIN =
  'x-anthropic-billing-header: cc_version=2.1.202.a7e; cc_entrypoint=claude-desktop; cch=07f0c; cc_prev_req=req_011Ccnz6TPA8MARBWsGUSaCN;'
const SUBAGENT =
  'x-anthropic-billing-header: cc_version=2.1.202.81b; cc_entrypoint=claude-desktop; cch=813a4; cc_is_subagent=true;'

describe('headerMarksSubagent (#477 Track B)', () => {
  it('is true only for the subagent header', () => {
    expect(headerMarksSubagent(SUBAGENT)).toBe(true)
    expect(headerMarksSubagent(MAIN)).toBe(false)
  })
  it('handles missing / non-string input', () => {
    expect(headerMarksSubagent(undefined)).toBe(false)
    expect(headerMarksSubagent(null)).toBe(false)
    expect(headerMarksSubagent('')).toBe(false)
  })
  it('does not false-positive on cc_is_subagent=false', () => {
    expect(headerMarksSubagent('cc_entrypoint=x; cc_is_subagent=false;')).toBe(false)
  })
})
