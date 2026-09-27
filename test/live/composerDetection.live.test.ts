import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node-pty'
import { describe, expect, it } from 'vitest'

import { HeadlessTerminal } from '../../src/terminal/HeadlessTerminal.js'
import { parseClaudeComposerState } from '../../src/parsers/ScreenParser.js'
import { driveTrustDialogAccept } from '../../src/conditions/trustDialogDriver.js'
import { detectTrustDialog } from '../../src/parsers/TrustDialogParser.js'
import { createLiveClaudeCwd } from '../support/claudeLiveResidue.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// WHY this test exists, and why it is NOT in the default suite:
//
// Every other composer test feeds strings or escape sequences we wrote
// ourselves, so collectively they can only prove we handle the renderings
// somebody already imagined. The bug this file guards against was upstream
// DRIFT: Claude Code started painting prompt suggestions into the composer as
// dimmed placeholder text, and a parser that classified unknown text as a human
// draft locked the prompt gate permanently. No fixture-based test could have
// caught that, because the fixture would have been written from the old
// rendering.
//
// Only running the real CLI can detect the next such change. That costs auth, a
// network round trip and ~60s, so it lives in the `.live` tier
// (vitest.live.config.ts, `npm run test:live`) and is excluded from CI. Run it
// deliberately — in particular after upgrading Claude Code.
//
// The invariant under test is structural, not textual: upstream renders every
// placeholder via chalk.dim and ONLY when the composer value is empty
// (vendor/claude-code-src/full/hooks/renderPlaceholder.ts:33-45). So whatever
// words Claude decides to show, dim content must classify as `empty` and typed
// characters must classify as `drafted`.
describe('live composer detection', () => {
  it('classifies real placeholders as empty and real typing as drafted', async () => {
    // Not a bare mkdtemp (#1329): that left a trust entry, a transcript and
    // the cwd in the developer's real Claude home on every run. See
    // test/support/claudeLiveResidue.ts for why this placement adds no NEW
    // trust entry after the first run in a checkout family, and how the
    // transcript is removed.
    const live = createLiveClaudeCwd({ packageRoot })
    const cwd = live.cwd
    const term = new HeadlessTerminal({
      // A PTY we own directly, so this bypasses attach() and drives the
      // terminal the same way writeForTest does in the unit tests.
      pty: { onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }) } as never,
      cols: 120,
      rows: 40,
    })
    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
    const classify = (): string =>
      parseClaudeComposerState(term.snapshotPlain(), term.snapshotComposerAttributes())

    // Spawned inside the try (review of #68, a): a spawn failure used to
    // throw before it and leave the cwd behind.
    let pty: ReturnType<typeof spawn> | null = null
    let exited = false
    try {
      pty = spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', 'claude'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      })
      pty.onData(d => void term.writeForTest(d))
      pty.onExit(() => { exited = true })
      // The folder-trust dialog, when Claude shows it, is answered by the
      // PRODUCT's own fail-closed driver (src/conditions/trustDialogDriver.ts):
      // it proves which row is highlighted, walks onto "Yes, I trust this
      // folder" verifying every press, and only then presses Enter. The first
      // version here pressed Enter after three blind Down presses, which could
      // confirm "No, exit" (review of #68, b), and as of 2026-09-27 the dialog
      // lists and preselects "No, exit" first. Using the driver also makes this
      // canary a live check of it. Trust is saved once per git root; see
      // test/support/claudeLiveResidue.ts.
      for (let i = 0; i < 20; i++) {
        if (detectTrustDialog(term.snapshotPlain()).visible) {
          const accepted = await driveTrustDialogAccept({
            write: data => pty!.write(data),
            snapshotPlain: () => term.snapshotPlain(),
            signal: AbortSignal.timeout(30_000),
          })
          expect(accepted).toMatchObject({ ok: true })
          break
        }
        if (/─{10}/.test(term.snapshotPlain())) break
        await sleep(1000)
      }
      // Wait for the composer box (a divider rule) to paint.
      for (let i = 0; i < 25 && !/─{10}/.test(term.snapshotPlain()); i++) await sleep(1000)

      // Unconditional: extraction itself must work. Without this the test
      // passes even if snapshotComposerAttributes() returns null forever, since
      // a bare `❯` classifies 'empty' through the string fallback too — i.e.
      // total extraction failure would look identical to success.
      expect(term.snapshotComposerAttributes()).not.toBeNull()
      expect(classify()).toBe('empty')

      pty.write('this is a real human draft')
      await sleep(2500)
      expect(term.snapshotComposerAttributes()!.plain).toBeGreaterThan(0)
      expect(classify()).toBe('drafted')

      for (let i = 0; i < 80; i++) pty.write('\x7f')
      await sleep(1000)
      expect(classify()).toBe('empty')

      // Run a turn so Claude offers a prompt suggestion afterwards. It renders
      // that suggestion as a dim placeholder over an EMPTY composer, which is
      // the exact regression: arbitrary model prose that must NOT read as a
      // draft.
      //
      // Polled rather than sampled once: a single fixed sleep races the
      // streaming turn, so a slow reply — not the absence of a suggestion —
      // was the likely reason to miss it.
      pty.write('count slowly from 1 to 30, one number per line\r')
      let sawDimPlaceholder = false
      for (let i = 0; i < 45; i++) {
        const polled = term.snapshotComposerAttributes()
        if (polled && polled.dim > 0) {
          sawDimPlaceholder = true
          // Visible text over an empty composer: the pre-fix parser called this
          // 'drafted' and blocked delivery indefinitely.
          expect(polled.plain).toBe(0)
          expect(classify()).toBe('empty')
          break
        }
        await sleep(1000)
      }
      if (!sawDimPlaceholder) {
        // Deliberately NOT a failure. A placeholder needs Claude to actually
        // offer a suggestion, and an empty composer does not always carry one
        // (the scratch cwd sits inside the package's git repo, so example
        // commands are possible but not guaranteed). Asserting it would make
        // the canary flaky for a reason unrelated to drift. Say so loudly instead, so a run never
        // implies coverage it did not provide.
        console.warn(
          '[live] no dim placeholder appeared this run; the placeholder assertion did not execute',
        )
      }
    } finally {
      // Wait for Claude to exit before removing its transcript directory, or
      // a late write recreates it after cleanup. node-pty's plain kill() sends
      // SIGHUP on Unix; if Claude has not exited, SIGKILL follows. Windows
      // rejects an explicit signal (node-pty's windowsTerminal), so there the
      // plain kill is repeated instead. The cleanup sits in its own `finally`
      // so an escalation that throws can never skip it (review of #68,
      // round 2, b), and it SAYS when Claude outlived the wait.
      try {
        if (pty) {
          pty.kill()
          for (let i = 0; i < 100 && !exited; i++) await sleep(100)
          if (!exited) {
            if (process.platform === 'win32') pty.kill()
            else pty.kill('SIGKILL')
            for (let i = 0; i < 50 && !exited; i++) await sleep(100)
          }
        }
      } finally {
        const residue = live.cleanup()
        if (pty && !exited) residue.push('Claude did not exit; a late transcript write may recreate its project directory')
        if (residue.length > 0) console.warn(`[live] could not remove: ${residue.join(', ')}`)
      }
    }
  }, 150_000)
})
