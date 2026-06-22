# claude-code-headless — API Reference

Exhaustive reference for everything `claude-code-headless` exports. For
the semantic-event protocol rationale see `EVENT_SPEC.md`; for the
proxy-streaming architecture see `PROXY_STREAMING.md`. This document is
self-sufficient for using the package.

Every symbol named here is exported from the package root (`src/index.ts`).
Source files are cited as `src/<file>.ts` where it helps.

---

## 1. Orientation

`claude-code-headless` programmatically controls a running Claude Code
(`claude`) process. You spawn the CLI yourself in a PTY; the package
mirrors that PTY through a headless `xterm`, parses the TUI, tails
Claude's JSONL transcript, and (optionally) consumes proxy-captured
Anthropic SSE traffic. It emits structured, typed events.

The package **never spawns or kills processes** (except the optional
mitmproxy launcher in `ProxyServer`), **never auto-accepts dialogs**,
and **never writes to the filesystem** beyond reading Claude's project
directory. The consumer owns the PTY lifecycle.

### Mental model

```
                  ┌──────────────────────────────┐
   your PTY  ───▶  │      ClaudeCodeHeadless       │  ◀─── proxy transport events
 (claude CLI)      │   (orchestrator + ownership)  │       (optional)
                  └──────────────┬───────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  semantic channel         screen channel          committed channel
 "what the model is      "what is on the          "what has persisted
   producing now"          terminal now"            to the JSONL"
```

Four subsystems compose into the orchestrator:

- **Orchestrator** — `ClaudeCodeHeadless`. Owns the PTY mirror, the
  JSONL tailer, parser dispatch, live-turn ownership policy, and the
  three channels.
- **Three channels** — `semantic`, `screen`, `committed`. Independent
  typed event streams. The new public contract.
- **Proxy adapter** — `ClaudeProxyAdapter`. Optional. Turns
  mitmproxy-style transport events into structured per-block semantic
  events, the authoritative live source when present.
- **Pure parsers / transcript helpers** — stateless functions you can
  use standalone without an orchestrator at all.

### Import surface

```ts
import {
  // Orchestrator + legacy flat events
  ClaudeCodeHeadless,
  // Channels
  SemanticChannel, ScreenChannel, CommittedChannel,
  // Terminal
  HeadlessTerminal, terminalToMarkdown,
  // Parsers
  detectActivity, extractAssistantInProgress, extractStreamingText,
  isChromeLine, isDividerLine, isPromptLine, isUserPromptLine,
  isStatusLine, isIntermediateChromeLine, ASSISTANT_LINE_MARKER,
  detectTrustDialog, TRUST_DIALOG_ACCEPT_KEYS,
  detectPermissionPrompt, PERMISSION_PROMPT_APPROVE_KEYS, PERMISSION_PROMPT_DENY_KEYS,
  detectCompaction, detectResumePrompt, detectSlashPicker,
  CLAUDE_MODULES, makeEvaluator,
  trustDialogModule, permissionPromptModule, resumePromptModule,
  compactionModule, askUserQuestionModule, slashPickerModule,
  buildClaudeTrustDialogCondition, buildClaudePermissionPromptCondition,
  buildClaudeResumePromptCondition, buildClaudeCompactionCondition,
  buildClaudeAskUserQuestionCondition, buildClaudeSlashPickerCondition,
  diffLines,
  // Transcript
  isConversationEntry, isCompactBoundaryEntry, isCompactSummaryEntry,
  tailNewSessionFile, tailSessionFile, listSessionsForCwd, getProjectDirForCwd,
  // Proxy
  ClaudeProxyAdapter, createDefaultAttributionPolicy, defaultAttributionPolicy,
  IncrementalSseParser, parseAnthropicEventsFromSse,
  ProxyServer, createProxyServer, spawnClaudeWithProxy,
} from 'claude-code-headless'
```

All TypeScript types (`ClaudeCodeHeadlessOptions`, `ConditionsEvent`,
`ClaudeConditionSnapshot`, `ConditionCustomAction`,
`AskUserQuestionResolvePayload`, `DriveResult`, `SemanticEvent`,
`ScreenSnapshot`, `Entry`, etc.) are exported alongside their runtime
counterparts. The package is ESM (`"type": "module"`).

### Dependencies

| Dependency | Kind | Notes |
| --- | --- | --- |
| `@xterm/headless` | dependency | Headless terminal emulator. |
| `chokidar` | dependency | Directory watcher for new-session detection. |
| `node-pty` | **peer dependency** | You provide it; the package types against `IPty`. |
| `mitmproxy` (`mitmdump`) | external runtime | Only needed for `ProxyServer`. Not an npm dep. |

---

## 2. Getting started

### Install / build

```bash
npm install claude-code-headless node-pty
# building from source:
npm run build   # tsc + copies mitmAddon.py into dist/
```

`main` is `dist/index.js`, `types` is `dist/index.d.ts`. Only `dist/` is
published.

### Minimal end-to-end example (no proxy)

```ts
import { spawn } from 'node-pty'
import { ClaudeCodeHeadless } from 'claude-code-headless'

const cwd = process.cwd()

// 1. You own the PTY. Spawn the claude binary however you like.
const pty = spawn('claude', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,
  env: process.env,
})

// 2. Construct the orchestrator with your PTY + cwd.
const claude = new ClaudeCodeHeadless({ pty, cwd })

// 3. Subscribe BEFORE start() so you miss nothing.
claude.committed.on('turn_committed', ev => {
  console.log(`[${ev.role}] ${ev.text}`)
})
claude.screen.on('activity', ev => {
  console.log(ev.active ? `working: ${ev.status}` : 'idle')
})

// 4. start() resolves the JSONL project dir and attaches the tailer,
//    THEN begins mirroring PTY data. Always await it.
const { projectDir } = await claude.start()

// 5. Drive the session.
claude.sendPrompt('Say hello in three words')

// 6. Teardown — detaches tailer + terminal. Does NOT kill the PTY.
//    process.on('exit', () => { claude.stop(); pty.kill() })
```

### Lifecycle

1. **construct** — `new ClaudeCodeHeadless(options)`. Inert: builds the
   `HeadlessTerminal` but does not subscribe to PTY data yet.
2. **subscribe** — attach listeners on the three channels and/or the
   legacy flat events.
3. **`await start()`** — resolves `~/.claude/projects/<sanitized-cwd>/`,
   attaches the JSONL tailer, **then** calls `terminal.attach()` so PTY
   bytes start flowing. The tailer-before-terminal ordering guarantees
   no transcript entry is missed.
4. **drive** — `sendPrompt()`, `write()`, `resize()`, answer dialogs.
5. **observe** — events on `semantic` / `screen` / `committed`.
6. **`await stop()`** — disposes the terminal mirror and JSONL tailer.
   The PTY is yours to kill.

The `exit` event fires when the PTY child exits; `stop()` runs
automatically as part of that.

---

## 3. `ClaudeCodeHeadless`

`src/ClaudeCodeHeadless.ts`. Extends `EventEmitter`. The orchestrator.

### 3.1 Constructor options — `ClaudeCodeHeadlessOptions`

