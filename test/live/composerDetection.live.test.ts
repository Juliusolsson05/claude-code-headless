import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node-pty'
import { describe, expect, it } from 'vitest'

import { HeadlessTerminal } from '../../src/terminal/HeadlessTerminal.js'
import { parseClaudeComposerState } from '../../src/parsers/ScreenParser.js'

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
    const cwd = mkdtempSync(join(tmpdir(), 'composer-live-'))
    const term = new HeadlessTerminal({
      // A PTY we own directly, so this bypasses attach() and drives the
      // terminal the same way writeForTest does in the unit tests.
      pty: { onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }) } as never,
      cols: 120,
      rows: 40,
    })
    const pty = spawn(process.env.SHELL ?? '/bin/zsh', ['-lc', 'claude'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
    pty.onData(d => void term.writeForTest(d))

    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
    const classify = (): string =>
      parseClaudeComposerState(term.snapshotPlain(), term.snapshotComposerAttributes())

    try {
      // A fresh temp cwd always shows the folder-trust dialog first.
      await sleep(6000)
      if (/trust (the )?(files|this folder)/i.test(term.snapshotPlain())) {
        pty.write('1\r')
        await sleep(7000)
      }
      // Wait for the composer box (a divider rule) to paint.
      for (let i = 0; i < 25 && !/─{10}/.test(term.snapshotPlain()); i++) await sleep(1000)

      expect(classify()).toBe('empty')

      pty.write('this is a real human draft')
      await sleep(2500)
      expect(classify()).toBe('drafted')

      for (let i = 0; i < 80; i++) pty.write('\x7f')
      await sleep(1000)
      expect(classify()).toBe('empty')

      // Run a turn so Claude offers a prompt suggestion afterwards. It renders
      // that suggestion as a dim placeholder over an EMPTY composer, which is
      // the exact regression: arbitrary model prose that must NOT read as a
      // draft.
      pty.write('count slowly from 1 to 30, one number per line\r')
      await sleep(35000)

      const attrs = term.snapshotComposerAttributes()
      if (attrs && attrs.dim > 0) {
        // A placeholder is on screen. It has visible text, so the pre-fix
        // parser would have said 'drafted' and blocked delivery forever.
        expect(attrs.plain).toBe(0)
        expect(classify()).toBe('empty')
      } else {
        // Suggestions are not guaranteed on any given run (they depend on model
        // output and user settings). Say so loudly rather than passing quietly
        // and implying coverage this run did not actually provide.
        console.warn(
          '[live] no dim placeholder appeared this run; the placeholder assertion did not execute',
        )
      }
    } finally {
      pty.kill()
    }
  }, 150_000)
})
