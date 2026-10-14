// Slash command picker detection.
//
// WHERE THE PICKER IS (agent-code#1477, recorded, not read from source): the
// picker is the block of rows sitting DIRECTLY ON TOP of the composer's top
// rule:
//
//       ⏺ …transcript…                         ← anything, including `/…` rows
//       ✢ Composing… (13s)                      ← spinner / status / blank row
//       ❯ /clear        Start a new session…   ← picker item (selected)
//                       disk (resumable…)       ← its wrapped description
//         /claude-api   Reference for the…      ← picker item
//       ────────────────────────────────────    ← composer top rule
//       ❯ /cl                                   ← composer
//       ────────────────────────────────────
//
// That held in every screen recorded across Claude Code 2.1.283 and 2.1.296,
// at 120 and 60 columns, idle and mid-turn (docs/decomposition/claude-slash-
// picker.md in agent-code, fixtures in test/fixtures/slash-picker).
//
// WHY anchoring and not the old "any coloured `/`-led row in the viewport":
// that rule matched transcript content. Claude hard-wraps a running Bash
// command's `$ …` line, so a path can put `/` first on the continuation row
// (`     /scratchpad/shots && cd $S …`). That row is painted #999999, the SAME
// colour as an unselected picker row, so no colour test can reject it. The
// composer saw a one-item "picker" for as long as the command stayed on
// screen. Its position can reject it. The picker touches the composer and
// sits under a blank row. Transcript content never touches the composer:
// a blank row, the spinner, or a right-aligned hint row (which is not
// picker-shaped) always sits between them. Recorded: 2.1.283, and 2.1.296 at
// 12–40 rows and 60–160 columns, idle, mid-turn and with a queued message.
// Inline code is painted #B1B9F9, the SELECTED colour, so colour cannot help.
//
// WHY the old header was wrong: it was written from the vendored
// `PromptInputFooter.tsx`, where suggestions replace the footer BELOW the
// input. The installed binaries draw the picker above the input, and the
// vendored source is older than either. Don't re-derive layout from
// vendor/ — record the binary.
//
// SELECTION: 2.1.296 prefixes the selected row with a literal `❯ `
// (`  ❯ /clear …`). The old parser required `/` as the first glyph, so it
// silently DROPPED the selected command on 2.1.296. 2.1.283 has no glyph and
// marks selection by colour only (agent-code#1253), so the colour rule stays
// as the fallback when no row carries `❯`.
//
// This parser takes a Terminal instance directly for cell-level access (fg
// colour) and must run where the headless xterm Terminal is available.

import xtermHeadless from '@xterm/headless'

import { isDividerLine } from './ScreenParser.js'
const { Terminal } = xtermHeadless

type TerminalInstance = InstanceType<typeof Terminal>

export type PickerItem = {
  /** The slash-command name as it appears on screen, e.g. "/init". */
  id: string
  /** Same as id for now; kept as a separate field so future picker
   *  types (file / agent / mcp resource) can have different display
   *  labels vs. stable ids. */
  label: string
  /** The description CC renders after the padding, joined across the rows
   *  it wraps onto (it used to stop at the first row). */
  description: string
  /** True if this is the row CC is rendering as the current selection. */
  selected: boolean
}

export type SlashPickerState = {
  visible: boolean
  items: PickerItem[]
}

const HIDDEN: SlashPickerState = { visible: false, items: [] }

// A picker item row: optional `❯ ` (2.1.296's selection glyph), optional `* `
// (seen once on a user-installed skill; meaning unknown, see Unknown 1 in the
// decomposition), then the `/command` token, then the description. The
// description is usually separated by column padding, but an over-long name is
// joined with ` – ` instead (`❯ * /agent-code-conventions – Personal…`).
//
// Group 1 is everything left of the `/`, so its length is the command's
// column. That column is how an item row is told apart from a wrapped
// description row that also starts with `/` (see PADDED_ITEM_RE).
const ITEM_RE = /^(\s*(?:❯\s+)?(?:\*\s+)?)(\/\S+)(.*)$/u

// A padded item row: the command, a run of 2+ spaces, then the description.
// Claude lays the picker out in two columns, and every padded row starts its
// description at the same column D: 52 at 120 columns, 48 at 111, 28 at 60 on
// 2.1.296, and 39 at 100 columns on 2.1.283. Wrapped description rows start
// exactly at D. Groups 1–3 together span the columns before the description.
const PADDED_ITEM_RE = /^(\s*(?:❯\s+)?(?:\*\s+)?)(\/\S+)(\s{2,})\S/u

// The composer's first row. Same marker set parseClaudeComposerState accepts:
// `❯` today, `>` on older/alternate builds.
const COMPOSER_MARKER_RE = /^\s*[❯>](?:\s|$)/u

type LineInstance = NonNullable<ReturnType<TerminalInstance['buffer']['active']['getLine']>>

function firstInkCell(line: LineInstance): { x: number; fg: number } | null {
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    const chars = cell?.getChars()
    if (!cell || !chars || chars === ' ') continue
    return { x, fg: cell.getFgColor() }
  }
  return null
}

