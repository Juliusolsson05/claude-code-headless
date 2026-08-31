// claude-code-headless / conditions / trustDialogDriver.ts
//
// Multi-step driver that ACCEPTS Claude Code's folder-trust dialog by acting on
// the observed screen instead of an assumed layout.
//
// WHY A DRIVER AND NOT A KEYSTROKE (agent-code#705).
// --------------------------------------------------
// Accepting used to be the static pty string '\r', written on the assumption
// that CC pre-highlights "Yes, I trust this folder". Claude Code 2.1.251
// re-ordered the dialog and pre-highlights "No, exit", so that same Enter
// confirmed the exit option and terminated the CLI — the app's own Trust
// button became session-fatal, and because trust never persisted the dialog
// returned on every start. The only contract that survives upstream re-layouts
// is: read which row the `❯` pointer is on, move it to the affirmative row if
// needed, VERIFY the move on screen, and only then confirm.
//
// WHY FAIL-CLOSED EVERYWHERE: a wrong Enter here is not a cosmetic miss — it
// either kills the session (confirming "No, exit") or, if the dialog vanished
// a frame earlier, submits whatever sits in the main composer. Whenever the
// screen cannot PROVE where the highlight is, this driver refuses to write
// anything and returns a structured failure; the dialog stays up and the user
// can still act on the raw TUI.
//
// WHY THIS MIRRORS askUserQuestionDriver rather than sharing code with it:
// the hard part is provider UI knowledge (how CC paints THIS dialog and what
// proves a keystroke landed), not the loop mechanics. The AUQ driver's loop is
// entangled with pickers/multi-select/free-text; a shared abstraction would
// couple two unrelated screen contracts. Only the resolve(action, ctx) slot is
// shared, via conditions-core.

import {
  detectTrustDialog,
  TRUST_DIALOG_ACCEPT_LABEL,
  type TrustDialogState,
} from '../parsers/TrustDialogParser.js'
import type { DriveResult } from './askUserQuestionDriver.js'

// Structural subset of the ctx ClaudeCodeHeadless.resolveConditionAction
// assembles (it also carries `term`/`reparse` for the AUQ driver — this driver
// deliberately depends only on what it uses, so the two drivers can evolve
// their capabilities independently).
export type TrustDialogResolveCtx = {
  write: (data: string) => void
  snapshotPlain: () => string
  signal: AbortSignal
}

const ARROW_DOWN = '\x1b[B'
const ARROW_UP = '\x1b[A'
const ENTER = '\r'

// One press per write: CC's ink input tokenizer accumulates a run of bytes
// from one PTY read into one token, and we need each arrow (and the final
// Enter) processed as its own key — the same discipline promptDelivery's
// rollback learned for repeated Ctrl+U (agent-code PR #689).
const POLL_INTERVAL_MS = 25
// How long one arrow press may take to visibly move the highlight. Ink redraws
// a two-row select well under a frame; 1s absorbs a loaded machine.
const HIGHLIGHT_MOVE_TIMEOUT_MS = 1_000
// How long the dialog may take to leave the screen after a confirmed accept.
// Accepting triggers config writes plus a full-screen repaint into the main
// UI; 3s is generous without leaving a stuck resolver holding the
// condition-resolve-in-flight latch for long.
const DISMISS_TIMEOUT_MS = 3_000
// Upper bound on corrective presses. Today's dialogs have two rows, so one
// press always suffices; the bound exists so a future N-row layout (or a
// screen that stops repainting) degrades to a structured timeout instead of an
// arrow-key spam loop.
const MAX_ARROW_PRESSES = 4

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type Observed = {
  state: TrustDialogState
  targetIndex: number
  highlightedIndex: number
}

