import xtermHeadless from '@xterm/headless'
import { describe, expect, it } from 'vitest'

import { detectAskUserQuestion } from '../parsers/AskUserQuestionParser.js'
import { resolveAskUserQuestionAction } from './askUserQuestionDriver.js'
import type { ConditionCustomAction } from './core/contract.js'

const { Terminal } = xtermHeadless

// CAPTURED, not invented. This picker region is the viewport of a REAL
// `claude` AskUserQuestion picker driven through node-pty at 80 columns, where
// each option label is a full sentence that wraps. The TUI keeps only the
// first physical line on the numbered row and pushes the rest below, where it
// is indistinguishable in plain text from the option's description. So the
// parser can only ever read the TRUNCATED label — and the answer payload the
// renderer builds from the semantic tool input carries the FULL one.
//
// The FULL labels below are the same picker captured at 160 columns in the
// same run, where nothing wrapped. Exact-equality matching between the two
// could never succeed, which is why answering a wrapping option used to fail
// with `option-not-found`, zero keystrokes written, and the picker left up.
const PICKER_LINES = [
  ' ☐ Rollout',
  'Which rollout strategy do you prefer?',
  '❯ 1. We should roll the new release out to a small five percent slice of users',
  '     first and then gradually widen exposure as metrics stay healthy.',
  '  2. We should deploy the change to every user at once during a scheduled',
  '     low-traffic window so the entire migration completes in one step.',
  '  3. We should run the old and new versions side by side and route traffic',
  '     between them using a feature flag we can toggle instantly.',
  '  4. Type something.',
  '────────────────',
  '  5. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
]

const FULL_LABELS = [
  'We should roll the new release out to a small five percent slice of users first and then gradually widen exposure as metrics stay healthy.',
  'We should deploy the change to every user at once during a scheduled low-traffic window so the entire migration completes in one step.',
  'We should run the old and new versions side by side and route traffic between them using a feature flag we can toggle instantly.',
]

// xterm-headless processes `write` asynchronously, so we must wait for the
// last chunk's callback before reading the grid — otherwise the parser sees an
// empty buffer and returns null.
function parsePicker(): Promise<ReturnType<typeof detectAskUserQuestion>> {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  return new Promise(resolve => {
    let remaining = PICKER_LINES.length
    for (const line of PICKER_LINES) {
      term.write(`${line}\r\n`, () => {
        if (--remaining === 0) resolve(detectAskUserQuestion(term))
      })
    }
  })
}

// A ctx that serves one parsed state and reports the picker CLOSED as soon as a
// digit is written — the real TUI's response to a single-select answer. Records
// every byte the driver emits so the test can assert the exact keystroke.
function mockCtx(state: ReturnType<typeof detectAskUserQuestion>) {
  const writes: string[] = []
  let closed = false
  return {
    writes,
    ctx: {
      write: (data: string) => {
        writes.push(data)
        if (/\d/.test(data)) closed = true
      },
      term: () => new Terminal(),
      snapshotPlain: () => '',
      reparse: () => (closed ? null : state),
      signal: new AbortController().signal,
    },
  }
}

function answerAction(label: string, number: number): ConditionCustomAction {
  return {
    kind: 'custom',
    id: 'answer',
    label: 'Answer',
    name: 'claude.askUserQuestion.answer',
    payload: {
      answers: [
        {
          question: 'Which rollout strategy do you prefer?',
          multiSelect: false,
          selectedOptions: [{ label, number }],
          selectedLabels: [label],
        },
      ],
    },
  }
}

