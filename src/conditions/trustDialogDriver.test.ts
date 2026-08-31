// trustDialogDriver — accept must act on the OBSERVED highlight, never on an
// assumed layout (agent-code#705).
//
// The harness below is a tiny scripted trust dialog: it renders the same row
// shapes the real 2.1.251 / legacy dialogs paint and moves its highlight in
// response to the exact bytes the driver writes. The assertions are on the
// WRITE SEQUENCE, not just the outcome, because the defect being fenced was a
// byte ('\r') written while "No, exit" carried the pointer — an outcome-only
// test against a fake could simulate its way past that.

import { describe, expect, it } from 'vitest'

import {
  driveTrustDialogAccept,
  type TrustDialogResolveCtx,
} from './trustDialogDriver.js'
import { trustDialogModule, TRUST_DIALOG_ACCEPT_RESOLVER } from './trustDialog.js'

const ARROW_DOWN = '\x1b[B'
const ARROW_UP = '\x1b[A'

type FakeDialogOptions = {
  /** Row labels in on-screen order. */
  rows: string[]
  highlightedIndex: number
  /** When true, arrow presses are ignored (a wedged repaint). */
  frozen?: boolean
  /** When true, Enter never dismisses the dialog. */
  stickyDismiss?: boolean
}

function makeFakeDialog(options: FakeDialogOptions) {
  const writes: string[] = []
  let highlighted = options.highlightedIndex
  let dismissed = false

  const render = (): string => {
    if (dismissed) return ' ⏺ ready\n' // any dialog-free frame
    const rows = options.rows.map((label, index) =>
      `${index === highlighted ? ' ❯ ' : '   '}${label}`)
    return [
      ' Accessing workspace:',
      '',
      ' /tmp/fake-project',
      '',
      ' Quick safety check',
      '',
      ...rows,
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n')
  }

  const ctx: TrustDialogResolveCtx = {
    write: data => {
      writes.push(data)
      if (options.frozen) return
      if (data === ARROW_DOWN) highlighted = Math.min(highlighted + 1, options.rows.length - 1)
      if (data === ARROW_UP) highlighted = Math.max(highlighted - 1, 0)
      if (data === '\r' && !options.stickyDismiss) dismissed = true
    },
    snapshotPlain: render,
    signal: new AbortController().signal,
  }

  return { ctx, writes, confirmedLabel: () => options.rows[highlighted] }
}

describe('driveTrustDialogAccept', () => {
  it('2.1.251 layout: walks the highlight off "No, exit" before confirming', async () => {
    const fake = makeFakeDialog({
      rows: ['No, exit', 'Yes, I trust this folder'],
      highlightedIndex: 0,
    })
    const result = await driveTrustDialogAccept(fake.ctx)
    expect(result).toEqual({ ok: true, state: null })
    expect(fake.writes).toEqual([ARROW_DOWN, '\r'])
    // The defect, stated directly: the first byte is never Enter while the
    // exit row holds the pointer.
    expect(fake.writes[0]).not.toBe('\r')
    expect(fake.confirmedLabel()).toBe('Yes, I trust this folder')
  })

  it('legacy layout: confirms immediately when Yes already holds the pointer', async () => {
    const fake = makeFakeDialog({
      rows: ['Yes, I trust this folder', 'No, exit'],
      highlightedIndex: 0,
    })
    const result = await driveTrustDialogAccept(fake.ctx)
    expect(result).toEqual({ ok: true, state: null })
    expect(fake.writes).toEqual(['\r'])
  })

  it('walks upward when a layout puts Yes above a highlighted No', async () => {
    const fake = makeFakeDialog({
      rows: ['Yes, I trust this folder', 'No, exit'],
      highlightedIndex: 1,
    })
    const result = await driveTrustDialogAccept(fake.ctx)
    expect(result).toEqual({ ok: true, state: null })
    expect(fake.writes).toEqual([ARROW_UP, '\r'])
  })

  it('refuses to write anything when no highlight is provable', async () => {
    const fake = makeFakeDialog({
      rows: ['No, exit', 'Yes, I trust this folder'],
      highlightedIndex: -1, // renders no pointer row
    })
    const result = await driveTrustDialogAccept(fake.ctx)
    expect(result).toMatchObject({
      ok: false,
      reason: 'option-not-found',
      failedAtStep: 'trust-highlight-not-found',
    })
    expect(fake.writes).toEqual([])
  })

  it('refuses to write when the dialog is not on screen', async () => {
    const ctx: TrustDialogResolveCtx = {
      write: () => {
        throw new Error('must not write into a dialog-free screen')
      },
      snapshotPlain: () => ' ⏺ ready\n',
      signal: new AbortController().signal,
    }
    const result = await driveTrustDialogAccept(ctx)
    expect(result).toMatchObject({
      ok: false,
      reason: 'option-not-found',
      failedAtStep: 'trust-dialog-not-visible',
    })
  })

  it('degrades to a structured timeout — never Enter — when arrows stop moving the pointer', async () => {
    const fake = makeFakeDialog({
      rows: ['No, exit', 'Yes, I trust this folder'],
      highlightedIndex: 0,
      frozen: true,
    })
    const result = await driveTrustDialogAccept(fake.ctx)
    expect(result).toMatchObject({
      ok: false,
      reason: 'timeout',
      failedAtStep: 'trust-highlight-move',
    })
    expect(fake.writes).toEqual([ARROW_DOWN])
    expect(fake.writes).not.toContain('\r')
  }, 10_000)

  it('reports a timeout when the dialog never leaves the screen after Enter', async () => {
    const fake = makeFakeDialog({
      rows: ['Yes, I trust this folder', 'No, exit'],
      highlightedIndex: 0,
      stickyDismiss: true,
    })
    const result = await driveTrustDialogAccept(fake.ctx)
    expect(result).toMatchObject({
      ok: false,
      reason: 'timeout',
      failedAtStep: 'trust-dismiss-confirm',
    })
    expect(fake.writes).toEqual(['\r'])
  }, 10_000)
})

describe('trustDialogModule action wiring', () => {
  it('exposes accept as the custom resolver action and decline as Esc', () => {
    const actions = trustDialogModule.actions({ visible: true })
    expect(actions).toEqual([
      {
        kind: 'custom',
        id: 'accept',
        label: 'Yes, I trust this folder',
        name: TRUST_DIALOG_ACCEPT_RESOLVER,
      },
      { kind: 'pty', id: 'decline', label: 'No, exit', data: '\x1b' },
    ])
  })

  it('resolves only its own action name', () => {
    const foreign = trustDialogModule.resolve?.(
      { kind: 'custom', id: 'x', label: 'x', name: 'claude.ask-user-question.answer' },
      {
        write: () => undefined,
        snapshotPlain: () => '',
        signal: new AbortController().signal,
      },
    )
    expect(foreign).toBeUndefined()
  })
})
