import { describe, expect, it } from 'vitest'

import { normalizeVolatileScreenText } from './volatileScreenText.js'

// agent-code#765: the fixtures are the recorded spinner lines from agent-code's
// screenFrameGate.test.ts (PR #761). The package and the app share this rule
// set, so a fixture that stops normalizing here stops normalizing there too.

const CLAUDE_THINKING = [
  '> fix the flaky test',
  '',
  "✻ Beboppin'… (5s · ↓ 1.2k tokens · thinking…)",
  '',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                          /rc connecting…',
].join('\n')

const CLAUDE_THINKING_NEXT_TICK = [
  '> fix the flaky test',
  '',
  "✽ Beboppin'… (6s · ↓ 1.3k tokens · thinking…)",
  '',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                          /rc',
].join('\n')

const CODEX_WORKING = ['• Working (12s • esc to interrupt)', '', '› Ask Codex to do anything   '].join('\n')
const CODEX_WORKING_NEXT_TICK = ['• Working (13s • esc to interrupt)', '', '› Ask Codex to do anything'].join('\n')

describe('normalizeVolatileScreenText', () => {
  it('maps a spinner tick, timer, token counter and the rc blink to one key', () => {
    expect(normalizeVolatileScreenText(CLAUDE_THINKING)).toBe(
      normalizeVolatileScreenText(CLAUDE_THINKING_NEXT_TICK),
    )
    expect(normalizeVolatileScreenText(CODEX_WORKING)).toBe(
      normalizeVolatileScreenText(CODEX_WORKING_NEXT_TICK),
    )
  })

  it('leaves identifiers that merely end in s alone', () => {
    const line = 'k8s deploy s3://bucket v1.2s3 took 3 seconds'
    expect(normalizeVolatileScreenText(line)).toBe(line)
  })

  it('keeps the spinner verb and the done transition visible', () => {
    // The verb changes every few seconds and "done" is a state change;
    // neither is chrome, both must produce a different key.
    expect(normalizeVolatileScreenText("✻ Beboppin'… (5s)")).not.toBe(
      normalizeVolatileScreenText('✻ Ionizing… (5s)'),
    )
    expect(normalizeVolatileScreenText('✻ Cogitated for 1m 9s · done 2:03 PM')).not.toBe(
      normalizeVolatileScreenText("✻ Cogitating… (1m 9s · thinking…)"),
    )
  })

  it('keeps a composer keystroke, a new output line and a prompt distinct from a tick', () => {
    // A rule broad enough to swallow any of these would let the package skip
    // its detectors on a frame the user can act on.
    const tick = normalizeVolatileScreenText(CLAUDE_THINKING_NEXT_TICK)
    expect(normalizeVolatileScreenText(CLAUDE_THINKING_NEXT_TICK.replace('flaky test', 'flaky tests'))).not.toBe(tick)
    expect(normalizeVolatileScreenText(CLAUDE_THINKING_NEXT_TICK + '\n⏺ Read(README.md)')).not.toBe(tick)
    expect(normalizeVolatileScreenText(CLAUDE_THINKING_NEXT_TICK + '\nDo you want to proceed?\n❯ 1. Yes')).not.toBe(tick)
  })
})
