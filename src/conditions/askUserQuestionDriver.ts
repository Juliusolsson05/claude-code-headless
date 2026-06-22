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
      reason: 'timeout' | 'aborted' | 'invalid-payload' | 'option-not-found'
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
    return true
  })
}

function optionByLabel(
  state: AskUserQuestionState,
  label: string,
): AskUserQuestionOption | null {
  const wanted = normalizeLabel(label)
  return state.options.find(option => normalizeLabel(option.label) === wanted) ?? null
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
  if (stateQuestion && stateQuestion !== answerQuestion) return false
  if (answer.header && state.header) {
    return normalizeLabel(answer.header) === normalizeLabel(state.header)
  }
  return true
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
): Promise<DriveResult> {
  // WHY "changed question OR disappeared" is the settle condition:
  // AskUserQuestion is transcript-backed in the feed, but the TUI only shows one
  // question at a time. After an answer, Claude either advances to the next
  // question or closes the picker entirely. Waiting for either avoids hardcoding
  // a question count into the screen driver and lets the parser remain the
  // source of truth for what is physically live.
  return sendThenReparse(
    ctx,
    '',
    state =>
      state === null ||
      state.question !== previous.question ||
      state.header !== previous.header ||
      state.options.map(o => o.label).join('\u0000') !==
        previous.options.map(o => o.label).join('\u0000'),
    { failedAtStep: step },
  )
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
): Promise<DriveResult> {
  if (answer.text && state.otherNumber !== null) {
    const opened = await sendThenReparse(
      ctx,
      String(state.otherNumber),
      // Claude currently replaces the picker with a text-entry surface that the
      // AUQ parser does not model. Treat either "picker disappeared" or "same
      // picker no longer matches" as enough to write the text. This is bounded
      // by timeout, so a future UI change degrades to a structured failure
      // instead of spraying text into an unrelated prompt indefinitely.
      next => next === null || !sameQuestion(next, answer),
      { failedAtStep: 'open-free-text', timeoutMs: 700 },
    )
    if (!opened.ok) return opened
    ctx.write(`${answer.text}\r`)
    return waitForAdvance(ctx, state, 'submit-free-text')
  }

  const label = answer.selectedLabels?.[0]
  if (!label) {
    return {
      ok: false,
      reason: 'invalid-payload',
      lastState: state,
      failedAtStep: 'single-missing-selection',
    }
  }
  const option = optionByLabel(state, label)
  if (!option) {
    return {
      ok: false,
      reason: 'option-not-found',
      lastState: state,
      failedAtStep: `single-option:${label}`,
    }
  }
  ctx.write(String(option.number))
  return waitForAdvance(ctx, state, `single-answer:${label}`)
}

async function driveMulti(
  ctx: AskUserQuestionResolveCtx,
  state: AskUserQuestionState,
  answer: AskUserQuestionAnswer,
): Promise<DriveResult> {
  const selected = new Set((answer.selectedLabels ?? []).map(normalizeLabel))
  let current: AskUserQuestionState | null = state
  for (const option of state.options) {
    if (state.otherNumber !== null && option.number === state.otherNumber) continue
    const desired = selected.has(normalizeLabel(option.label))
    const actual = optionToggled(current ?? state, option.number)
    if (actual === desired) continue
    const toggled = await sendThenReparse(
      ctx,
      String(option.number),
      next => optionToggled(next ?? state, option.number) === desired,
      { failedAtStep: `toggle:${option.label}` },
    )
    if (!toggled.ok) return toggled
    current = toggled.state
  }

  if (answer.text && state.otherNumber !== null) {
    const opened = await sendThenReparse(
      ctx,
      String(state.otherNumber),
      next => next === null || !sameQuestion(next, answer),
      { failedAtStep: 'multi-open-free-text', timeoutMs: 700 },
    )
    if (!opened.ok) return opened
    ctx.write(`${answer.text}\r`)
    return waitForAdvance(ctx, state, 'multi-submit-free-text')
  }

  const focused = await focusSubmit(ctx, current ?? state)
  if (!focused.ok) return focused
  ctx.write('\r')
  return waitForAdvance(ctx, state, 'submit-multi')
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
  for (const answer of action.payload.answers) {
    if (ctx.signal.aborted) {
      return { ok: false, reason: 'aborted', lastState: state, failedAtStep: 'abort' }
    }
    if (!state) return { ok: true, state }
    if (!sameQuestion(state, answer)) {
      const waited = await sendThenReparse(
        ctx,
        '',
        next => next === null || sameQuestion(next, answer),
        { failedAtStep: `wait-question:${answer.question}` },
      )
      if (!waited.ok) return waited
      state = waited.state
      if (!state) return { ok: true, state }
    }
    const driven =
      state.mode === 'multi' || answer.multiSelect
        ? await driveMulti(ctx, state, answer)
        : await driveSingle(ctx, state, answer)
    if (!driven.ok) return driven
    state = driven.state
  }

  return { ok: true, state: ctx.reparse() }
}
