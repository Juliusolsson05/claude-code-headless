// claude-code-headless / conditions / askUserQuestionDriver.ts
//
// Multi-step driver for Claude Code's AskUserQuestion TUI picker.
//
// WHY this is provider-local instead of conditions-core:
//   The hard part here is not "run a list of actions"; it is knowing how THIS
//   provider paints THIS picker and which screen state proves a keystroke had
//   the intended effect. Multi-select toggles, the free-text row, and
//   multi-question auto-advance are Claude Code UI contracts. Baking those into
//   conditions-core would turn the generic framework back into a grab bag of
//   provider special cases. Core only supplies the `resolve(action, ctx)` slot;
//   this file owns the Claude-specific driving policy.

import xtermHeadless from '@xterm/headless'

import type { ConditionCustomAction } from './core/contract.js'
import type {
  AskUserQuestionOption,
  AskUserQuestionState,
} from '../parsers/AskUserQuestionParser.js'

const { Terminal } = xtermHeadless
type TerminalInstance = InstanceType<typeof Terminal>

export type AskUserQuestionResolveCtx = {
  write: (data: string) => void
  term: () => TerminalInstance
  snapshotPlain: () => string
  reparse: () => AskUserQuestionState | null
  signal: AbortSignal
}

export type AskUserQuestionAnswer = {
  question: string
  header?: string
  multiSelect?: boolean
  selectedOptions?: Array<{
    label: string
    number?: number
  }>
  selectedLabels?: string[]
  text?: string
}

export type AskUserQuestionResolvePayload = {
  answers: AskUserQuestionAnswer[]
}

export type DriveResult =
  | { ok: true; state: AskUserQuestionState | null }
  | {
      ok: false
      reason:
        | 'timeout'
        | 'aborted'
        | 'invalid-payload'
        | 'option-not-found'
        | 'no-resolver'
      lastState: AskUserQuestionState | null
      failedAtStep: string
    }

