import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeCodeHeadless } from './ClaudeCodeHeadless.js'

function fakePty(): IPty {
  const disposable = { dispose: vi.fn() }
  return {
    pid: 1,
    process: 'claude',
    cols: 120,
    rows: 40,
    handleFlowControl: false,
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => disposable),
    onExit: vi.fn(() => disposable),
  } as unknown as IPty
}

describe('ClaudeCodeHeadless condition publication', () => {
  it('publishes conditions even while the semantic baseline suppresses a frame', () => {
    const headless = new ClaudeCodeHeadless({ pty: fakePty(), cwd: '/tmp' })
    const internal = headless as unknown as {
      terminal: EventEmitter
      liveOwner: { kind: 'screen'; turnId: string; startedAt: number; status: 'active' }
      liveSemanticTurnId: string
      screenBaselineText: string
      screenBaselineSatisfied: boolean
    }
    internal.liveOwner = {
      kind: 'screen',
      turnId: 'live-1',
      startedAt: Date.now(),
      status: 'active',
    }
    internal.liveSemanticTurnId = 'live-1'
    internal.screenBaselineText = 'previous answer'
    internal.screenBaselineSatisfied = false

    const seen: string[][] = []
    headless.on('conditions', snapshot => {
      seen.push(Object.keys(snapshot.conditions))
    })
    const trustScreen = [
      'Quick safety check',
      'Accessing workspace:',
      '/tmp/project',
      'Yes, I trust this folder',
      'No, exit',
    ].join('\n')
    internal.terminal.emit('screen', {
      plain: trustScreen,
      markdown: trustScreen,
      // Keeping the extracted assistant text equal to the captured baseline is
      // the exact branch that used to return before condition publication.
      recent: '⏺ previous answer',
      recentMarkdown: '⏺ previous answer',
    })

    expect(internal.screenBaselineSatisfied).toBe(false)
    expect(seen).toEqual([['claude.trust-dialog']])
    expect(headless.getConditionSnapshot().conditions)
      .toHaveProperty('claude.trust-dialog')
  })
})
