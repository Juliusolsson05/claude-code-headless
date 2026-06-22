// AskUserQuestion picker detection.
//
// WHY this parser exists:
//   Claude Code's `AskUserQuestion` tool draws a numbered-list TUI picker
//   and BLOCKS the agent until the user answers. The native in-feed
//   renderer (AskUserQuestionRow, in Agent Code) draws its OPTIONS from the
//   SEMANTIC tool input (`block.parsedInput`), NOT from terminal paint —
//   that path is brittle. But two things the semantic input cannot tell us,
//   and only the live screen can:
//     1. Is the picker actually ON SCREEN RIGHT NOW? An unanswered
//        AskUserQuestion (interrupted, or the user moved on) leaves the
//        tool_use block unresolved in the transcript forever, so the feed
//        would keep rendering a dead picker many messages later (the
//        "ghost render" bug). The PRESENCE of this parser's result is the
//        authoritative "picker is live" signal that gates the row.
//     2. The live cursor / per-option toggle state (needed for the LATER
//        multi-select / free-text answering PR). We capture it now so the
//        payload is already complete when that PR lands; this PR only
//        consumes the PRESENCE of the state for the render gate.
//
// GROUND TRUTH (captured from a real `claude` 2.1.185 session). Two shapes:
//
//   SINGLE-SELECT:
//      ☐ Choice                                  ← header chip
//     Which option would you like to choose?      ← question text
//     ❯ 1. Alpha                                  ← ❯ = cursor; "N. label"
//          Select Alpha.                          ← dim description (wraps)
//       2. Beta
//       3. Gamma
//       4. Type something.                        ← auto-injected free-text
//     ────────────────                            ← divider
//       5. Chat about this                        ← footer (NOT a real answer)
//     Enter to select · ↑/↓ to navigate · Esc to cancel   ← FINGERPRINT
//
//   MULTI-SELECT (❯ DOES appear on the focused row in BOTH modes):
//     ←  ☐ Colors  ✔ Submit  →                    ← multi nav bar
//     Which colors do you want? (select all that apply)
//     ❯ 1. [ ] Red                                ← ❯ cursor; "[ ]"/"[✔]"
//       2. [✔] Green
//       5. [ ] Type something
//          Submit                                  ← Submit row (focusable)
//     ────────
//       6. Chat about this
//     Enter to select · ↑/↓ to navigate · Esc to cancel
//
// CRITICAL SCOPING GOTCHA (proven live): the COMPOSER input line ABOVE the
// picker ALSO starts with `❯` (it's the echoed user prompt). If we matched a
// bare `❯` anywhere on screen we'd pick up the composer's cursor and report
// a bogus cursorNumber. So we NEVER trust a bare `❯` — we only accept `❯`
// when it immediately precedes a numbered row (`❯ N.`) or the Submit row,
// and we only parse the region that ENDS at the fingerprint line. Anchoring
// is by CONTENT (the fingerprint + `N.` rows), never by absolute line
// offset, because descriptions wrap and shift every row down unpredictably.
//
// WHY plaintext, not cell colors (unlike SlashPickerParser): the cursor here
// is an explicit `❯` GLYPH and the toggle state is explicit `[ ]`/`[✔]`
// text — both survive into the plain string, so we don't need the
// color-distinction trick the slash picker relies on. This keeps the parser
// theme-independent and lets it run off the grid's plain text.

import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless

type TerminalInstance = InstanceType<typeof Terminal>

export type AskUserQuestionOption = {
  /** The on-screen 1-based number, e.g. `1` for "1. Alpha". This is the
   *  load-bearing value: it both identifies the row AND (in single-select)
   *  is the exact keystroke that answers it. */
  number: number
  /** The option label as painted (after the "N. " prefix, with any
   *  multi-select "[ ]/[✔]" checkbox stripped off the front). */
  label: string
  /** Multi-select only: the live checkbox state. `undefined` in
   *  single-select (no checkbox is drawn). */
  toggled?: boolean
}

export type AskUserQuestionState = {
  /** Always true when returned. The PRESENCE of a non-null result is the
   *  "picker is live" signal; `active` is a convenience flag for consumers
   *  that destructure the state without null-checking first. */
  active: true
  mode: 'single' | 'multi'
  header: string | null
  question: string | null
  /** Real numbered options, INCLUDING the auto-injected "Type something"
   *  free-text row (it IS a real, selectable answer). EXCLUDES the
   *  below-the-divider "Chat about this" footer (not an answer). */
  options: AskUserQuestionOption[]
  /** The number of the row the `❯` cursor sits on, or null if the cursor
   *  is on the Submit row (multi-select). */
  cursorNumber: number | null
  /** Multi-select: true when `❯` is on the focusable "Submit" row. */
  submitFocused: boolean
  /** The "Type something" free-text row's number, or null if absent. */
  otherNumber: number | null
  /** The "Chat about this" footer row's number, or null if absent. */
  chatNumber: number | null
}