describe('AskUserQuestion truncated-label answering', () => {
  it('parses only the truncated first line of a wrapping label', async () => {
    const state = await parsePicker()
    expect(state).not.toBeNull()
    // Documents the precondition: the screen label is a hard-wrapped prefix.
    expect(state!.options[0].label).toBe(
      'We should roll the new release out to a small five percent slice of users',
    )
    expect(FULL_LABELS[0].startsWith(state!.options[0].label)).toBe(true)
    expect(FULL_LABELS[0]).not.toBe(state!.options[0].label)
  })

  it('answers a wrapping option by its FULL label — the reported bug', async () => {
    const state = await parsePicker()
    const { ctx, writes } = mockCtx(state)
    const result = await resolveAskUserQuestionAction(answerAction(FULL_LABELS[0], 1), ctx)
    expect(result?.ok).toBe(true)
    // Selecting screen option 1 is a single '1' keypress; '' is the driver's
    // advance poll.
    expect(writes.filter(Boolean)).toEqual(['1'])
  })

  it('resolves the third wrapping option to its own number', async () => {
    const state = await parsePicker()
    const { ctx, writes } = mockCtx(state)
    const result = await resolveAskUserQuestionAction(answerAction(FULL_LABELS[2], 3), ctx)
    expect(result?.ok).toBe(true)
    expect(writes.filter(Boolean)).toEqual(['3'])
  })

  it('fails closed (no keystroke) when the number points at a different option', async () => {
    // Option 1's full label sent against number 2 — a diverged/stale picker.
    // Option 2's screen label is not prefix-consistent with option 1's, so this
    // resolves to null and must write nothing.
    const state = await parsePicker()
    const { ctx, writes } = mockCtx(state)
    const result = await resolveAskUserQuestionAction(answerAction(FULL_LABELS[0], 2), ctx)
    expect(result?.ok).toBe(false)
    expect(writes.filter(Boolean)).toEqual([])
  })

  // The safety case a prior cut got wrong: when two options share a stem long
  // enough to survive truncation, the screen label alone cannot single one out,
  // and a diverged number must NOT be trusted to. These are built by hand
  // because the captured picker happened to have distinct prefixes; the shape
  // (shared stem past the 12-char floor) is the real hazard.
  // Both option rows render the SAME first physical line; they diverge only in
  // the wrapped tail the TUI drops, so the parser reads two options with an
  // identical truncated label.
  const SHARED_STEM_PICKER = [
    ' ☐ Deploy',
    'How should we deploy?',
    '❯ 1. We should deploy to staging first and then promote to production once',
    '     a manual smoke test of the critical paths has passed.',
    '  2. We should deploy to staging first and then promote to production once',
    '     the automated health checks pass on their own.',
    '  4. Type something.',
    '────────────────',
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]
  function parseShared(): Promise<ReturnType<typeof detectAskUserQuestion>> {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    return new Promise(resolve => {
      let remaining = SHARED_STEM_PICKER.length
      for (const line of SHARED_STEM_PICKER) {
        term.write(`${line}\r\n`, () => {
          if (--remaining === 0) resolve(detectAskUserQuestion(term))
        })
      }
    })
  }

  it('fails closed when two options truncate to the same screen prefix', async () => {
    const state = await parseShared()
    // Both option 1 and option 2 render the identical first line, so the parser
    // sees two options with the same truncated label.
    expect(state!.options[0].label).toBe(state!.options[1].label)
    const full1 =
      'We should deploy to staging first and then promote to production once a manual smoke test of the critical paths has passed.'
    // Answer option 1 by its full label. Even with the correct number, the
    // screen cannot confirm which row it is — resolve must fail closed rather
    // than trust the number and risk the wrong option.
    const { ctx, writes } = mockCtx(state)
    const result = await resolveAskUserQuestionAction(
      {
        kind: 'custom',
        id: 'answer',
        label: 'Answer',
        name: 'claude.askUserQuestion.answer',
        payload: {
          answers: [
            {
              question: 'How should we deploy?',
              multiSelect: false,
              selectedOptions: [{ label: full1, number: 1 }],
              selectedLabels: [full1],
            },
          ],
        },
      },
      ctx,
    )
    expect(result?.ok).toBe(false)
    expect(writes.filter(Boolean)).toEqual([])
  })

  it('does NOT apply truncation tolerance to multi-select (stays fail-closed)', async () => {
    // Truncation tolerance is single-select only. A live review found that
    // resolving a wrapping option in multi-select lets driveMulti's toggle loop
    // reach a pre-existing checkbox-wrap over-toggle; on main that path failed
    // closed. So a multi-select answer by a full (wrapping) label must NOT
    // resolve here — it fails closed exactly as before, no keystroke.
    const state = await parsePicker()
    const { ctx, writes } = mockCtx(state)
    const result = await resolveAskUserQuestionAction(
      {
        kind: 'custom',
        id: 'answer',
        label: 'Answer',
        name: 'claude.askUserQuestion.answer',
        payload: {
          answers: [
            {
              question: 'Which rollout strategy do you prefer?',
              multiSelect: true,
              selectedOptions: [{ label: FULL_LABELS[0], number: 1 }],
              selectedLabels: [FULL_LABELS[0]],
            },
          ],
        },
      },
      ctx,
    )
    expect(result?.ok).toBe(false)
    expect(writes.filter(Boolean)).toEqual([])
  })
})