/**
 * Detect Claude Code's slash command picker from the live terminal grid.
 *
 * 1. Find the composer's top rule: the LOWEST viewport divider directly
 *    followed by a composer marker row. Lowest, because transcript content can
 *    contain rules too; the live composer is always at the bottom. No composer
 *    means no picker (a permission dialog or the trust screen replaces it).
 * 2. Read the description column D from the lowest padded item row in the
 *    contiguous non-blank run above the rule. There may be none: `* … – …`
 *    skill rows aren't padded, and with no picker open there is usually no
 *    such row at all.
 * 3. Walk UP from the row above the rule, classifying each row by COLUMN:
 *    - a row whose first ink is exactly at D is a wrapped description, even
 *      when it starts with `/` (`/loop 5m /foo)`, `/resume)`);
 *    - a row with the item shape and its `/` left of D is an item.
 *    Stop at the first row that is neither. That row is the blank separator
 *    above an open picker, or the right-aligned hint row
 *    (`Ctrl+Y to paste deleted text`, `◐ medium · /effort`) that sits on the
 *    rule when no picker is open. Nothing above it can join the picker, which
 *    is the whole #1477 fix.
 * 4. Selected = the row carrying `❯`; otherwise the row whose colour differs
 *    from the majority (2.1.283).
 *
 * Viewport only: scrollback can hold a stale picker from an earlier turn.
 */
export function detectSlashPicker(term: TerminalInstance): SlashPickerState {
  const buf = term.buffer.active
  const viewportStart = buf.viewportY
  const viewportEnd = Math.min(buf.length, buf.viewportY + term.rows)
  const text = (y: number): string => buf.getLine(y)?.translateToString(true) ?? ''

  let rule = -1
  for (let y = viewportEnd - 2; y >= viewportStart; y--) {
    if (isDividerLine(text(y)) && COMPOSER_MARKER_RE.test(text(y + 1))) {
      rule = y
      break
    }
  }
  if (rule < 0) return HIDDEN

  // Review round 1 of agent-code#1477 disproved the first rule, "a
  // continuation row is any indented row not led by `/`", twice:
  // - a description can wrap onto a `/`-led row, which became a phantom
  //   command (a second `/loop`, i.e. a duplicate React key in the app);
  // - a right-aligned hint row is indented too, so the walk climbed through
  //   it into the transcript and published `❯ /compact` (a past command echo)
  //   as the SELECTED command.
  // Claude's two-column layout gives an exact test instead: continuation rows
  // start at the description column D, and nothing else does. D comes from
  // the lowest padded row above the rule, which is the picker's own when one
  // is open. With no picker open, a D taken from a transcript row is harmless:
  // the walk below still stops at the first row that is neither at D nor an
  // item.
  let descriptionColumn: number | undefined
  for (let y = rule - 1; y >= viewportStart; y--) {
    const padded = PADDED_ITEM_RE.exec(text(y))
    if (padded) {
      descriptionColumn = padded[1]!.length + padded[2]!.length + padded[3]!.length
      break
    }
  }

  type Candidate = PickerItem & { fgColor: number; marked: boolean }
  const items: Candidate[] = []
  // Continuation rows are met BEFORE their item when walking upward, so they
  // wait here, unshifted into top-down order, until the item row above claims
  // them.
  let pending: string[] = []

  for (let y = rule - 1; y >= viewportStart; y--) {
    const line = buf.getLine(y)
    const ink = line ? firstInkCell(line) : null
    const raw = line?.translateToString(true) ?? ''

    // A wrapped description row. Checked BEFORE the item shape, because such a
    // row may itself start with `/`. Item rows put their `/` left of D, so
    // this check alone separates the two.
    if (ink && descriptionColumn !== undefined && ink.x === descriptionColumn) {
      pending.unshift(raw)
      continue
    }

    // No colour requirement: position already decides, and the old "coloured
    // `/`" test is exactly what transcript rows passed. Colour is only used
    // below, for 2.1.283's selection.
    const match = ink ? ITEM_RE.exec(raw) : null
    if (ink && match) {
      const id = match[2]!
      const description = [match[3]!, ...pending]
        .map(part => part.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/^–\s+/u, '')
      items.push({ id, label: id, description, selected: false, fgColor: ink.fg, marked: match[1]!.includes('❯') })
      pending = []
      continue
    }

    // THE #1477 RULE: the first row that is neither ends the picker. With a
    // picker open that is the blank row Claude draws above it (the spinner is
    // hidden while the picker shows). With no picker it is often a
    // right-aligned hint on the rule. The picker never contains either. Nothing
    // above it can become a command, however it is coloured. Recorded `/`-led
    // rows above it: a wrapped Bash `$ …` line (#999999, the unselected picker
    // colour), and inline code in replies and prompt echoes (#B1B9F9, the
    // SELECTED picker colour).
    break
  }

  // Leftover continuation rows with no item above them are transcript text
  // that happened to sit on top of the picker's first item. Dropped.
  if (items.length === 0) return HIDDEN
  items.reverse()

  const explicit = items.findIndex(item => item.marked)
  let isSelected: (item: Candidate, index: number) => boolean
  if (explicit >= 0) {
    isSelected = (_item, index) => index === explicit
  } else {
    // 2.1.283: no glyph. The majority colour is "dim"; the odd one out is
    // selected. When every row shares a colour (before Claude paints the
    // highlight), nothing is selected, which is the safe default.
    const counts = new Map<number, number>()
    for (const item of items) counts.set(item.fgColor, (counts.get(item.fgColor) ?? 0) + 1)
    let dimColor = items[0]!.fgColor
    let dimCount = 0
    for (const [color, n] of counts) {
      if (n > dimCount) {
        dimCount = n
        dimColor = color
      }
    }
    isSelected = item => item.fgColor !== dimColor
  }

  return {
    visible: true,
    items: items.map((item, index) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      selected: isSelected(item, index),
    })),
  }
}