// The bottom-of-picker help line. Its presence is our hard gate: no
// fingerprint → not an AskUserQuestion picker → return null. We match the
// stable middle of the string rather than the whole line because the exact
// key hints drift across CC versions (e.g. "Tab to toggle" only shows in
// multi-question calls), but "to select" + "to navigate" has been constant.
const FINGERPRINT_RE = /to select.*to navigate/i

// A numbered option row: optional leading `❯` cursor, then "N." then the
// label. We capture the cursor presence, the number, and the rest of the
// line. `❯` is followed by a space in CC's render; non-cursor rows are
// space-indented to the same column.
const OPTION_RE = /^(\s*)(❯\s+)?(\d+)\.\s+(.*)$/

// Multi-select checkbox prefix on the label: "[ ] Red" / "[✔] Green". CC
// uses ✔ (U+2714); we also accept a few common check glyphs defensively.
const CHECKBOX_RE = /^\[([ xX✔✓])\]\s*(.*)$/

// The divider line that separates the real answers from the "Chat about
// this" footer. CC draws it as a run of box-drawing horizontals. We use it
// to know which numbered row is the footer (below the divider) vs. a real
// answer (above it).
const DIVIDER_RE = /^\s*[─—-]{3,}\s*$/

// The Submit pseudo-row in multi-select: a focusable "Submit" with no
// number. It can carry the `❯` cursor. Indented like an option label.
const SUBMIT_RE = /^(\s*)(❯\s+)?Submit\s*$/

type ScannedRow = {
  number: number
  label: string
  cursor: boolean
  belowDivider: boolean
  toggled?: boolean
}

/**
 * Detect Claude Code's AskUserQuestion picker from the live terminal grid.
 *
 * Returns the parsed state when the fingerprint line is present, else null.
 *
 * Algorithm:
 *   1. Read the viewport rows as plain strings (viewport only — scrollback
 *      can hold a stale picker from an earlier turn, exactly the
 *      ghost-render failure this whole feature fixes).
 *   2. Find the fingerprint line. No fingerprint → null.
 *   3. Scan rows ABOVE the fingerprint, in order, collecting numbered
 *      option rows. Track where the divider falls so the footer row
 *      ("Chat about this") is excluded from `options` but recorded as
 *      `chatNumber`.
 *   4. The cursor (`❯`) is read ONLY from a numbered row or the Submit row —
 *      never from a bare `❯` (that's the composer). This is the scoping
 *      guarantee the file header calls out.
 *   5. Mode is `multi` if any option row carries a "[ ]/[✔]" checkbox or a
 *      Submit row is present; otherwise `single`.
 *   6. The "Type something" row is detected by label and recorded as
 *      `otherNumber` (it stays IN `options` — it's a real answer).
 */