// Read the screen and reduce it to the two indexes the driver acts on.
// Returns a failure label instead of throwing so the loop below can convert
// each distinct "cannot prove" shape into its own failedAtStep.
function observe(ctx: TrustDialogResolveCtx):
  | { ok: true; value: Observed }
  | { ok: false; failedAtStep: string } {
  const state = detectTrustDialog(ctx.snapshotPlain())
  if (!state.visible) return { ok: false, failedAtStep: 'trust-dialog-not-visible' }
  const options = state.options ?? []
  const targetIndex = options.findIndex(o => o.label === TRUST_DIALOG_ACCEPT_LABEL)
  if (targetIndex === -1) return { ok: false, failedAtStep: 'trust-accept-option-missing' }
  const highlightedIndex = options.findIndex(o => o.highlighted)
  if (highlightedIndex === -1) return { ok: false, failedAtStep: 'trust-highlight-not-found' }
  return { ok: true, value: { state, targetIndex, highlightedIndex } }
}

function failure(
  reason: 'timeout' | 'aborted' | 'option-not-found',
  failedAtStep: string,
): DriveResult {
  // lastState is typed for the AUQ picker; trust has no picker state to report.
  return { ok: false, reason, lastState: null, failedAtStep }
}

/**
 * Accept the trust dialog: prove where the highlight is, walk it onto
 * "Yes, I trust this folder" (verifying every press), press Enter, and wait
 * for the dialog to leave the screen.
 *
 * Conforms to the AUQ DriveResult union so ClaudeCodeHeadless can return every
 * condition resolution through one shape: `option-not-found` covers every
 * "cannot prove the layout" refusal (failedAtStep carries the precise step),
 * `timeout` covers a screen that stops responding to verified keystrokes.
 */
export async function driveTrustDialogAccept(
  ctx: TrustDialogResolveCtx,
): Promise<DriveResult> {
  let presses = 0
  for (;;) {
    if (ctx.signal.aborted) return failure('aborted', 'trust-accept')
    const observed = observe(ctx)
    if (!observed.ok) return failure('option-not-found', observed.failedAtStep)
    const { targetIndex, highlightedIndex } = observed.value

    if (highlightedIndex === targetIndex) {
      ctx.write(ENTER)
      return waitForDismissal(ctx)
    }

    if (presses >= MAX_ARROW_PRESSES) {
      return failure('timeout', 'trust-highlight-not-reached')
    }
    // Direction from the OBSERVED row order — 2.1.251 lists No above Yes
    // (arrow down), the legacy layout listed Yes above No (arrow up if the
    // highlight ever sat on No). Deriving it per-press keeps this correct for
    // either order and for any future one.
    ctx.write(targetIndex > highlightedIndex ? ARROW_DOWN : ARROW_UP)
    presses++

    // Verify the press landed before deciding anything else. We wait for the
    // highlight to leave the row we saw it on (not specifically to reach the
    // target): each loop iteration re-derives direction, so all this step must
    // prove is that keystrokes are actually moving the pointer.
    const moved = await waitFor(ctx, snapshot => {
      const next = observe({ ...ctx, snapshotPlain: () => snapshot })
      return next.ok && next.value.highlightedIndex !== highlightedIndex
    }, HIGHLIGHT_MOVE_TIMEOUT_MS)
    if (moved === 'aborted') return failure('aborted', 'trust-highlight-move')
    if (moved === 'timeout') return failure('timeout', 'trust-highlight-move')
  }
}

async function waitForDismissal(ctx: TrustDialogResolveCtx): Promise<DriveResult> {
  const gone = await waitFor(
    ctx,
    snapshot => !detectTrustDialog(snapshot).visible,
    DISMISS_TIMEOUT_MS,
  )
  if (gone === 'aborted') return failure('aborted', 'trust-dismiss-confirm')
  if (gone === 'timeout') return failure('timeout', 'trust-dismiss-confirm')
  return { ok: true, state: null }
}

async function waitFor(
  ctx: TrustDialogResolveCtx,
  predicate: (snapshot: string) => boolean,
  timeoutMs: number,
): Promise<'ok' | 'timeout' | 'aborted'> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (ctx.signal.aborted) return 'aborted'
    if (predicate(ctx.snapshotPlain())) return 'ok'
    if (Date.now() >= deadline) return 'timeout'
    await sleep(POLL_INTERVAL_MS)
  }
}
