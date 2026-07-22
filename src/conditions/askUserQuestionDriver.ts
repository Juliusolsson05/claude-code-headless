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

// Is the option's ON-SCREEN label prefix-consistent with the label the caller
// asked for? A wrapping option is kept by the TUI as only its first physical
// line, so the screen label is a hard-wrapped PREFIX of the real one (there is
// no text signal separating a wrapped label continuation from an option's dim
// description — verified live, they share the same fg color, so the parser
// cannot rejoin it). The caller's payload carries the FULL label from the
// semantic tool input, so exact equality could never match a wrapping option:
// answering it failed with `option-not-found` and zero keystrokes.
//
// Containment either direction: normally the caller's label is the longer,
// full one and the screen label is its prefix, but a caller that sends the
// already-truncated screen label (or a short whole label) must still match.
// The MIN_MATCH_CHARS floor keeps a trivially short prefix from being treated
// as prefix-consistent; below it only exact equality counts.
//
// This predicate is deliberately NOT the whole safety story. On its own it is
// AMBIGUOUS — two sibling options that share a long stem ("We should deploy to
// staging …") truncate to the same screen prefix, and both are prefix-
// consistent with either full label. `optionBySelection` below resolves that by
// requiring the match to be UNIQUE; this function only answers "could these be
// the same option?", never "are they, definitely?".
const MIN_MATCH_CHARS = 12
function labelsCorrespond(optionLabel: string, wanted: string): boolean {
  const a = normalizeLabel(optionLabel)
  const b = normalizeLabel(wanted)
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length < MIN_MATCH_CHARS) return false
  return longer.startsWith(shorter)
}

// Resolve the on-screen option a selection refers to, tolerating a truncated
// screen label but NEVER silently answering the wrong row.
//
// The invariant that carries safety is UNIQUENESS, not the number. Review of
// the first cut showed that leaning on `number` alone re-opened the exact hole
// the number pairing exists to guard: when the picker has diverged from the
// semantic ordering (the user answered in the raw terminal and the TUI
// advanced) AND the labels are prefix-related, trusting the number let the
// prefix test pass and answered the wrong option instead of failing closed. So
// every path here demands that exactly one option corresponds, and that the
// number — when present — agrees with it. If the screen text cannot single out
// one option, we fail closed and let the user answer in the terminal; a wrong
// answer is far worse than a retry.
function optionBySelection(
  state: AskUserQuestionState,
  selection: AnswerSelection,
): AskUserQuestionOption | null {
  const wanted = normalizeLabel(selection.label)

  const numberAgrees = (option: AskUserQuestionOption): boolean =>
    selection.number === undefined || option.number === selection.number

  // Exact equality first, and it is always unambiguous enough to prefer: a
  // short label rendered whole ("Enable caching") must resolve by equality even
  // when a sibling extends it ("Enable caching and compression"), which the
  // prefix path below would call ambiguous. Only fall to truncation tolerance
  // when nothing matches exactly.
  const exact = state.options.filter(option => normalizeLabel(option.label) === wanted)
  if (exact.length === 1) {
    // A number that disagrees with the exact-label row means the picker
    // renumbered under us — do not ride an exact label match onto a stale row.
    return numberAgrees(exact[0]) ? exact[0] : null
  }
  if (exact.length > 1) return null // duplicate labels — fail closed

  // Truncation-tolerant, but only when it is UNAMBIGUOUS: more than one
  // prefix-consistent option means the screen does not distinguish them and the
  // number cannot be trusted to (see the function docstring). Fail closed.
  const corresponding = state.options.filter(option => labelsCorrespond(option.label, wanted))
  if (corresponding.length !== 1) return null
  return numberAgrees(corresponding[0]) ? corresponding[0] : null
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
  // The parser can legitimately return `question: null` for some Claude
  // layouts. That is not enough identity to drive a structured answer. Returning
  // false keeps the resolver from applying "Yes"/"No" meant for one question to
  // a later, indistinguishable prompt after the user has interacted manually.
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