export function detectAskUserQuestion(term: TerminalInstance): AskUserQuestionState | null {
  const buf = term.buffer.active

  // Viewport-only scan. See SlashPickerParser for the same scrollback
  // caveat — a numbered list from a previous turn would otherwise read as a
  // live picker.
  const viewportStart = buf.viewportY
  const viewportEnd = Math.min(buf.length, buf.viewportY + term.rows)

  const lines: string[] = []
  for (let y = viewportStart; y < viewportEnd; y++) {
    const line = buf.getLine(y)
    // translateToString(true) trims trailing whitespace cells; we keep
    // leading whitespace because indentation distinguishes cursor (`❯ `)
    // rows from plain rows and the regexes anchor on it.
    lines.push(line ? line.translateToString(true).replace(/\s+$/, '') : '')
  }

  // Find the fingerprint. We take the LAST matching line in the viewport: if
  // two pickers somehow co-exist mid-redraw, the lower one is the live one.
  // No fingerprint at all → not a picker.
  let fingerprintIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FINGERPRINT_RE.test(lines[i])) {
      fingerprintIdx = i
      break
    }
  }
  if (fingerprintIdx === -1) return null

  // Walk DOWNWARD from the top of the viewport to the fingerprint,
  // classifying every line. We don't start at an absolute offset above the
  // fingerprint because descriptions wrap and the header/question distance
  // varies.
  const rows: ScannedRow[] = []
  let dividerSeen = false
  let submitFocused = false
  let sawSubmit = false
  let sawCheckbox = false

  // header + question heuristics. The header is the "☐/☒ Header" chip; the
  // question is the first plain prose line before the first numbered row.
  let header: string | null = null
  let question: string | null = null
  let sawFirstOption = false

  for (let i = 0; i < fingerprintIdx; i++) {
    const raw = lines[i]
    if (!raw.trim()) continue

    if (DIVIDER_RE.test(raw)) {
      dividerSeen = true
      continue
    }

    const submitMatch = raw.match(SUBMIT_RE)
    if (submitMatch) {
      sawSubmit = true
      if (submitMatch[2]) submitFocused = true // `❯ ` present on Submit
      continue
    }

    const optMatch = raw.match(OPTION_RE)
    if (optMatch) {
      sawFirstOption = true
      const cursor = Boolean(optMatch[2]) // `❯ ` capture — scoped to `❯ N.`
      const number = Number(optMatch[3])
      let label = optMatch[4].trim()

      // Strip a multi-select checkbox off the front of the label, if any.
      const cb = label.match(CHECKBOX_RE)
      let toggled: boolean | undefined
      if (cb) {
        sawCheckbox = true
        toggled = cb[1] !== ' '
        label = cb[2].trim()
      }

      rows.push({ number, label, cursor, belowDivider: dividerSeen, toggled })
      continue
    }

    // Non-structural line BEFORE the first option: candidate header /
    // question. The header chip starts with the ☐/☒ glyph (single-select)
    // or appears inside the "←  ☐ Colors  ✔ Submit  →" nav bar (multi).
    //
    // SCOPING (proven by the probe): the COMPOSER echo line sits ABOVE the
    // header chip and is plain prose ("❯ tell me which option…"). If we
    // accepted any plain line as the question we'd grab the composer echo.
    // So the question is ONLY captured AFTER the header chip has been seen —
    // the header is the top boundary of the picker region. Calls without a
    // header chip leave `question` null rather than risk the composer leak;
    // the renderer falls back to the semantic `parsedInput.question` anyway,
    // so a null here is harmless. We also explicitly reject any line still
    // bearing a `❯` (belt-and-suspenders against the composer cursor).
    if (!sawFirstOption) {
      const hasChip = /[☐☒]/.test(raw)
      if (hasChip && header === null) {
        // Pull the word(s) after the chip glyph as the header label. For
        // the multi nav bar ("←  ☐ Colors  ✔ Submit  →") this grabs
        // "Colors"; for the single chip ("☐ Choice") it grabs "Choice".
        const m = raw.match(/[☐☒]\s+([^✔✓←→]+)/)
        header = m ? m[1].trim() : null
      } else if (!hasChip && header !== null && question === null && !raw.includes('❯')) {
        question = raw.trim()
      }
    }
  }

  // No numbered rows at all → the fingerprint matched something that isn't
  // actually a picker (defensive). Bail.
  if (rows.length === 0) return null

  // Detect the auto-injected free-text row and the footer by label. "Type
  // something" is a real, selectable answer (stays in options). "Chat about
  // this" is the below-divider footer (excluded from options).
  let otherNumber: number | null = null
  let chatNumber: number | null = null
  let cursorNumber: number | null = null
  const options: AskUserQuestionOption[] = []

  for (const r of rows) {
    if (r.cursor) cursorNumber = r.number

    const isChat = /chat about this/i.test(r.label) || r.belowDivider
    if (isChat) {
      chatNumber = r.number
      continue // footer is NOT an answer
    }

    if (/type something/i.test(r.label)) otherNumber = r.number

    options.push(
      r.toggled === undefined
        ? { number: r.number, label: r.label }
        : { number: r.number, label: r.label, toggled: r.toggled },
    )
  }

  // Mode: multi if any checkbox was seen or a Submit row exists. The
  // checkbox is the strongest signal (single-select never draws one); the
  // Submit row corroborates.
  const mode: 'single' | 'multi' = sawCheckbox || sawSubmit ? 'multi' : 'single'

  return {
    active: true,
    mode,
    header,
    question,
    options,
    // If `❯` was on the Submit row, the cursor is NOT on any numbered
    // option → cursorNumber stays null and submitFocused carries it.
    cursorNumber: submitFocused ? null : cursorNumber,
    submitFocused,
    otherNumber,
    chatNumber,
  }
}