```ts
const claude = new ClaudeCodeHeadless(options: ClaudeCodeHeadlessOptions)
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `pty` | `IPty` | — (required) | Consumer-owned PTY running the `claude` binary. The class never spawns or kills it. |
| `cwd` | `string` | — (required) | Working directory the Claude session runs in. Used to resolve the JSONL project dir for transcript tailing. |
| `cols` | `number` | `120` | Terminal columns for the headless xterm mirror. |
| `rows` | `number` | `40` | Terminal rows for the headless xterm mirror. |
| `snapshotIntervalMs` | `number` | `16` | Throttle interval (ms) for screen snapshots — ~60 Hz. |
| `resumeSessionId` | `string` | unset | If set, tail the existing `<id>.jsonl` instead of waiting for Claude to create a new file. For `--resume` flows. Bootstraps from a bounded 200-line tail. |
| `proxy` | `object` | unset | Opt-in proxy integration. See below. |

#### `proxy` sub-options

When `proxy` is present, a `ClaudeProxyAdapter` is created and exposed
on `claude.proxy`. Presence of the option is a **binding statement that
proxy is the authoritative semantic source**: screen-derived semantic
deltas are suppressed on the authoritative `semantic` channel while
proxy is configured (they still go to `semanticShadow`). The screen
channel continues to fire for terminal mirroring and overlays.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `attributionPolicy` | `AttributionPolicy` | `createDefaultAttributionPolicy()` | Decides which `/v1/messages` flow is the visible assistant turn. |
| `onDiagnostic` | `(message: string) => void` | no-op | Sink for free-form adapter decision logs. |
| `getSessionModel` | `() => string \| null \| undefined` | unset | Returns the user-selected primary model (e.g. `'claude-opus-4-7'`). Used to identify and suppress auxiliary Haiku "sidecar" calls. When omitted, sidecar filtering is inert. |
| `sidecarModelPattern` | `RegExp \| null` | `/haiku/i` | Pattern identifying a sidecar model. Pass `null` to disable sidecar filtering even when `getSessionModel` is provided. |

### 3.2 Public fields

| Field | Type | Description |
| --- | --- | --- |
| `semantic` | `SemanticChannel` | Authoritative "what the model is producing" stream. Proxy publishes here; screen does **not**. |
| `screen` | `ScreenChannel` | Visual terminal truth — snapshots, activity, overlays. |
| `committed` | `CommittedChannel` | Durable JSONL transcript history. |
| `semanticShadow` | `SemanticChannel` | Shadow channel that receives **screen-fallback** semantic publishes (synthetic `live-<ts>` turns). Renderers should NOT subscribe to this — it exists for debug panels / test harnesses. See §3.5. |
| `proxy` | `ClaudeProxyAdapter \| null` | The adapter when `options.proxy` was set, else `null`. |

### 3.3 Methods

#### `start()`

```ts
start(): Promise<{ projectDir: string }>
```

Resolves Claude's JSONL project directory for `cwd`, attaches the
transcript tailer, then calls `terminal.attach()` to begin mirroring PTY
data. **Always await this before sending input.** Attaching the tailer
first guarantees no JSONL entry is missed. On the resume path
(`resumeSessionId` set) it tails the known file with a 200-line
bootstrap tail; otherwise it watches the project dir for the new
session file. Returns the resolved `projectDir` absolute path.

#### `sendPrompt(text)`

```ts
sendPrompt(text: string): void
```

Sends a prompt and submits it. Single-line text is written as
`text + '\r'`. **Multi-line** text is wrapped in bracketed paste
(`\x1b[200~…\x1b[201~\r`) so Claude treats embedded newlines as literal
input rather than submit events.

#### `write(data)`

```ts
write(data: string): void
```

Writes raw bytes to the PTY. Use for keystroke synthesis (answering
dialogs, sending escape sequences). The dialog `accept`/`approve`/etc.
callbacks on the flat events are built on this.

#### `awaitPastePlaceholder(opts?)`

```ts
awaitPastePlaceholder(
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<{ kind: 'appeared'; waitedMs: number } | { kind: 'timeout' }>
```

Polls the live screen for Claude's `[Pasted text #N]` placeholder.
Resolves `{ kind: 'appeared', waitedMs }` as soon as it is visible, or
`{ kind: 'timeout' }` after `timeoutMs`. Defaults: `timeoutMs` 2000,
`pollIntervalMs` 10. Use this between a paste payload and a submit
`\r` to avoid the race where Enter is absorbed into the paste
accumulator. Polls `snapshotPlain()` directly so it sidesteps the
known `'screen'`-event stall (see §4).

#### `resize(cols, rows)`

```ts
resize(cols: number, rows: number): void
```

Resizes the PTY and the headless terminal in lockstep.

#### State queries

| Method | Returns | Description |
| --- | --- | --- |
| `isIdle()` | `boolean` | True if Claude's spinner is NOT visible (waiting for input). |
| `isWorking()` | `boolean` | True if the spinner IS visible. |
| `getActivity()` | `string \| null` | Current activity verb (e.g. `"Cogitating…"`) or `null` if idle. |
| `getScreen()` | `string` | Current plain-text viewport snapshot. |
| `getScreenMarkdown()` | `string` | Current viewport with bold/italic reconstructed as markdown. |
| `getAssistantInProgress()` | `string` | In-progress assistant text extracted from the screen; `''` if none yet. |
| `getSlashPickerState()` | `SlashPickerState` | Last-detected slash picker state. |
| `getTrustDialogState()` | `TrustDialogState` | Last-detected trust dialog state. |
| `getResumePromptState()` | `ResumePromptState` | Last-detected resume prompt state. |
| `getCompactionState()` | `CompactionState` | Last-detected compaction state. |
| `isExited()` | `boolean` | True if the PTY has exited. |

#### `listResumableSessions(limit?)`

```ts
listResumableSessions(limit?: number): Promise<SessionInfo[]>
```

Lists resumable Claude sessions for this `cwd`, newest first. Thin
wrapper over `listSessionsForCwd` (§6.4). Default limit 20.

#### `handleProxyTransportEvent(event)`

```ts
handleProxyTransportEvent(event: ProxyTransportEvent): void
```

Forwards a mitmproxy-style transport event into the adapter. No-op when
`options.proxy` was not configured. Equivalent to
`claude.proxy?.handleTransportEvent(event)`.

#### `stop()`

```ts
stop(): Promise<void>
```

Disposes the terminal mirror, detaches the JSONL tailer, disposes the
proxy adapter. **Does not kill the PTY** — the consumer owns it.

### 3.4 Legacy flat event surface

`ClaudeCodeHeadless` is an `EventEmitter` typed by
`ClaudeCodeHeadlessEvents`. This flat surface predates the three
channels and **still fires** so existing consumers keep working. New
code should prefer the channels (§5). Subscribe with
`claude.on('<name>', cb)`.

| Event name | Listener args | Notes |
| --- | --- | --- |
| `event` | `[HeadlessEvent]` | Catch-all union of every flat event (see below). |
| `activity` | `[string]` | Activity verb when Claude starts working. |
| `idle` | `[]` | Debounced (~2.5 s) idle transition. |
| `screen` | `[ScreenSnapshot]` | Every throttled screen snapshot. |
| `jsonl-entry` | `[JsonlEntry, string]` | Raw JSONL entry + file path. |
| `jsonl-error` | `[Error]` | Transcript read error. |
| `trust-dialog` | `[TrustDialogState]` | Trust dialog state changed. |
| `resume-prompt` | `[ResumePromptState]` | Resume-choice prompt state changed. |
| `permission-prompt` | `[PermissionPromptState]` | Permission prompt state changed. |
| `compaction-state` | `[CompactionState]` | Compaction state changed. |
| `slash-picker` | `[SlashPickerState]` | Slash picker state changed. |
| `exit` | `[{ exitCode: number; signal?: number }]` | PTY child exited. |
| `live-owner-change` | `[LiveOwnerDecision]` | Diagnostic: live-turn ownership transition. Not part of the `event` union. |

#### The `HeadlessEvent` union (the `event` catch-all)

`HeadlessEvent` is a discriminated union on `type`. Every member also
carries `ts: number` (epoch ms).

| `type` | Type alias | Extra fields |
| --- | --- | --- |
| `activity` | `ActivityEvent` | `status: string` |
| `idle` | `IdleEvent` | — |
| `screen` | `ScreenEvent` | `plain: string`, `markdown: string` |
| `jsonl_entry` | `JsonlEntryEvent` | `entry: JsonlEntry`, `file: string` |
| `trust_dialog` | `TrustDialogEvent` | `workspace: string \| undefined`, `accept(): void`, `reject(): void` |
| `resume_prompt` | `ResumePromptEvent` | `state: ResumePromptState`, `confirm(): void`, `cancel(): void` |
| `permission_prompt` | `PermissionPromptEvent` | `state: PermissionPromptState`, `approve(): void`, `deny(): void` |
| `compaction_state` | `CompactionStateEvent` | `state: CompactionState` |
| `slash_picker` | `SlashPickerEvent` | `state: SlashPickerState` |
| `exit` | `ExitEvent` | `exitCode: number`, `signal?: number` |

Notes on the action callbacks:

- `TrustDialogEvent.accept()` writes `TRUST_DIALOG_ACCEPT_KEYS` (`\r`);
  `reject()` writes `'2\r'` (the "No, exit" option).
- `ResumePromptEvent.confirm()` writes `'\r'`; `cancel()` writes
  `'\x1b'` (Escape).
- `PermissionPromptEvent.approve()` writes
  `PERMISSION_PROMPT_APPROVE_KEYS` (`\r`); `deny()` writes
  `PERMISSION_PROMPT_DENY_KEYS` (`'3\r'`).

The `event` flat surface re-emits `screen` snapshots as
`{ type:'screen' }` carrying only `plain`/`markdown` (not the wider
`recent` fields).

> **Caveat — the `activity` event is not a submit verdict.** It is
> debounced and the underlying spinner regex has real mid-turn gaps.
> Do not gate "did my prompt submit?" on `activity`. Prefer "the
> `[Pasted text #N]` placeholder cleared" or "a new committed entry
> arrived". See the long comment in `ClaudeCodeHeadless.ts`.

### 3.5 Live-turn ownership model

The orchestrator enforces **at most one authoritative live semantic
producer at a time**. `LiveOwnerKind` is `'proxy' | 'screen'` (`jsonl`
is committed, not live). State is tracked in `LiveOwnerState`
(`kind`, `turnId`, `startedAt`, `status: 'idle'|'live'|'reconciling'`).
Every transition emits a `LiveOwnerDecision` on `live-owner-change`
(`accept`, `action: 'start'|'drop'|'promote'|'finalize'|'clear'`,
`kind`, `turnId`, `reason`, `prev`, `next`, `ts`).

Consequences for consumers:

- With proxy configured, the renderer should subscribe to `semantic`.
  Screen-derived live deltas land on `semanticShadow` only.
- Without proxy, screen drives a coarse fallback: a synthetic
  `live-<ts>` turn opens on `semanticShadow`, plus a coarse
  `stream_phase` (`thinking`/`idle`) on the real `semantic` channel.
  Screen-fallback live *content* is shadow-only by deliberate design —
  this eliminates cross-source flicker at the cost of degraded
  live UX for Claude-without-proxy.
- Reconcile across channels by **text + timing**, not id equality:
  the synthetic `live-<ts>` id is not the JSONL `uuid`.

---

## 4. `HeadlessTerminal`

`src/terminal/HeadlessTerminal.ts`. Extends `EventEmitter`. Wraps
`@xterm/headless` around a consumer-owned PTY. The foundation primitive;
`ClaudeCodeHeadless` builds on it. Usable standalone.

### 4.1 Options — `HeadlessTerminalOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `pty` | `IPty` | — (required) | PTY to mirror. Consumer owns its lifecycle. |
| `cols` | `number` | `120` | Terminal columns. |
| `rows` | `number` | `40` | Terminal rows. |
| `snapshotIntervalMs` | `number` | `16` | Throttle interval (ms) for `screen` events. |

### 4.2 Lifecycle

The constructor is **inert** — it builds the xterm but does not
subscribe to PTY events. Call `attach()` after wiring anything that
depends on PTY data (tailers, recorders). `attach()` is idempotent.

### 4.3 Methods

| Method | Signature | Description |
| --- | --- | --- |
| `attach()` | `(): void` | Subscribe to PTY events; start mirroring. Idempotent. |
| `write(data)` | `(string): void` | Write raw bytes to the PTY. |
| `resize(cols, rows)` | `(number, number): void` | Resize PTY + xterm in lockstep. Swallows node-pty errors on 0/negative dims. |
| `snapshotPlain()` | `(): string` | Visible viewport as plain text. Source of truth for "current screen" parsers. |
| `snapshotMarkdown()` | `(): string` | Viewport with bold/italic reconstructed as markdown. |
| `snapshotRecent(rows?)` | `(rows = 200): string` | Last `rows` lines (viewport + recent scrollback) as plain text. For streaming extractors that walk past the viewport. |
| `snapshotRecentMarkdown(rows?)` | `(rows = 200): string` | Markdown counterpart of `snapshotRecent`. |
| `snapshotFullBuffer()` | `(): string` | Entire xterm buffer (all scrollback) as plain text. For recording/archival. |
| `getTerminal()` | `(): Terminal` | Direct read-only access to the `@xterm/headless` Terminal — needed for cell-level reads (e.g. `detectSlashPicker`). |
| `isExited()` | `(): boolean` | True if the PTY has exited. |
| `dispose()` | `(): void` | Detach PTY listeners, clear timers. Does NOT kill the PTY. |

### 4.4 `ScreenSnapshot`

The payload of the `screen` event and the `recent`/`recentMarkdown`
inputs to streaming extractors.

| Field | Type | Description |
| --- | --- | --- |
| `plain` | `string` | Visible viewport, plain text. "What is CC showing right now?" Source for current-screen parsers. |
| `markdown` | `string` | Same viewport, bold/italic reconstructed as markdown. |
| `recent` | `string` | Wider window (last ~200 rows incl. scrollback). For extractors that must scroll past the viewport — e.g. `extractAssistantInProgress` on tall replies. |
| `recentMarkdown` | `string` | Markdown counterpart of `recent`. |

### 4.5 Events — `HeadlessTerminalEvents`

| Event | Args | Description |
| --- | --- | --- |
| `pty-data` | `[string]` | Raw PTY bytes received. For recording/fidelity. |
| `screen` | `[ScreenSnapshot]` | Throttled dual snapshot of the viewport. |
| `exit` | `[{ exitCode: number; signal?: number }]` | PTY child exited. |

> **Known issue — the `screen` event can stall** under sustained
> synchronized-output pressure (Claude wraps composer redraws in
> `\x1b[?2026h…\x1b[?2026l`). Under load the per-chunk write callbacks
> can leave `pendingWrites > 0` indefinitely and `screen` goes silent
> even though the buffer keeps updating. For periodic diagnostics,
> prefer polling `snapshotPlain()` on a wall-clock interval. If you
> subscribe to `screen` for low-latency reaction you **must** also
> have a wall-clock timeout fallback.

### 4.6 `terminalToMarkdown`

```ts
terminalToMarkdown(
  term: Terminal,
  opts?: { fullBuffer?: boolean; recentRows?: number },
): string
```

Pure function. Walks a Terminal's active buffer and reconstructs
markdown from cell SGR attributes: bold cells get `**wrapped**`, italic
`*wrapped*`, both `***wrapped***`. Agents render markdown as ANSI via
chalk; by the time it reaches the terminal `**bold**` is gone, replaced
by SGR attributes — this reads them back.

Windowing modes (mutually exclusive, checked in order):

- `fullBuffer: true` — walk every row including all scrollback.
- `recentRows: N` — walk the last `N` rows from the buffer bottom.
- default — viewport only (visible rows).

---

## 5. The three channels

Each channel is a small `EventEmitter` subclass with a typed event map.
Subscribe with `.on('<type>', cb)`. Every channel also emits a
catch-all `'event'` carrying the union of that channel's events — use
it when you want one handler for everything.

```ts
claude.semantic.on('turn_delta', ev => { /* per-type */ })
claude.semantic.on('event', ev => { /* catch-all union */ })
```

The split exists so consumers never blur "I saw it on the terminal"
with "the provider said it happened". See `src/channels/types.ts` and
`EVENT_SPEC.md`.

### Provenance tags

Every semantic event carries two tags:

- `source: SemanticSource` — `'proxy' | 'jsonl' | 'screen'`. Trust
  ranking proxy > jsonl > screen.
- `confidence: SemanticConfidence` — `'high' | 'medium' | 'fallback'`.
  `high` = authoritative; `medium` = correct but indirect;
  `fallback` = inferred from a visual surface — be defensive.

### 5.1 `SemanticChannel`

`src/channels/SemanticChannel.ts`. "What is the model producing right
now." Stream-shaped: events are strictly ordered per `turnId`. Never
emits visual-only state (trust dialogs, pickers) — that is the screen
channel's job.

#### Lifecycle strictness

The channel is a **strict transport, not a healer**:

- `startTurn` while a different turn is active → **dropped**, emits
  `lifecycle_violation` (`kind: 'start_while_active'`). Same-turn
  re-entry is an idempotent no-op.
- `applyDelta` for a turnId that is not the active turn → **dropped**,
  emits `lifecycle_violation` (`kind: 'delta_mismatched_turn'`).
- `finishTurn` for a mismatched turnId → **dropped**, emits
  `lifecycle_violation` (`kind: 'finish_mismatched_turn'`).

Producer coherence is enforced by the orchestrator's ownership model
(§3.5), not by the channel.

#### Read methods

| Method | Returns | Description |
| --- | --- | --- |
| `getActiveTurnId()` | `string \| null` | Currently active turnId on the wire. |
| `getLastSource()` | `SemanticSource \| null` | Source of the most recent delta. |
| `getLastFullText()` | `string` | Last known full text for the active turn. |
| `getLastPhase()` | `StreamPhase` | Last published stream phase. |

#### Publish methods

Most consumers only *subscribe*. Publishers (the proxy adapter, the
orchestrator's screen fallback) call: `startTurn`, `applyDelta`,
`finishTurn`, `publishBlockStarted`, `publishTextDelta`,
`publishThinkingDelta`, `publishSignature`,
`publishConnectorTextDelta`, `publishCitationsDelta`,
`publishToolInputDelta`, `publishToolInputFinalized`,
`publishBlockCompleted`, `publishToolResult`, `publishTurnStopped`,
`publishUsageUpdated`, `publishStreamError`, `publishApiError`,
`publishFlowSelected`, `publishFlowIgnored`, `publishStreamPhase`.
Each takes a `params` object whose fields mirror the corresponding
event below (minus `type` and `ts`); `confidence` defaults to `high`
for proxy/jsonl sources and `fallback` for screen.

#### Events — `SemanticChannelEvents`

All events carry `ts: number`, `source: SemanticSource`,
`confidence: SemanticConfidence` unless noted. `'event'` is the
catch-all (`SemanticEvent` union — excludes `lifecycle_violation`).

##### Turn-level aggregate (backward compatible)

**`turn_started`** → `SemanticTurnStartedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_started'` | |
| `turnId` | `string` | |
| `role` | `'user' \| 'assistant'` | Only assistant turns emit deltas; user-turn starts let consumers clear pending live views. |
| `isCompactionSynthesis?` | `boolean` | True when this assistant turn is Claude Code's compaction synthesis call (response is `<analysis>/<summary>` XML). Render a "Compacting…" placeholder. Absent (not `false`) when not applicable. |

**`turn_delta`** → `SemanticTurnDeltaEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_delta'` | |
| `turnId` | `string` | |
| `textDelta?` | `string` | Incremental piece. May be absent for snapshot-only sources. |
| `fullText` | `string` | Full running text. Always present so late subscribers can catch up. |
| `markdownText?` | `string` | Same text with markdown emphasis when the source can provide it. |

**`turn_completed`** → `SemanticTurnCompletedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_completed'` | |
| `turnId` | `string` | |
| `fullText?` | `string` | Final settled text for the turn. |

**`source_changed`** → `SemanticSourceChangedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'source_changed'` | |
| `turnId` | `string \| null` | |
| `previousSource` | `SemanticSource \| null` | |
| `source` | `SemanticSource` | New authoritative source. |

##### Block-level stream (proxy-driven)

Block events carry `SemanticBlockRef` fields `turnId: string` and
`blockIndex: number` (matches the upstream `index` one-to-one).

`SemanticBlockKind` = `'text' | 'thinking' | 'tool_use' |
'server_tool_use' | 'mcp_tool_use' | 'connector_text' |
'redacted_thinking' | 'image' | 'document' | 'tool_result' |
'web_search_tool_result' | 'code_execution_tool_result' |
'container_upload' | 'other'`.

**`block_started`** → `SemanticBlockStartedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'block_started'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `kind` | `SemanticBlockKind` | |
| `toolName?` | `string` | For tool_use / server_tool_use / mcp_tool_use. |
| `toolUseId?` | `string` | For tool_use / server_tool_use / mcp_tool_use. Pair against later tool_result events. |

**`text_delta`** → `SemanticTextDeltaEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'text_delta'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `textDelta` | `string` | This delta's text. |
| `textSoFar` | `string` | Running accumulator for the block. |

**`thinking_delta`** → `SemanticThinkingDeltaEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'thinking_delta'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `thinkingDelta` | `string` | This delta's thinking text. |
| `thinkingSoFar` | `string` | Running accumulator. |

**`signature`** → `SemanticSignatureEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'signature'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `signature` | `string` | Latest value. Signatures replace, not append. |

**`connector_text_delta`** → `SemanticConnectorTextDeltaEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'connector_text_delta'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `connectorTextDelta` | `string` | This delta. |
| `connectorTextSoFar` | `string` | Running accumulator. |

**`citations_delta`** → `SemanticCitationsDeltaEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'citations_delta'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `citationsDelta` | `unknown` | Raw citation payload. |
| `citationsSoFar` | `unknown[]` | Accumulated citations. |

**`tool_input_delta`** → `SemanticToolInputDeltaEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'tool_input_delta'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `toolName` | `string` | |
| `toolUseId` | `string` | |
| `partialJson` | `string` | Raw partial JSON fragment — may be invalid mid-stream. |
| `inputJsonSoFar` | `string` | Full accumulator (string, not parsed). |

**`tool_input_finalized`** → `SemanticToolInputFinalizedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'tool_input_finalized'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `toolName`, `toolUseId` | `string` | |
| `inputJson` | `string` | Final accumulated JSON string. |
| `parsed` | `Record<string, unknown> \| undefined` | Parsed object, or `undefined` on parse failure. |
| `parseError?` | `string` | Present when parsing failed. |

**`block_completed`** → `SemanticBlockCompletedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'block_completed'` | |
| `turnId`, `blockIndex` | | Block ref. |
| `kind` | `SemanticBlockKind` | |
| `text?` | `string` | For `text`; thinking content for `thinking`. |
| `signature?` | `string` | For `thinking`. |
| `toolName?`, `toolUseId?`, `inputJson?`, `parsed?` | | For tool_use kinds. |
| `raw?` | `Record<string, unknown>` | Full upstream block for `other`. |

##### Cross-turn linkage

**`tool_result`** → `SemanticToolResultEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'tool_result'` | |
| `turnId?` | `string` | Diagnostic turn hint. Renderers pair by `toolUseId`. |
| `toolUseId` | `string` | |
| `content` | `string` | Flattened result content. |
| `isError` | `boolean` | |

> Note: tool results arrive in the *next* user turn, not on the SSE
> stream. The orchestrator surfaces durable tool results on the
> **committed** channel (§5.3 `tool_result`). The semantic
> `tool_result` event exists on the channel for proxy-sourced
> emissions.

##### Turn lifecycle beyond start/delta/complete

**`turn_stopped`** → `SemanticTurnStoppedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_stopped'` | |
| `turnId` | `string` | |
| `stopReason` | `'end_turn' \| 'tool_use' \| 'max_tokens' \| 'model_context_window_exceeded' \| 'pause_turn' \| 'refusal' \| 'stop_sequence' \| null` | Authoritative end-of-generation from `message_delta`. `null` = stream ended without one (soft error). |
| `isRefusal` | `boolean` | Convenience for `stopReason === 'refusal'`. |
| `syntheticErrorText?` | `string` | Error text Claude would inject for `max_tokens` / `model_context_window_exceeded` / `refusal`. |

**`usage_updated`** → `SemanticUsageEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'usage_updated'` | |
| `turnId` | `string` | |
| `usage` | object | `input_tokens?`, `output_tokens?`, `cache_creation_input_tokens?`, `cache_read_input_tokens?`, `cache_creation?` (`ephemeral_1h_input_tokens?`, `ephemeral_5m_input_tokens?`), `cache_deleted_input_tokens?`, `service_tier?`, `inference_geo?`, `speed?`, `server_tool_use?` (`web_search_requests?`, `web_fetch_requests?`). Missing = "unchanged", not zero. |
| `costUSD?` | `number` | USD cost estimate if a calculator was available. |

##### Errors

**`stream_error`** → `SemanticStreamErrorEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'stream_error'` | |
| `turnId` | `string \| null` | |
| `errorType` | `string` | Upstream tag, e.g. `content_block_not_found_delta`. |
| `message` | `string` | The stream may continue after these. |

**`api_error`** → `SemanticApiErrorEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'api_error'` | |
| `turnId` | `string \| null` | |
| `status?` | `number` | HTTP status. |
| `errorType?` | `string` | |
| `message` | `string` | |
| `isOverloaded?` | `boolean` | True for 529 overloaded errors. |

##### Attribution diagnostics

**`flow_selected`** → `SemanticFlowSelectedEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'flow_selected'` | |
| `turnId` | `string \| null` | |
| `flowId` | `string` | |
| `reason` | `string` | Why this flow was chosen. Diagnostic. |

**`flow_ignored`** → `SemanticFlowIgnoredEvent`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'flow_ignored'` | |
| `flowId` | `string` | |
| `reason` | `string` | Why excluded. Diagnostic. No `turnId`. |

##### Stream phase

**`stream_phase`** → `SemanticStreamPhaseEvent`

The single "what is the model doing right now" signal. `StreamPhase` =
`'idle' | 'requesting' | 'thinking' | 'responding' | 'tool-input' |
'tool-use' | 'awaiting-tool'`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'stream_phase'` | |
| `turnId` | `string \| null` | `null` while idle / before first `message_start`. |
| `phase` | `StreamPhase` | |
| `toolName?` | `string` | When phase is tool-related. |
| `toolUseId?` | `string` | When phase is tool-related. |

The proxy adapter derives the full phase set; the screen fallback emits
only a coarse `thinking` / `idle`. Deduped on `(phase, turnId,
toolUseId)`.

##### Lifecycle violation

**`lifecycle_violation`** → `SemanticLifecycleViolationEvent`. Channel-
only — **not** in the `SemanticEvent` union, **not** on `'event'`.
Subscribe explicitly: `semantic.on('lifecycle_violation', …)`.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'lifecycle_violation'` | |
| `kind` | `'start_while_active' \| 'delta_mismatched_turn' \| 'finish_mismatched_turn'` | |
| `attemptedTurnId` | `string` | Turn the caller tried to publish for. |
| `activeTurnId` | `string \| null` | Turn the channel thinks is active. |
| `source` | `SemanticSource` | Which producer called the bad method. |
| `ts` | `number` | |

### 5.2 `ScreenChannel`

`src/channels/ScreenChannel.ts`. "What is on the terminal." The source
of truth for UI overlays and PTY mirroring. Never drives semantic turn
rendering. A pure forwarder — debouncing and parser dispatch live in
`ClaudeCodeHeadless`.

Publish methods (called by the orchestrator): `publishSnapshot`,
`publishActivity`, `publishTrustDialog`, `publishResumePrompt`,
`publishCompaction`, `publishSlashPicker`.

#### Events — `ScreenChannelEvents`

All carry `ts: number`. `'event'` is the catch-all (`ScreenEvent`
union).

**`snapshot`** → `ScreenSnapshotEvent` — `type:'snapshot'`,
`plain: string`, `markdown: string`. Fires for every terminal snapshot
(consumers mirroring the PTY want the full cadence).

**`activity`** → `ScreenActivityEvent` — `type:'activity'`,
`active: boolean`, `status: string | null` (spinner verb when active,
`null` when idle). The idle transition is debounced ~2.5 s.

**`trust_dialog`** → `ScreenTrustDialogEvent` — `type:'trust_dialog'`,
`state: TrustDialogState`.

**`resume_prompt`** → `ScreenResumePromptEvent` —
`type:'resume_prompt'`, `state: ResumePromptState`.

**`compaction`** → `ScreenCompactionEvent` — `type:'compaction'`,
`state: CompactionState`.

**`slash_picker`** → `ScreenSlashPickerEvent` — `type:'slash_picker'`,
`state: SlashPickerState`.

> Type export note: `channels/types.ts`'s `ScreenEvent` is re-exported
> from the package root as **`ChannelScreenEvent`** because the legacy
> flat-surface `ScreenEvent` from `ClaudeCodeHeadless.ts` already owns
> that name. The per-event aliases `ChannelTrustDialogEvent` and
> `ChannelResumePromptEvent` exist for the same reason.

### 5.3 `CommittedChannel`

`src/channels/CommittedChannel.ts`. "What has persisted to the JSONL
transcript." Append-only durable history — safe to back a feed or
history log. Fed one JSONL entry at a time via `publishEntry(entry,
file)`; errors via `publishError(err)`.

#### Events — `CommittedChannelEvents`

All carry `ts: number`. `'event'` is the catch-all (`CommittedEvent`
union — excludes `tail_error`).

**`entry`** → `CommittedEntryEvent` — `type:'entry'`, `entry: Entry`,
`file: string`. Fires for **every** JSONL line (raw, typed envelope).

**`turn_committed`** → `CommittedTurnEvent` — fires when the entry is a
user/assistant conversation message.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'turn_committed'` | |
| `turnId` | `string` | The entry's `uuid`. |
| `role` | `'user' \| 'assistant'` | |
| `text` | `string` | Model-authored text only (tool_use/tool_result deliberately excluded). |
| `entry` | `Entry` | Underlying transcript entry. |
| `file` | `string` | |

**`compact_boundary`** → `CommittedCompactBoundaryEvent` —
`type:'compact_boundary'`, `entry: Entry`, `file: string`. Fires for
compact-boundary system entries.

**`tool_result`** → `CommittedToolResultEvent` — fires after a
user-role entry carrying `tool_result` blocks is processed.

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'tool_result'` | |
| `turnId` | `string` | The **assistant** turn the tool_use belonged to (via `parentUuid`, falling back to the user entry's `uuid`). |
| `toolUseId` | `string` | Pair against the originating `tool_use` block. |
| `content` | `string` | Flattened text content. |
| `isError` | `boolean` | |
| `file` | `string` | |

**`tail_error`** → `[Error]`. Note: named `tail_error`, **not**
`error`, because Node's `EventEmitter` throws synchronously on an
unhandled `'error'` event.

---

## 6. Parsers

`src/parsers/*.ts`. **All pure functions** — no Node, no DOM, no IO
(except `detectSlashPicker`, which reads a Terminal's cell buffer and
therefore must run in a context where the headless xterm exists).
Importable standalone. They are heuristics tuned against recorded
Claude Code TUI fixtures; future CLI releases can change layout.

### 6.1 Screen structure — `ScreenParser.ts`

| Symbol | Signature | Detects / does |
| --- | --- | --- |
| `ASSISTANT_LINE_MARKER` | `'⏺'` (const) | The glyph CC's Ink uses at the start of an assistant message line. |
| `isDividerLine(line)` | `(string) => boolean` | A horizontal-rule line (≥10 `─`/`━`/`═` chars, almost nothing else). |
| `isPromptLine(line)` | `(string) => boolean` | The empty composer indicator: `❯` (or `>`) then whitespace only. |
| `isUserPromptLine(line)` | `(string) => boolean` | `❯` followed by text — a queued user message echo. |
| `isStatusLine(line)` | `(string) => boolean` | The persistent bottom status row (mode/effort/hints). |
| `isChromeLine(line)` | `(string) => boolean` | Any persistent UI furniture: blank, divider, prompt line, status line, or box-drawing-only. |
| `isIntermediateChromeLine(line)` | `(string) => boolean` | Mid-turn tool/thinking decorations (tree markers `⎿`, spinner lines, tool-label hints). |
| `detectActivity(screen)` | `(string) => string \| null` | The activity verb (e.g. `"Cogitating…"`) when CC's spinner is up, else `null`. Scans bottom-up over the last ~15 lines. |
| `extractStreamingText(screen)` | `(string) => string` | Everything CC rendered except the persistent bottom input box. Low-level primitive. |
| `extractAssistantInProgress(screen)` | `(string) => string` | Just the most-recent in-progress assistant text block. Composes on `extractStreamingText`, strips intermediate chrome, walks to the last `⏺` marker, stops at queued user prompts. `''` when no assistant marker is visible yet (caller should show a "thinking…" placeholder). |

### 6.2 Trust dialog — `TrustDialogParser.ts`

```ts
detectTrustDialog(screen: string): TrustDialogState
```

Detects CC's "Quick safety check" trust dialog (shown for a directory
CC has not seen before). All required markers (`Accessing workspace:`,
`Yes, I trust this folder`, `No, exit`) must be present.

`TrustDialogState`:

| Field | Type | Description |
| --- | --- | --- |
| `visible` | `boolean` | |
| `options?` | `Array<{ key: string; label: string }>` | The two selectable options (hardcoded `1`/`2`). |
| `workspace?` | `string` | The directory CC asks to trust, best-effort. |

`TRUST_DIALOG_ACCEPT_KEYS` = `'\r'` — accepts the pre-highlighted
"Yes" option.

### 6.3 Permission prompt — `PermissionPromptParser.ts`

```ts
detectPermissionPrompt(screen: string): PermissionPromptState
```

Detects CC's tool-permission prompt. Required markers: `Do you want to
proceed?`, `Yes`, `No, and tell Claude`.

`PermissionPromptState`:

| Field | Type | Description |
| --- | --- | --- |
| `visible` | `boolean` | |
| `title?` | `string` | The "Do you want to proceed?" line. |
| `toolName?` | `string` | Tool being requested (e.g. `Bash`). |
| `command?` | `string` | The command / argument. |
| `options?` | `Array<{ key: string; label: string }>` | Parsed options, or a hardcoded 3-option fallback. |
| `selectedIndex?` | `number` | 0-indexed option under the `❯` marker. |

`PERMISSION_PROMPT_APPROVE_KEYS` = `'\r'`;
`PERMISSION_PROMPT_DENY_KEYS` = `'3\r'`.

### 6.4 Compaction — `CompactionParser.ts`

```ts
detectCompaction(screen: string): CompactionState
```

Detects Claude's conversation-compaction UI states.

`CompactionState`:

| Field | Type | Description |
| --- | --- | --- |
| `visible` | `boolean` | |
| `phase?` | `'running' \| 'error' \| 'done'` | |
| `statusText?` | `string` | The matched status line for `running`/`done`. |
| `errorText?` | `string` | Error message for `error`. |

### 6.5 Resume prompt — `ResumePromptParser.ts`

```ts
detectResumePrompt(screen: string): ResumePromptState
```

Detects CC's resume-choice prompt (shown when resuming a large/old
session).

`ResumePromptState`:

| Field | Type | Description |
| --- | --- | --- |
| `visible` | `boolean` | |
| `sessionAgeText?` | `string` | Age from "This session is `<age>` old…". |
| `tokenCountText?` | `string` | Token count from "…and `<tokens>` tokens.". |
| `selectedIndex?` | `number` | 0-indexed option under the `❯` marker. |

### 6.6 Slash picker — `SlashPickerParser.ts`

```ts
detectSlashPicker(term: Terminal): SlashPickerState
```

Detects CC's slash-command picker. **Takes a `Terminal` instance**
(from `HeadlessTerminal.getTerminal()`) — it needs cell-level fg-color
reads. A picker row is one whose first non-space cell is `/` with a
non-default fg color; the selected row is the one whose color differs
from the most-common ("dim") color.

`PickerItem`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Slash command name, e.g. `"/init"`. |
| `label` | `string` | Display label (same as `id` for now). |
| `description` | `string` | One-line description. |
| `selected` | `boolean` | True for the row CC renders as the selection. |

`SlashPickerState`: `{ visible: boolean; items: PickerItem[] }`.

### 6.7 Line diff — `LineDiff.ts`

```ts
diffLines(oldText: string, newText: string): DiffLine[]
```

Line-level LCS diff (O(m×n) DP). For rendering Edit / MultiEdit tool
output. Returns a flat sequence in display order. Trailing empty lines
are dropped.

`DiffLine`: `{ kind: 'ctx' | '-' | '+'; text: string }` — `ctx` =
unchanged context, `-` = removed, `+` = added.

---

## 7. Transcript

`src/transcript/*.ts`. Reading Claude Code's JSONL transcript files at
`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`.

### 7.1 Entry / block type model — `TranscriptTypes.ts`

The on-disk format is a loosely-modeled discriminated union; **use the
type guards at runtime, do not trust the discriminator alone.** Pure
types only.

Content blocks:

| Type | Shape |
| --- | --- |
| `TextBlock` | `{ type: 'text'; text: string }` |
| `ThinkingBlock` | `{ type: 'thinking'; thinking: string; signature?: string }` |
| `ToolUseBlock` | `{ type: 'tool_use'; id: string; name: string; input: unknown }` |
| `ToolResultBlock` | `{ type: 'tool_result'; tool_use_id: string; content: string \| Array<{ type: string; text?: string }>; is_error?: boolean }` |
| `ContentBlock` | Union of the above + `{ type: string; [k: string]: unknown }` (open). |

`Message`: `{ role: 'user' | 'assistant'; content: string |
ContentBlock[]; model?: string; usage?: Record<string, unknown> }`.

Entries:

| Type | Key fields |
| --- | --- |
| `ConversationEntry` | `type: 'user' \| 'assistant'`, `uuid`, `parentUuid: string \| null`, `timestamp?`, `sessionId?`, `gitBranch?`, `cwd?`, `message: Message`, `isSidechain?`. |
| `CompactBoundaryEntry` | `type: 'system'`, `subtype: 'compact_boundary'`, `content: 'Conversation compacted'`, `uuid?`, `compactMetadata?` (`trigger?`, `preTokens?`, `preCompactDiscoveredTools?`, …). |
| `CompactSummaryEntry` | `ConversationEntry & { type: 'user'; isCompactSummary: true; isVisibleInTranscriptOnly? }`. |
| `SystemEntry` | `{ type: string; uuid?; [k: string]: unknown }` — catch-all. |
| `Entry` | Union of all four. |

Type guards:

| Guard | Narrows to |
| --- | --- |
| `isConversationEntry(e)` | `ConversationEntry` — `type` is user/assistant and `message` is a non-null object. |
| `isCompactBoundaryEntry(e)` | `CompactBoundaryEntry` — `type:'system'`, `subtype:'compact_boundary'`. |
| `isCompactSummaryEntry(e)` | `CompactSummaryEntry` — `type:'user'`, `isCompactSummary === true`, `message` is a non-null object. |

### 7.2 Tailer — `JsonlTailer.ts`

Node-only (`chokidar` + `fs`). `JsonlEntry` is `Record<string,
unknown>` — the raw parsed line; cast to `Entry` and use the guards
above for typed access.

```ts
tailNewSessionFile(
  projectDir: string,
  onEntry: (entry: JsonlEntry, file: string) => void,
  onError?: (err: Error) => void,
): Promise<() => Promise<void>>
```

Watches a project directory for the **new** `.jsonl` file Claude
creates when a session starts (snapshots existing files and ignores
them), then tails it. Attach this **before** spawning `claude` so the
create event isn't missed. Resolves to a `stop()` function that tears
down the directory watcher and the file tailer.

```ts
tailSessionFile(
  filePath: string,
  onEntry: (entry: JsonlEntry) => void,
  onError?: (err: Error) => void,
  options?: { bootstrapTailLines?: number },
): () => Promise<void>
```

Tails a **specific** session file by absolute path. Returns the
`stop()` function synchronously. With `bootstrapTailLines: N`, parses
only the most recent N complete lines on startup then tails from EOF —
used by resume flows so long transcripts open at the current end.

Both use `fs.watchFile` polling (100 ms) for reliable pickup of rapid
appends; reads are strictly serialized.

### 7.3 Session discovery — `SessionList.ts`

```ts
listSessionsForCwd(
  cwd: string,
  options?: { limit?: number },
): Promise<SessionInfo[]>
```

Lists Claude sessions for a `cwd`, newest first (`limit` default 20).
Returns `[]` if the project dir doesn't exist. Reads only head+tail of
each file; skips sidechain sessions and files with no extractable
summary.

`SessionInfo`:

| Field | Type | Description |
| --- | --- | --- |
| `sessionId` | `string` | The `<uuid>` filename stem. |
| `summary` | `string` | Custom title, else last prompt, else first prompt. |
| `lastModified` | `number` | File mtime (epoch ms). Primary sort key. |
| `fileSize` | `number` | |
| `customTitle?` | `string` | |
| `firstPrompt?` | `string` | First user prompt (capped 200 chars). |
| `gitBranch?` | `string` | |
| `cwd?` | `string` | Cwd recorded in the session's first entry. |
| `createdAt?` | `number` | Epoch ms from the first entry's ISO timestamp. |

### 7.4 Project directory — `ProjectDir.ts`

```ts
getProjectDirForCwd(cwd: string): Promise<string>
```

Resolves a working directory to the on-disk directory Claude uses to
store session JSONL files for it:
`~/.claude/projects/<sanitized-cwd>/`. Applies `realpath` + NFC
normalization, then replaces every non-alphanumeric char with `-`.
Honors `$CLAUDE_CONFIG_DIR`. (`sanitizePath`, `canonicalizePath`,
`getClaudeConfigHomeDir`, `getProjectsDir` exist in the file but only
`getProjectDirForCwd` is exported from the package root.)

---

## 8. Proxy

`src/proxy/*.ts`. **Optional.** The proxy subsystem turns
mitmproxy-captured Anthropic SSE traffic into the authoritative live
semantic stream. See `PROXY_STREAMING.md` for the architecture and TLS
rationale.

### 8.1 `ClaudeProxyAdapter`

`src/proxy/ClaudeProxyAdapter.ts`. Consumes transport-level events and
drives a `SemanticChannel` with structured per-block events. Testable
without a PTY. When you use `ClaudeCodeHeadless` with the `proxy`
option, an adapter is created for you on `claude.proxy` — you only need
to feed it transport events via `claude.handleProxyTransportEvent(...)`.
You can also instantiate it directly.

#### `ClaudeProxyAdapterOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `channel` | `SemanticChannel` | — (required) | The channel the adapter publishes onto. |
| `attributionPolicy` | `AttributionPolicy` | `createDefaultAttributionPolicy()` | Decides which `/v1/messages` request is a *candidate* visible turn. |
| `onDiagnostic` | `(message: string) => void` | no-op | Free-form decision logging. |
| `getSessionModel` | `() => string \| null \| undefined` | unset | The session's primary model. Enables sidecar (Haiku) filtering. |
| `sidecarModelPattern` | `RegExp \| null` | `/haiku/i` | Sidecar model pattern. `null` disables filtering even with `getSessionModel`. |

#### Methods

| Method | Signature | Description |
| --- | --- | --- |
| `handleTransportEvent(event)` | `(ProxyTransportEvent): void` | Entry point. Feed every transport event here. |
| `dispose()` | `(): void` | Release per-flow state (decoders, SSE buffers, accumulators). |

#### `ProxyTransportEvent`

The input shape — matches `mitmAddon.py`'s JSONL output. `kind` is
`'request' | 'response' | 'response-chunk' | 'response-end'`.

| Field | Type | Description |
| --- | --- | --- |
| `kind` | see above | Event family. |
| `flow_id` | `number \| string` | Stable per-flow id. |
| `method?` | `string` | On `request`. |
| `url?`, `host?`, `path?` | `string` | On `request`. |
| `status_code?` | `number` | On `response`. |
| `headers?` | `Record<string, string>` | |
| `chunk_b64?` | `string` | Base64 transport bytes on `response-chunk`. |
| `body_b64?` | `string` | Base64 **request** body for `/v1/messages`, capped 256 KiB. Optional — tolerate absence. |
| `request_shape?` | object | Pre-extracted request-body shape (see source for the full field list: `max_tokens`, `message_count`, `system_prefixes`, `tools_count`, `compaction_synthesis`, …). Avoids the body-size cap. |
| `body?` | `string` | Final buffered body on `response`. Not consumed — chunks are the streaming source of truth. |

The adapter consumes streaming **chunks** as the single source of truth;
the buffered `body` is accepted only so generic proxy streams pass
through.

#### Attribution policy

A single Claude turn can produce multiple `/v1/messages` flows (one per
tool-use round) plus incidental ones (title generation, retries,
auth warmup). `FlowAttribution` = `'candidate' | 'active' | 'secondary'
| 'ignore'`. A flow moves: request → `candidate`; first SSE chunk →
`active` (if no other flow holds the lock) or `secondary`; `response-end`
→ slot released. Locking on first-chunk-arrival protects against
non-streaming warmup POSTs stealing the slot.

`AttributionContext`: `{ flowId, method?, url?, host?, path?, headers?
}`.

`AttributionPolicy`: `{ classify: (ctx: AttributionContext) =>
'candidate' | 'ignore' }`. The policy answers only "could this be a
real turn?"; the adapter owns the at-most-one-active locking.

`createDefaultAttributionPolicy()` returns a policy that accepts any
`anthropic.com` `/v1/messages` request as a candidate.
`defaultAttributionPolicy` is a shared instance of that (back-compat
export).

### 8.2 SSE framing — `sseFraming.ts`

```ts
class IncrementalSseParser {
  append(text: string): SseEvent[]   // complete records found so far
  flush(): SseEvent[]                // best-effort final partial record
}
```

Pure. Frames decoded text into SSE records (terminated by `\n\n`; CRLF
normalized). Feed it UTF-8-decoded strings from a *streaming* decoder.

`SseEvent`: `{ event: string; data: string }` — `event` is the
`event:` field (`'message'` if omitted); `data` is the concatenated
`data:` lines.

### 8.3 Anthropic event parsing — `anthropicEvents.ts`

```ts
parseAnthropicEventsFromSse(records: SseEvent[]): AnthropicStreamEvent[]
```

Pure. Maps framed SSE records to typed Anthropic stream events. Unknown
events become `{ type: 'other' }` so the stream keeps flowing.

`AnthropicStreamEvent` is a union; every member carries
`raw: Record<string, unknown>`:

| Type | Key fields |
| --- | --- |
| `AnthropicMessageStart` | `messageId: string \| null`, `model: string \| null`, `usage?: AnthropicUsage` |
| `AnthropicContentBlockStart` | `index: number`, `block: ParsedContentBlockStart` |
| `AnthropicTextDelta` | `index: number`, `text: string` |
| `AnthropicInputJsonDelta` | `index: number`, `partialJson: string` |
| `AnthropicThinkingDelta` | `index: number`, `thinking: string` |
| `AnthropicSignatureDelta` | `index: number`, `signature: string` |
| `AnthropicConnectorTextDelta` | `index: number`, `connectorText: string` |
| `AnthropicCitationsDelta` | `index: number`, `citation: unknown` |
| `AnthropicUnknownDelta` | `index: number`, `deltaType: string` |
| `AnthropicContentBlockStop` | `index: number` |
| `AnthropicMessageDelta` | `stopReason: string \| null`, `stopSequence: string \| null`, `usage?: AnthropicUsage` |
| `AnthropicMessageStop` | — |
| `AnthropicPing` | — |
| `AnthropicErrorEvent` | `errorType: string`, `message: string` |
| `AnthropicOther` | `eventType: string` |

`ParsedContentBlockStart`: `{ type: string; id?: string; name?: string;
[k: string]: unknown }`.

`AnthropicUsage`: permissive — every field optional/nullable
(`input_tokens?`, `output_tokens?`, `cache_creation_input_tokens?`,
`cache_read_input_tokens?`, `cache_creation?`,
`cache_deleted_input_tokens?`, `service_tier?`, `inference_geo?`,
`speed?`, `iterations?`, `server_tool_use?`).

### 8.4 Proxy runtime — `ProxyServer` / `createProxyServer`

`src/proxy/proxyServer.ts`. The mitmproxy launcher. Spawns `mitmdump`,
scopes MITM to `api.anthropic.com` only, runs `mitmAddon.py`, and
surfaces captured events by polling the addon's JSONL output file.
Marked experimental — `mitmdump` is an external dependency the caller
must have installed (via `pip` or a system package manager).

```ts
createProxyServer(
  options?: string | CreateProxyServerOptions,
): Promise<ProxyServer>
```

A bare string is treated as `{ baseDir }`. `CreateProxyServerOptions`:
`baseDir?`, `storageRoot?`, `runDir?`, `confDir?`, `eventsFile?`,
`mitmDumpPath?`, `addonPath?`, `cwd?`, `sessionKey?`. With no options it
writes runtime state under `os.tmpdir()/claude-code-headless/proxy/`.
`mitmdump` discovery order: explicit `mitmDumpPath` →
`$CLAUDE_HEADLESS_MITMDUMP` / `$CC_PROXY_TEST_MITMDUMP` →
`.proxy-testing/venv/bin/mitmdump` candidates → homebrew/`/usr/local`.

`ProxyServer` extends `EventEmitter`. Construct via `createProxyServer`,
not directly.

| Member | Type | Description |
| --- | --- | --- |
| `info` | `ProxyServerInfo` | Resolved paths/ports (see below). |
| `start()` | `Promise<void>` | Spawns `mitmdump`, waits up to 15 s for the CA, starts polling events. CA bootstrap is serialized per-confdir. |
| `stop()` | `Promise<void>` | SIGTERM the child, SIGKILL after 2 s, stop polling. |

`ProxyServerInfo`: `{ workDir, confDir, mitmDumpPath, proxyPort,
proxyUrl, addonPath, eventsFile, caCertPath }` (all strings except
`proxyPort: number`).

`ProxyServerEvents`:

| Event | Args | Description |
| --- | --- | --- |
| `event` | `[ProxyCapturedEvent]` | A captured proxy event (`Record<string, unknown>` — feed straight into `handleProxyTransportEvent` / the adapter). |
| `stdout` | `[string]` | mitmdump stdout. |
| `stderr` | `[string]` | mitmdump stderr. |

### 8.5 `spawnClaudeWithProxy`

`src/proxy/spawnClaudeWithProxy.ts`.

```ts
spawnClaudeWithProxy(options: SpawnClaudeWithProxyOptions): IPty
```

Spawns the `claude` binary in a `node-pty` PTY with the environment set
to route HTTPS through the proxy and trust its CA. `SpawnClaudeWithProxyOptions`:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | — | Working directory. |
| `proxyUrl` | `string` | — | The proxy URL (from `ProxyServerInfo.proxyUrl`). |
| `caCertPath` | `string` | — | The mitmproxy CA path (`ProxyServerInfo.caCertPath`). |
| `cols` | `number` | `120` | |
| `rows` | `number` | `40` | |
| `binary` | `string` | `'claude'` | The CLI binary. |

It sets `HTTPS_PROXY`/`HTTP_PROXY` (+ lowercase), `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, and a
loopback-only `NO_PROXY`.

---

## 9. Recipes

### 9.1 Plain session (no proxy)

See §2's minimal example. The renderer subscribes to `committed` for
durable history and `screen` for overlays/activity. Live assistant
content via `semantic` will be coarse (`stream_phase` only) — that is
the deliberate no-proxy tradeoff.

### 9.2 Proxy-backed live streaming

```ts
import { ClaudeCodeHeadless, createProxyServer, spawnClaudeWithProxy } from 'claude-code-headless'

// 1. Launch the mitmproxy runtime.
const proxy = await createProxyServer({ cwd })
await proxy.start()

// 2. Spawn claude routed through the proxy + trusting its CA.
const pty = spawnClaudeWithProxy({
  cwd,
  proxyUrl: proxy.info.proxyUrl,
  caCertPath: proxy.info.caCertPath,
})

// 3. Construct with the proxy option — this creates claude.proxy and
//    makes proxy the authoritative semantic source.
const claude = new ClaudeCodeHeadless({
  pty,
  cwd,
  proxy: {
    getSessionModel: () => 'claude-opus-4-7',  // enables Haiku sidecar filtering
    onDiagnostic: msg => console.debug('[adapter]', msg),
  },
})

// 4. Pipe every captured proxy event into the adapter.
proxy.on('event', ev => claude.handleProxyTransportEvent(ev))

// 5. Subscribe to the authoritative semantic channel.
claude.semantic.on('block_started', ev => console.log('block', ev.kind, ev.toolName ?? ''))
claude.semantic.on('text_delta', ev => process.stdout.write(ev.textDelta))
claude.semantic.on('turn_stopped', ev => console.log('\nstopped:', ev.stopReason))
claude.semantic.on('usage_updated', ev => console.log('usage', ev.usage))

await claude.start()
claude.sendPrompt('Explain the difference between TCP and UDP')

// teardown: await claude.stop(); pty.kill(); await proxy.stop()
```

### 9.3 Reading historical transcripts without spawning anything

```ts
import { listSessionsForCwd, tailSessionFile, getProjectDirForCwd } from 'claude-code-headless'
import { join } from 'path'
import { isConversationEntry } from 'claude-code-headless'

const cwd = '/path/to/project'
const sessions = await listSessionsForCwd(cwd, { limit: 10 })
console.log(sessions.map(s => `${s.sessionId}  ${s.summary}`))

// Replay one session's transcript from the top (no bootstrap tail).
const projectDir = await getProjectDirForCwd(cwd)
const file = join(projectDir, `${sessions[0].sessionId}.jsonl`)
const stop = tailSessionFile(file, entry => {
  const e = entry as any
  if (isConversationEntry(e)) console.log(`[${e.type}]`, e.message)
})
// later: await stop()
```

No PTY, no `ClaudeCodeHeadless` — the transcript helpers stand alone.

### 9.4 Detecting and answering a permission prompt

```ts
// Using the legacy flat event — the action callbacks are built in.
claude.on('event', ev => {
  if (ev.type === 'permission_prompt') {
    console.log('Claude wants to run:', ev.state.toolName, ev.state.command)
    const safe = ev.state.toolName === 'Read'
    if (safe) ev.approve()   // writes PERMISSION_PROMPT_APPROVE_KEYS ('\r')
    else ev.deny()           // writes PERMISSION_PROMPT_DENY_KEYS ('3\r')
  }
})

// Or via the screen channel + manual keystroke synthesis:
import { PERMISSION_PROMPT_APPROVE_KEYS } from 'claude-code-headless'
claude.screen.on('resume_prompt', () => {})  // (channel has no action callbacks)
claude.on('permission-prompt', state => {
  if (state.visible && state.toolName === 'Read') {
    claude.write(PERMISSION_PROMPT_APPROVE_KEYS)
  }
})
```

The flat `permission_prompt` event carries ready-made `approve()` /
`deny()` callbacks. The channel surface gives you the parsed `state`
only; synthesize keystrokes yourself with `claude.write(...)` and the
exported `PERMISSION_PROMPT_*` constants.

---

## 10. Legacy vs. channel surface — guidance

- The **three channels** (`semantic`, `screen`, `committed`) are the
  current public contract. New consumers should build on them.
- The **flat `ClaudeCodeHeadlessEvents` surface** (`event`, `activity`,
  `screen`, `jsonl-entry`, the `*-prompt`/`*-dialog` events, `exit`)
  is **legacy** — kept so existing consumers keep working while they
  migrate. It will be deprecated. Its one genuine convenience the
  channels lack: the dialog events carry ready-made action callbacks
  (`accept`/`reject`/`approve`/`deny`/`confirm`/`cancel`).
- `semanticShadow` is **not** a public renderer contract — it is for
  debug panels and the test harness. Do not render from it.
- `live-owner-change` is diagnostic-only and not part of any event
  union.