type SendThenReparseOptions = {
  timeoutMs?: number
  pollIntervalMs?: number
  failedAtStep: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isPayload(value: unknown): value is AskUserQuestionResolvePayload {
  if (!value || typeof value !== 'object') return false
  const rec = value as { answers?: unknown }
  if (!Array.isArray(rec.answers)) return false
  return rec.answers.every(answer => {
    if (!answer || typeof answer !== 'object') return false
    const a = answer as Record<string, unknown>
    if (typeof a.question !== 'string') return false
    if (a.header !== undefined && typeof a.header !== 'string') return false
    if (a.multiSelect !== undefined && typeof a.multiSelect !== 'boolean') return false
    if (a.text !== undefined && typeof a.text !== 'string') return false
    if (
      a.selectedLabels !== undefined &&
      (!Array.isArray(a.selectedLabels) ||
        !a.selectedLabels.every(label => typeof label === 'string'))
    ) return false
    if (
      a.selectedOptions !== undefined &&
      (!Array.isArray(a.selectedOptions) ||
        !a.selectedOptions.every(option => {
          if (!option || typeof option !== 'object') return false
          const o = option as Record<string, unknown>
          if (typeof o.label !== 'string') return false
          return o.number === undefined || typeof o.number === 'number'
        }))
    ) return false
    return true
  })
}

type AnswerSelection = {
  label: string
  number?: number
}

function answerSelections(answer: AskUserQuestionAnswer): AnswerSelection[] {
  if (answer.selectedOptions?.length) return answer.selectedOptions
  return (answer.selectedLabels ?? []).map(label => ({ label }))
}

function optionBySelection(
  state: AskUserQuestionState,
  selection: AnswerSelection,
): AskUserQuestionOption | null {
  const wanted = normalizeLabel(selection.label)
  if (selection.number !== undefined) {
    const byNumber = state.options.find(option => option.number === selection.number)
    // WHY verify the label even when the renderer sends a number:
    // the number is only safe for the CURRENT live picker. If the user already
    // answered in the raw terminal and the TUI advanced, "2" may now mean an
    // entirely different option. Pairing number with label lets us use the number
    // to disambiguate duplicate labels without blindly trusting stale semantics.
    if (byNumber && normalizeLabel(byNumber.label) === wanted) return byNumber
    // The number is a HINT, not an identity, and a failed hint must fall through
    // to label matching rather than fail the whole answer.
    //
    // AskUserQuestionRow sends `q.options.indexOf(option) + 1` — a SEMANTIC
    // index into the transcript payload. This function resolves it against the
    // SCREEN's numbering. Those agree in the simple case and diverge whenever
    // Claude's picker numbers differently from the tool input (the injected
    // "Type something" row, multi-question screens that renumber, any future
    // reordering). On divergence the old code returned null, which surfaced as
    // `option-not-found` and a dead, unclickable row — a false negative on a
    // perfectly valid answer.
    //
    // Falling back to the label keeps the safety property that matters: the
    // label is what the user actually chose, and the duplicate-label guard
    // below still fails closed when it is ambiguous.
  }

  const matches = state.options.filter(option => normalizeLabel(option.label) === wanted)
  // Legacy payloads only carried labels. A single match remains supported, but
  // duplicate labels must fail closed: choosing the first duplicate is worse than
  // asking the user to retry through the terminal because it silently submits the
  // wrong row.
  return matches.length === 1 ? matches[0] : null
}

function optionToggled(
  state: AskUserQuestionState,
  number: number,
): boolean | null {
  const option = state.options.find(candidate => candidate.number === number)
  if (!option || option.toggled === undefined) return null
  return option.toggled
}

function sameQuestion(
  state: AskUserQuestionState,
  answer: AskUserQuestionAnswer,
): boolean {
  const stateQuestion = state.question ? normalizeLabel(state.question) : ''
  const answerQuestion = normalizeLabel(answer.question)
  if (stateQuestion) {
    const questionMatches =
      stateQuestion === answerQuestion ||
      (stateQuestion.length >= 12 && answerQuestion.startsWith(stateQuestion)) ||
      (answerQuestion.length >= 12 && stateQuestion.startsWith(answerQuestion))
    if (!questionMatches) return false
    // If the question text itself identifies the current screen, do not let a
    // noisy multi-question nav header veto it. Claude can render sibling tabs in
    // the same header row ("Season  ☐ Relax"), while the semantic payload only
    // carries the active answer's header ("Season"). The question text is the
    // stronger invariant: applying "Spring" to a different visible question is
    // unsafe, but accepting the exact visible question despite extra nav chrome
    // is the intended multi-question path.
    if (stateQuestion === answerQuestion) return true
    return (
      !answer.header ||
      !state.header ||
      normalizeLabel(answer.header) === normalizeLabel(state.header)
    )
  }
  if (answer.header && state.header) {
    return normalizeLabel(answer.header) === normalizeLabel(state.header)
  }
  // Last resort: match on the OPTION SET.
  //
  // The parser legitimately returns `question: null` for some layouts (the
  // question region only opens after a header chip is seen), and it now
  // deliberately returns `header: null` for multi-chip nav bars. When BOTH are
  // null the old code returned false unconditionally, so the driver fell into
  // sendThenReparse and died at `wait-question:<q>` — the timeout that has been
  // chased through several revisions of this file.
  //
  // A screen whose visible options are exactly the options the caller intends
  // to answer IS the question, for our purposes: the answer we are about to
  // give is expressible on this screen and means the same thing. This is
  // strictly narrower than "give up and press keys anyway" — a different
  // question with different options still fails closed, which is the property
  // that keeps "Yes" for one prompt off a later one.
  const answerLabels = answerSelections(answer)
    .map(selection => normalizeLabel(selection.label))
    .filter(label => label.length > 0)
  if (answerLabels.length > 0) {
    const screenLabels = new Set(state.options.map(option => normalizeLabel(option.label)))
    if (answerLabels.every(label => screenLabels.has(label))) return true
  }

  return false
}

function sameScreenQuestion(
  current: AskUserQuestionState,
  previous: AskUserQuestionState,
): boolean {
  const currentQuestion = current.question ? normalizeLabel(current.question) : ''
  const previousQuestion = previous.question ? normalizeLabel(previous.question) : ''
  if (currentQuestion || previousQuestion) {
    return currentQuestion === previousQuestion
  }
  const currentHeader = current.header ? normalizeLabel(current.header) : ''
  const previousHeader = previous.header ? normalizeLabel(previous.header) : ''
  if (currentHeader || previousHeader) {
    return currentHeader === previousHeader
  }
  return (
    current.options.map(o => normalizeLabel(o.label)).join('\u0000') ===
    previous.options.map(o => normalizeLabel(o.label)).join('\u0000')
  )
}

function sanitizeFreeText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
}

function singleDigitForOption(option: AskUserQuestionOption): string | null {
  return singleDigitForNumber(option.number)
}

function singleDigitForNumber(number: number): string | null {
  return number >= 1 && number <= 9 ? String(number) : null
}

async function sendThenReparse(
  ctx: AskUserQuestionResolveCtx,
  keys: string,
  predicate: (state: AskUserQuestionState | null) => boolean,
  opts: SendThenReparseOptions,
): Promise<DriveResult> {
  const timeoutMs = opts.timeoutMs ?? 1_500
  const pollIntervalMs = opts.pollIntervalMs ?? 20
  const startedAt = Date.now()
  ctx.write(keys)

  let lastState: AskUserQuestionState | null = ctx.reparse()
  while (Date.now() - startedAt < timeoutMs) {
    if (ctx.signal.aborted) {
      return {
        ok: false,
        reason: 'aborted',
        lastState,
        failedAtStep: opts.failedAtStep,
      }
    }
    lastState = ctx.reparse()
    if (predicate(lastState)) return { ok: true, state: lastState }
    await sleep(pollIntervalMs)
  }

  return {
    ok: false,
    reason: 'timeout',
    lastState,
    failedAtStep: opts.failedAtStep,
  }
}

