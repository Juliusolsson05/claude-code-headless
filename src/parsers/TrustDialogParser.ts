// Detect CC's "Quick safety check" trust dialog from a screen snapshot.
//
// Why this is its own parser:
//   The trust dialog is a modal interactive screen CC shows when you start
//   a session in a directory it hasn't seen before. Downstream consumers
//   need to handle it in different contexts:
//
//     1. Automated tooling — auto-accept it during scripted recordings
//        so it can capture the main UI without manual intervention.
//     2. GUI applications — recognize it and render a native modal the
//        user can click, instead of leaving it as raw screen text.
//
//   Both use cases share the SAME detection logic. Keeping it in this
//   shared package means every consumer calls into the same pure
//   function and any improvements to the detector benefit all of them.
//
// Why string-match and not regex:
//   The dialog text is stable and English-only in the version of CC we're
//   targeting. A simple substring search is faster, more obvious, and
//   easier to extend than a regex. If CC ships localized versions later
//   we add the new strings to the marker arrays — no rewrite.
//
// ── THE 2.1.251 LESSON: NEVER ASSUME THE LAYOUT, REPORT IT ──────────────────
// This parser used to hardcode the option list as
// `[{key:'1', label:'Yes…'}, {key:'2', label:'No, exit'}]` and export a
// constant accept keystroke of a bare Enter, on the reasoning that CC
// pre-highlights "Yes" so Enter would keep working even if the numbering
// changed. Claude Code 2.1.251 inverted exactly that assumption: the dialog
// became unnumbered, listed "No, exit" FIRST, and pre-highlighted it — so the
// "future-proof" bare Enter confirmed *No, exit* and terminated the CLI
// (issue agent-code#705, recorded in debug bundle
// 2026-08-30T23-51-06-471-9bd68e14). The parser therefore now extracts the
// REAL on-screen order and which row carries the `❯` highlight pointer, and
// the accept keystrokes are computed by the trust-dialog driver from this
// observed state (conditions/trustDialogDriver.ts) — there is deliberately no
// exported constant accept keystroke anymore, because any constant re-encodes
// a layout assumption that upstream has already changed once.

export type TrustDialogOption = {
  /** Positional key ('1' = first row on screen). Wire-compat identifier only —
   * since 2.1.251 the dialog has no visible numbers and the position carries
   * no meaning; never synthesize keystrokes from this. */
  key: string
  label: string
  /** True when this row carries the selection pointer (`❯`). Exactly the row a
   * bare Enter would confirm — the fact the old code guessed and now we read. */
  highlighted: boolean
}

export type TrustDialogState = {
  /** True if CC is currently showing the trust dialog. */
  visible: boolean
  /** The selectable options in ON-SCREEN order (best-effort extraction). */
  options?: TrustDialogOption[]
  /** The directory CC is asking the user to trust, if we can extract it. */
  workspace?: string
}

/** The affirmative option's label — shared vocabulary between this parser, the
 * trust-dialog condition module, and the driver that has to find this row on
 * screen before it dares press Enter. */
export const TRUST_DIALOG_ACCEPT_LABEL = 'Yes, I trust this folder'
export const TRUST_DIALOG_DECLINE_LABEL = 'No, exit'

// Distinctive substrings from the dialog. ALL of these must be present for
// us to declare a positive match — being conservative avoids false positives
// on assistant text that happens to mention "trust" or "workspace".
const REQUIRED_MARKERS = [
  'Accessing workspace:',
  TRUST_DIALOG_ACCEPT_LABEL,
  TRUST_DIALOG_DECLINE_LABEL,
] as const

const NEGATIVE_RE = /[⏵⏶]/ // ⏵ markers only appear in the main UI status row, not the trust dialog

// The selection pointer CC's Select component paints before the highlighted
// row. `❯` (U+276F) on macOS/Linux; plain `>` is the figures fallback on
// Windows. It must be the first non-space character of the row — a `>`
// appearing later in a line is quoted text, not a pointer.
const HIGHLIGHT_RE = /^\s*[❯>]/

/**
 * Extract the option row for `label`: its line index (for on-screen ordering)
 * and whether it carries the highlight pointer.
 *
 * Matching is `includes`, not equality, because both known layouts decorate
 * the label differently: the pre-2.1.251 dialog numbered rows
 * (`❯ 1. Yes, I trust this folder`) while 2.1.251 paints bare labels with an
 * indent. The label substring is the one stable part.
 *
 * If the same label somehow appears on several lines (should not happen inside
 * one dialog frame), prefer a highlighted occurrence — the pointer is the
 * safety-relevant fact and a false "not highlighted" reading is the reading
 * that could make the driver press an unnecessary (harmless) arrow, while a
 * missed pointer could make it refuse to act at all.
 */
function findOptionRow(
  lines: string[],
  label: string,
): { line: number; highlighted: boolean } | null {
  let found: { line: number; highlighted: boolean } | null = null
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(label)) continue
    const highlighted = HIGHLIGHT_RE.test(lines[i])
    if (found === null || (highlighted && !found.highlighted)) {
      found = { line: i, highlighted }
    }
  }
  return found
}

/**
 * Returns the trust-dialog state for a given screen snapshot.
 *
 * Pure function — no IO, no side effects, no Node APIs.
 *
 * Performance note: this gets called on every screen snapshot (up to
 * ~10Hz per session, and only on changed frames since the change gate
 * in HeadlessTerminal.scheduleFlush), so it has to be cheap. The early
 * return on the first missing marker keeps the common case (dialog NOT
 * visible) to one substring search.
 */
export function detectTrustDialog(screen: string): TrustDialogState {
  if (!screen) return { visible: false }

  for (const marker of REQUIRED_MARKERS) {
    if (!screen.includes(marker)) return { visible: false }
  }

  // Belt and suspenders: if we see status-row markers in the same screen,
  // CC has already moved past the dialog. Treat as not visible. This guards
  // against the brief moment when the dialog is fading out and the main UI
  // is fading in — both could be present in scrollback for one frame.
  if (NEGATIVE_RE.test(screen)) return { visible: false }

  // Best-effort: extract the workspace path. CC renders it on its own line
  // immediately under "Accessing workspace:".
  let workspace: string | undefined
  const lines = screen.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('Accessing workspace:')) {
      // Skip blank lines, take the next non-blank.
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const candidate = lines[j].trim()
        if (candidate) {
          workspace = candidate
          break
        }
      }
      break
    }
  }

  // Extract the two known options in their REAL on-screen order, with the
  // observed highlight. Order and highlight are the load-bearing facts the
  // driver acts on; the labels themselves are the detection contract above.
  // Both labels are guaranteed present by the REQUIRED_MARKERS gate, so the
  // row lookups cannot both fail; if one somehow does (a pathological wrap
  // splitting the label), we still report the dialog as visible but omit
  // `options` — the driver treats missing options as "cannot prove the
  // layout" and refuses to synthesize keystrokes.
  const acceptRow = findOptionRow(lines, TRUST_DIALOG_ACCEPT_LABEL)
  const declineRow = findOptionRow(lines, TRUST_DIALOG_DECLINE_LABEL)
  if (!acceptRow || !declineRow) {
    return { visible: true, workspace }
  }

  const rows = [
    { label: TRUST_DIALOG_ACCEPT_LABEL, ...acceptRow },
    { label: TRUST_DIALOG_DECLINE_LABEL, ...declineRow },
  ].sort((a, b) => a.line - b.line)

  const options = rows.map((row, index) => ({
    key: String(index + 1),
    label: row.label,
    highlighted: row.highlighted,
  }))

  return { visible: true, options, workspace }
}
