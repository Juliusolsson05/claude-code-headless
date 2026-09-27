# slash-picker

`colour-only-selection-2.1.283.json`: real Claude Code 2.1.283 PTY output, 100x32, recorded on 2026-09-27 for agent-code#1253. The CLI was driven directly in a PTY with node-pty, not through Agent Code, in a fresh temp cwd with folder trust accepted. No prompt was ever submitted.

| step | keys | what the screen shows after it |
|---|---|---|
| `open-filtered` | startup, then `/co` in ONE write | picker `/copy /color /config /compact`, with `/copy` selected |
| `arrow-down-1` | Down | **the same four rows, the same text**; only the highlight colour moves to `/color` |
| `arrow-down-2` | Down | the list scrolls (`/color /config /compact /context`), `/config` selected |
| `arrow-up-1` | Up | scrolls back to the first four rows, `/color` selected |
| `escape` | Esc | picker closed |

`arrow-down-1` is the colour-only selection change #1253 is about. HeadlessTerminal's text-only flush gate emitted no frame for it.

**How the steps were sliced:** by CONTENT, replaying chunk by chunk and reading the picker rows and the selected row's colour after each one, not by send time. Claude paints some keys late, so a key's output often landed after the next key was sent, and time labels were off by one step.

**Why `/co` was sent in one write:** the unfiltered picker lists the user's personal skills. A same-length redaction of those rows did NOT survive replay: Claude repaints only the cells that change, so the redacted characters leaked into the next frame. Filtering first means that list is never painted.

**Redactions** (same byte length, in rows Claude never repaints): the account plan in the banner (`Claude XXX`) and the temp cwd suffix. The replayed screens were diffed before and after redaction, and only those two texts differ. Everything else was read in full: Claude's built-in command list, the effort/permission status lines and a transcript-saving warning.