async function waitForAdvance(
  ctx: AskUserQuestionResolveCtx,
  previous: AskUserQuestionState,
  step: string,
  allowClose: boolean,
): Promise<DriveResult> {
  // WHY "changed question" and "closed picker" are separated:
  // AskUserQuestion is transcript-backed in the feed, but the TUI only shows one
  // question at a time. After an answer, Claude either advances to the next
  // question or closes the picker entirely. A transient blank frame parses as
  // null during repaint, so null is only success when the semantic payload says
  // this was the LAST answer. For non-last answers we require a positive next
  // picker observation; otherwise a one-frame null would drop the remaining
  // questions while reporting success.
  return sendThenReparse(
    ctx,
    '',
    state =>
      allowClose
        ? state === null || (state !== null && !sameScreenQuestion(state, previous))
        : state !== null && !sameScreenQuestion(state, previous),
    { failedAtStep: step },
  )
}

async function waitForStableTextEntry(
  ctx: AskUserQuestionResolveCtx,
  keys: string,
  step: string,
): Promise<DriveResult> {
  const timeoutMs = 900
  const pollIntervalMs = 30
  const startedAt = Date.now()
  let nullReads = 0
  let lastState: AskUserQuestionState | null = ctx.reparse()
  ctx.write(keys)

  while (Date.now() - startedAt < timeoutMs) {
    if (ctx.signal.aborted) {
      return { ok: false, reason: 'aborted', lastState, failedAtStep: step }
    }
    lastState = ctx.reparse()
    if (lastState === null) {
      nullReads += 1
      // The text-entry surface is currently outside the AUQ parser's modeled
      // state, so "stable absence" is the only screen proof we have. Require
      // several consecutive null parses before writing user text; a single null
      // is just as likely to be Claude repainting the numbered picker.
      if (nullReads >= 3) return { ok: true, state: null }
    } else {
      nullReads = 0
    }
    await sleep(pollIntervalMs)
  }

  return { ok: false, reason: 'timeout', lastState, failedAtStep: step }
}

async function focusSubmit(
  ctx: AskUserQuestionResolveCtx,
  state: AskUserQuestionState,
): Promise<DriveResult> {
  let current: AskUserQuestionState | null = state
  const maxMoves = state.options.length + 3
  for (let i = 0; i < maxMoves; i++) {
    if (current?.submitFocused) return { ok: true, state: current }
    const result = await sendThenReparse(
      ctx,
      '\x1b[B',
      next => next?.submitFocused === true,
      { failedAtStep: 'focus-submit', timeoutMs: 400 },
    )
    if (result.ok) return result
    current = result.lastState
    if (result.reason === 'aborted') return result
  }
  return {
    ok: false,
    reason: 'timeout',
    lastState: current,
    failedAtStep: 'focus-submit',
  }
}

async function driveSingle(
  ctx: AskUserQuestionResolveCtx,
  state: AskUserQuestionState,
  answer: AskUserQuestionAnswer,
  allowClose: boolean,
): Promise<DriveResult> {
  if (answer.text && state.otherNumber !== null) {
    const text = sanitizeFreeText(answer.text)
    if (!text) {
      return {
        ok: false,
        reason: 'invalid-payload',
        lastState: state,
        failedAtStep: 'free-text-empty',
      }
    }
    const otherKey = singleDigitForNumber(state.otherNumber)
    if (!otherKey) {
      return {
        ok: false,
        reason: 'option-not-found',
        lastState: state,
        failedAtStep: 'free-text-option-number',
      }
    }
    const opened = await waitForStableTextEntry(ctx, otherKey, 'open-free-text')
    if (!opened.ok) return opened
    ctx.write(`${text}\r`)
    return waitForAdvance(ctx, state, 'submit-free-text', allowClose)
  }

  const selection = answerSelections(answer)[0]
  if (!selection) {
    return {
      ok: false,
      reason: 'invalid-payload',
      lastState: state,
      failedAtStep: 'single-missing-selection',
    }
  }
  const option = optionBySelection(state, selection)
  if (!option) {
    return {
      ok: false,
      reason: 'option-not-found',
      lastState: state,
      failedAtStep: `single-option:${selection.label}`,
    }
  }
  const key = singleDigitForOption(option)
  if (!key) {
    return {
      ok: false,
      reason: 'option-not-found',
      lastState: state,
      failedAtStep: `single-option-number:${option.number}`,
    }
  }
  ctx.write(key)
  return waitForAdvance(ctx, state, `single-answer:${selection.label}`, allowClose)
}

