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

describe('ClaudeCodeHeadless composer classification', () => {
  // Regression: a dim prompt suggestion used to classify as 'drafted', which
  // made derivePromptGateState return { kind:'occupied' } with no recovery path
  // and blocked every prompt. Observed for 186 continuous seconds in session
  // ef052e06. These drive the real screen pipeline, not the parser directly, so
  // they prove the attribute descriptor actually reaches the classifier.
  const RULE = '─'.repeat(60)
  const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`

  async function paintComposer(row: string): Promise<ClaudeCodeHeadless> {
    const headless = new ClaudeCodeHeadless({ pty: fakePty(), cwd: '/tmp' })
    const internal = headless as unknown as {
      terminal: EventEmitter & { writeForTest(data: string): Promise<void> }
    }
    // composerState is derived inside the 'screen' handler, and that flush is
    // throttled by snapshotIntervalMs. Await the event rather than sleeping so
    // the test asserts on a frame that definitely ran.
    const painted = new Promise<void>(resolve =>
      internal.terminal.once('screen', () => resolve()),
    )
    await internal.terminal.writeForTest([RULE, row, RULE].join('\r\n'))
    await painted
    return headless
  }

  it('reports an empty composer when the placeholder is dim', async () => {
    const headless = await paintComposer(`❯ ${dim('now count backwards from 30 to 1')}`)
    expect(headless.getComposerState()).toBe('empty')
  })

  it('still reports a drafted composer for typed text', async () => {
    const headless = await paintComposer('❯ this is a real human draft')
    expect(headless.getComposerState()).toBe('drafted')
  })
})

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
