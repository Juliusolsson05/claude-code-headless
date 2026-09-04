// Volatile-chrome normalization for screen-frame comparison.
//
// WHY this exists (agent-code#765): Claude's TUI repaints its spinner line
// every ~100 ms while it works — the glyph rotates through ·✢✳✶✻✽, the
// elapsed timer ticks `(5s · …)`, the token counter climbs `↓ 1.2k tokens`.
// Recordings show 99% of consecutive frames differ ONLY in that line, yet
// the exact-equality gate in HeadlessTerminal.scheduleFlush() sees a changed
// frame every tick and pays for two per-cell markdown walks; the
// ClaudeCodeHeadless 'screen' handler then pays for a composer attribute
// walk, two live-grid walks and five regex detectors on top. With ~10
// sessions thinking that is 300–500 cell walks per second on the host's
// main thread, for a glyph.
//
// Normalizing rewrites the known-volatile shapes to fixed tokens so two
// frames that differ only in chrome produce the same key. The RAW text is
// still what gets emitted — this is a comparison key, never a display
// string — so consumers keep seeing the live spinner.
//
// The rules are a VERBATIM copy of agent-code's
// `src/main/sessions/screenFrameGate.ts` (PR #761), which drops the IPC
// emit of the same frames one layer up. The two layers must agree on what
// counts as chrome: if this file calls a change spinner-only but the app
// gate does not, the app forwards a frame whose derived state (composer,
// conditions) is one frame stale; if the app calls it chrome but this file
// does not, the package merely does redundant work. Keep them in sync — the
// app should eventually import this function instead of duplicating it.
//
// WHY these shapes and no more: each rule is backed by a recorded
// consecutive-frame diff (session-recordings, 2026-09-03). A rule for text
// that is not demonstrably volatile would hide real changes; the cost of a
// missing rule is one fully-processed frame, i.e. the status quo. When in
// doubt, a change is real.

const CLAUDE_SPINNER_GLYPHS = '·✢✳✶✻✽'
const CODEX_BRAILLE_GLYPHS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPINNER_LINE_START = new RegExp(`^(\\s*)[${CLAUDE_SPINNER_GLYPHS}${CODEX_BRAILLE_GLYPHS}](?=\\s|$)`)
// `5s`, `12s`, `1m 9s`, `2h 3m 4s` — the elapsed counters every TUI spinner
// carries. Word-bounded so `k8s`, `s3`, hex and version strings survive.
const ELAPSED_TIMER = /\b(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/g
// `↓ 1.2k tokens`, `↑ 340 tokens`, `(2.3k tokens)`.
const TOKEN_COUNTER = /\b\d+(?:\.\d+)?k?\s+tokens\b/g
// The remote-control status blinks "connecting…" on and off every frame.
const RC_CONNECTING = /\/rc connecting…/g
const TRAILING_WHITESPACE = /[ \t]+$/gm

/**
 * Rewrite the volatile spinner shapes in a screen snapshot to fixed tokens.
 * Two frames whose normalized text is equal differ only in chrome.
 */
export function normalizeVolatileScreenText(text: string): string {
  if (text.length === 0) return text
  return text
    .split('\n')
    .map(line => line.replace(SPINNER_LINE_START, '$1⋯'))
    .join('\n')
    .replace(ELAPSED_TIMER, 'Ns')
    .replace(TOKEN_COUNTER, 'N tokens')
    .replace(RC_CONNECTING, '/rc')
    .replace(TRAILING_WHITESPACE, '')
}