async function driveMulti(
  ctx: AskUserQuestionResolveCtx,
  state: AskUserQuestionState,
  answer: AskUserQuestionAnswer,
  allowClose: boolean,
): Promise<DriveResult> {
  const selectedNumbers = new Set<number>()
  const selectedLabels = new Set<string>()
  for (const selection of answerSelections(answer)) {
    const option = optionBySelection(state, selection)
    if (!option) {
      return {
        ok: false,
        reason: 'option-not-found',
        lastState: state,
        failedAtStep: `multi-option:${selection.label}`,
      }
    }
    selectedNumbers.add(option.number)
    selectedLabels.add(normalizeLabel(option.label))
  }
  let current: AskUserQuestionState | null = state
  for (const option of state.options) {
    if (state.otherNumber !== null && option.number === state.otherNumber) continue
    const desired =
      selectedNumbers.has(option.number) ||
      selectedLabels.has(normalizeLabel(option.label))
    const actual = optionToggled(current ?? state, option.number)
    if (actual === desired) continue
    const key = singleDigitForOption(option)
    if (!key) {
      return {
        ok: false,
        reason: 'option-not-found',
        lastState: current,
        failedAtStep: `toggle-option-number:${option.number}`,
      }
    }
    const toggled = await sendThenReparse(
      ctx,
      key,
      next => optionToggled(next ?? state, option.number) === desired,
      { failedAtStep: `toggle:${option.label}` },
    )
    if (!toggled.ok) return toggled
    current = toggled.state
  }

  if (answer.text && state.otherNumber !== null) {
    const text = sanitizeFreeText(answer.text)
    if (!text) {
      return {
        ok: false,
        reason: 'invalid-payload',
        lastState: current ?? state,
        failedAtStep: 'multi-free-text-empty',
      }
    }
    const otherKey = singleDigitForNumber(state.otherNumber)
    if (!otherKey) {
      return {
        ok: false,
        reason: 'option-not-found',
        lastState: current ?? state,
        failedAtStep: 'multi-free-text-option-number',
      }
    }
    const opened = await waitForStableTextEntry(ctx, otherKey, 'multi-open-free-text')
    if (!opened.ok) return opened
    ctx.write(`${text}\r`)
    return waitForAdvance(ctx, state, 'multi-submit-free-text', allowClose)
  }

  const focused = await focusSubmit(ctx, current ?? state)
  if (!focused.ok) return focused
  ctx.write('\r')
  return waitForAdvance(ctx, state, 'submit-multi', allowClose)
}

export function resolveAskUserQuestionAction(
  action: ConditionCustomAction,
  ctx: AskUserQuestionResolveCtx,
): Promise<DriveResult> | undefined {
  if (action.name !== 'claude.askUserQuestion.answer') return undefined
  return resolveAskUserQuestionAnswer(action, ctx)
}

async function resolveAskUserQuestionAnswer(
  action: ConditionCustomAction,
  ctx: AskUserQuestionResolveCtx,
): Promise<DriveResult> {
  if (!isPayload(action.payload)) {
    return {
      ok: false,
      reason: 'invalid-payload',
      lastState: ctx.reparse(),
      failedAtStep: 'payload',
    }
  }

  let state = ctx.reparse()
  for (let index = 0; index < action.payload.answers.length; index++) {
    const answer = action.payload.answers[index]
    const isLastAnswer = index === action.payload.answers.length - 1
    if (ctx.signal.aborted) {
      return { ok: false, reason: 'aborted', lastState: state, failedAtStep: 'abort' }
    }
    if (!state) {
      return {
        ok: false,
        reason: 'timeout',
        lastState: state,
        failedAtStep: `missing-picker:${answer.question}`,
      }
    }
    if (!sameQuestion(state, answer)) {
      const waited = await sendThenReparse(
        ctx,
        '',
        next => next !== null && sameQuestion(next, answer),
        { failedAtStep: `wait-question:${answer.question}` },
      )
      if (!waited.ok) return waited
      state = waited.state
      if (!state) {
        return {
          ok: false,
          reason: 'timeout',
          lastState: state,
          failedAtStep: `wait-question-missing:${answer.question}`,
        }
      }
    }
    const driven =
      state.mode === 'multi' || answer.multiSelect
        ? await driveMulti(ctx, state, answer, isLastAnswer)
        : await driveSingle(ctx, state, answer, isLastAnswer)
    if (!driven.ok) return driven
    state = driven.state
  }

  return { ok: true, state: ctx.reparse() }
}
