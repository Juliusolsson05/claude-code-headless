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

## `transcript-bash-wrap-2.1.296.json`

Real Claude Code 2.1.296 PTY output, 120x40, recorded on 2026-10-14 for agent-code#1477. The CLI was driven directly in a PTY with node-pty, not through Agent Code, in `/private/tmp/picker-fixture`. One prompt WAS submitted, asking Claude to run a single harmless Bash command (`sleep 30` and an `echo`).

| step | keys | what the screen shows after it |
|---|---|---|
| `startup` | none | banner, empty composer |
| `prompt` | the prompt text, no Enter | the draft in the composer |
| `submit` | Enter | Claude runs the command. Its `$ …` line wraps, and the continuation row is `     /shots && sleep 30 && echo $S (11s)`: a `/`-led row in `#999999`, the same colour as an unselected picker row. **No picker is open.** |
| `open-filtered` | `/cl` | picker `/clear` (selected, drawn `  ❯ /clear …`) and `/claude-api`, each wrapping its description onto a continuation row, directly on top of the composer's top rule; the Bash row is still on screen above it |
| `escape` | Esc | picker closed (composer keeps `/cl`), Bash row still on screen |

`submit` and `escape` are the agent-code#1477 false positive: the old parser reported the Bash row as a command. `open-filtered` is the 2.1.296 selected-row shape the old parser dropped.

**Why the path is 72 zeros long:** Claude wraps the `$ …` line at a fixed width. The zeros were tuned so the break falls just before `/shots`, which reproduces the user's screen (`     /scratchpad/shots && cd $S …`) at 120 columns.

**Why `/cl`:** the unfiltered picker lists the user's personal skills. `/cl` matches only a built-in command and a bundled skill.

**How the steps were sliced:** each PTY chunk is tagged with the last key sent, and each step's replayed screen was checked against the table above. Claude's spinner and timers keep repainting, so a step's chunks include the redraws until the next key.

**Redactions** (same byte length, banner row never repainted): the account plan (`Claude XXX`). Replayed screens were diffed before and after redaction; only the banner row differs. Everything else was read in full: the prompt, Claude's one-line plan, the command's progress rows, the token counter, the two picker rows, a login-expiry notice and the terminal title (`Picker fixture scratchpad shots`).

## `reply-inline-code-2.1.296.json`

Real Claude Code 2.1.296 PTY output, 120x40, recorded on 2026-10-14 for agent-code#1477 (the inline-code case agent-code#1293 describes). The recording was made the same way as above. One prompt was submitted, asking Claude to reply with three fixed lines. No tools ran.

| step | keys | what the screen shows after it |
|---|---|---|
| `startup` | none | banner, empty composer |
| `prompt` | the prompt text, no Enter | the three-line draft in the composer |
| `submit` | Enter | the prompt echo and the reply both render `` `/compact` frees context. `` and `` `/clear` starts over. `` as `/`-led rows in `#B1B9F9`, **the selected picker colour**. The reply's last `/` row is the last row of its block: a blank row and the `✻ Baked for 1s` status row follow it. **No picker is open.** |
| `open-filtered` | `/cl` | the same picker as in `transcript-bash-wrap-2.1.296.json`, with the inline-code rows still above it |
| `escape` | Esc | picker closed, inline-code rows still on screen |

This fixture pins the "first non-picker row ends the picker" rule on its own. Unlike the Bash fixture, no indented row follows the `/` row, so nothing else in the parser rejects it.

**Redactions:** the same as above (`Claude XXX`, diffed before and after). Everything else was read in full: the prompt, the reply, the status row, the picker rows, the login notice and the terminal title (`Compact and clear commands`).

## `lo-wrap-arrows-2.1.296.json`

Real Claude Code 2.1.296 PTY output, 111x40, recorded on 2026-10-14 during review round 1 of agent-code#1477, the same way as above. No prompt was submitted.

| step | keys | what the screen shows after it |
|---|---|---|
| `startup` | none | banner, empty composer |
| `open-filtered` | `/lo` | `❯ /loop` (selected), `/login`, `/logout`. `/loop`'s description wraps onto `/loop 5m /foo). Omit the interval…`, a continuation row **starting with `/`** at x=48. That is the description column every padded row shares. |
| `arrow-down-1` | Down | the same rows, `❯` on `/login` (selection not on the first row) |
| `arrow-down-2` | Down | scrolled: `/login`, `❯ /logout`, `/workflow-authoring` (two-row description) |
| `arrow-up-1` | Up | back to the `open-filtered` rows, `❯` on `/login` |
| `escape` | Esc | picker closed |
| `clear` | Ctrl+U | empty composer, right-aligned `Ctrl+Y to paste deleted text` hint on the rule |
| `open-star` | `/agent-code-co` | three Agent Code skills drawn as `❯ * /agent-code-conventions – Personal …`, then `* /agent-code-goal – …` and `* /agent-code-tldr – …`. These are `*`-marked rows joined with ` – `, not padded, and truncated with `…` instead of wrapped. |
| `escape-2` | Esc | picker closed |

**Why 111 columns:** at that width `/loop`'s description breaks right before `/loop 5m`. Both reviewers found this family of wraps (`/foo)` at 108–114, `/resume)` at 156–160).

**Content:** the `/agent-code-*` rows are the skills Agent Code itself installs, with Agent Code's own descriptions. `/workflow-authoring` is a bundled skill. **Redactions:** `Claude XXX`, diffed as above. Everything else was read in full: the composer placeholder, the login notice and the terminal title (`Claude Code`).

## `compact-hint-2.1.296.json`

Real Claude Code 2.1.296 PTY output, **120x12**, recorded on 2026-10-14 during review round 1 of agent-code#1477. One prompt (`Reply with exactly: ok`) and one real `/compact` were submitted. The short pane makes the transcript reach the composer, which is the layout the Codex reviewer found in two of the user's own bundles.

| step | keys | what the screen shows after it |
|---|---|---|
| `startup` | none | banner, empty composer |
| `prompt` | the prompt, no Enter | draft |
| `submit` | Enter | reply `ok`, and the right-aligned login notice directly on the rule |
| `compact-typed` | `/compact` | the real picker in a 12-row pane: `❯ /compact`, `/autocompact`, `/computer-use` (two rows) |
| `compact-run` | Enter | `❯ /compact` / `  ⎿  Compacted (ctrl+o to see full summary)` in the transcript |
| `draft` | `abc` | draft |
| `delete-draft` | Ctrl+U | **the false positive:** the right-aligned `Ctrl+Y to paste deleted text` hint is directly on the rule, `⎿ Compacted` is above it, and the transcript's `❯ /compact` is above that. No picker is open. |
| `open-filtered` | `/cl` | the `/cl` picker drawn over the transcript |
| `escape` | Esc | picker closed |

**Redactions:** `Claude XXX`, diffed as above. Everything else was read in full: the prompt and reply, the compaction summary line, the spinner words, a tip line, the picker rows and the terminal title (`Exact reply request`).
