import { EventEmitter } from 'events'
import type { IPty } from 'node-pty'
import { join } from 'path'

import {
  HeadlessTerminal,
  type ScreenSnapshot,
} from './terminal/HeadlessTerminal.js'
import {
  detectActivity,
  extractAssistantInProgress,
} from './parsers/ScreenParser.js'
import { detectCompaction, type CompactionState } from './parsers/CompactionParser.js'
import { detectResumePrompt, type ResumePromptState } from './parsers/ResumePromptParser.js'
import {
  detectPermissionPrompt,
  PERMISSION_PROMPT_APPROVE_KEYS,
  PERMISSION_PROMPT_DENY_KEYS,
  type PermissionPromptState,
} from './parsers/PermissionPromptParser.js'
import { detectSlashPicker, type SlashPickerState } from './parsers/SlashPickerParser.js'
import { detectTrustDialog, type TrustDialogState, TRUST_DIALOG_ACCEPT_KEYS } from './parsers/TrustDialogParser.js'
import {
  tailNewSessionFile,
  tailSessionFile,
  type JsonlEntry,
} from './transcript/JsonlTailer.js'
import { isConversationEntry, type Entry } from './transcript/TranscriptTypes.js'
import { getProjectDirForCwd } from './transcript/ProjectDir.js'
import { listSessionsForCwd, type SessionInfo } from './transcript/SessionList.js'

// Three-channel truth model. See src/channels/types.ts for the WHY.
// Keeping these as separate readonly fields on the class is what makes
// them usable standalone — consumers can subscribe to just
// `claude.semantic` if they only want JIT markdown rendering, or just
// `claude.screen` if they are mirroring the PTY. The old flat
// `'event' | 'screen' | 'activity' | …` surface still fires for
// backwards compatibility with existing Agent Code consumers.
import { CommittedChannel } from './channels/CommittedChannel.js'
import { ScreenChannel } from './channels/ScreenChannel.js'
import { SemanticChannel } from './channels/SemanticChannel.js'
import type {
  LiveOwnerDecision,
  LiveOwnerKind,
  LiveOwnerState,
} from './channels/types.js'
import {
  ClaudeProxyAdapter,
  type AttributionPolicy,
  type ProxyTransportEvent,
} from './proxy/ClaudeProxyAdapter.js'

// ClaudeCodeHeadless — programmatic control of Claude Code.
//
// Takes a consumer-owned PTY running the `claude` binary. Internally
// creates a HeadlessTerminal (headless xterm) to parse the screen,
// attaches a JSONL tailer to read CC's transcript, and exposes a
// typed event stream + async API for sending prompts and commands.
//
// The consumer decides everything: when to spawn, what env to set,
// how to handle permission prompts and trust dialogs. This class
// never spawns processes, never auto-accepts anything, and never
// touches the filesystem beyond reading CC's project dir.

export type ClaudeCodeHeadlessOptions = {
  /** Consumer-owned PTY running the `claude` binary. */
  pty: IPty
  /** Working directory the Claude session is running in. Used to
   *  resolve the JSONL project dir for transcript tailing. */
  cwd: string
  /** Terminal columns. Default 120. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Throttle interval for screen snapshots in ms. Default 16. */
  snapshotIntervalMs?: number
  /** If set, tail the existing session file instead of waiting for
   *  CC to create a new one. Used for --resume flows. */
  resumeSessionId?: string
  /** Optional proxy integration. When present, a `ClaudeProxyAdapter`
   *  is created and exposed on `this.proxy`. The consumer owns the
   *  proxy runtime (mitmproxy or otherwise) and pipes transport
   *  events in via `handleProxyTransportEvent(event)`. When absent,
   *  the semantic channel falls back to screen-driven deltas as
   *  before. Presence of this option is a binding statement that
   *  proxy is the authoritative semantic source — screen-derived
   *  semantic deltas are suppressed while it's set, so the two
   *  sources do not race to own `activeTurnId` on the semantic
   *  channel. The screen channel continues to fire for terminal
   *  mirroring and overlays; only semantic publishing is gated.
   *  Consumers that want dynamic screen-fallback (resurrect screen
   *  semantic when proxy is silent mid-turn) can layer that on top
   *  of the two channels themselves. */
  proxy?: {
    /** Pluggable policy deciding which /v1/messages flow is the
     *  visible assistant turn. Default accepts any flow to
     *  anthropic.com/v1/messages. See PROXY_STREAMING.md for
     *  planned smarter policies (session header + prompt ordering). */
    attributionPolicy?: AttributionPolicy
    /** Optional diagnostic sink for adapter decisions. */
    onDiagnostic?: (message: string) => void
    /** Returns the user-selected primary model (e.g.
     *  `'claude-opus-4-7'`) for this session. Used by the adapter to
     *  identify auxiliary Haiku calls — session title generation,
     *  compaction summaries, hook agents, teleport title-and-branch
     *  — and suppress them so they don't leak into the visible
     *  transcript as phantom assistant turns. See
     *  `ClaudeProxyAdapterOptions.getSessionModel` for the full
     *  rationale. When omitted, sidecar filtering is inert and the
     *  pre-fix behaviour is preserved. */
    getSessionModel?: () => string | null | undefined
    /** Pattern that identifies a sidecar model. Defaults to
     *  `/haiku/i` because every known auxiliary call in Claude Code
     *  v2.1.x routes through `getSmallFastModel()` (Haiku). Pass
     *  `null` to disable sidecar filtering even when
     *  `getSessionModel` is provided. */
    sidecarModelPattern?: RegExp | null
  }
}

// --- Event types ---

export type ActivityEvent = { type: 'activity'; ts: number; status: string }
export type IdleEvent = { type: 'idle'; ts: number }
export type ScreenEvent = { type: 'screen'; ts: number; plain: string; markdown: string }
export type JsonlEntryEvent = { type: 'jsonl_entry'; ts: number; entry: JsonlEntry; file: string }
export type TrustDialogEvent = {
  type: 'trust_dialog'; ts: number; workspace: string | undefined
  accept: () => void; reject: () => void
}
export type ResumePromptEvent = {
  type: 'resume_prompt'; ts: number; state: ResumePromptState
  confirm: () => void; cancel: () => void
}
export type PermissionPromptEvent = {
  type: 'permission_prompt'; ts: number; state: PermissionPromptState
  approve: () => void; deny: () => void
}
export type CompactionStateEvent = {
  type: 'compaction_state'; ts: number; state: CompactionState
}
export type SlashPickerEvent = { type: 'slash_picker'; ts: number; state: SlashPickerState }
export type ExitEvent = { type: 'exit'; ts: number; exitCode: number; signal?: number }

export type HeadlessEvent =
  | ActivityEvent
  | IdleEvent
  | ScreenEvent
  | JsonlEntryEvent
  | TrustDialogEvent
  | ResumePromptEvent
  | PermissionPromptEvent
  | CompactionStateEvent
  | SlashPickerEvent
  | ExitEvent

export type ClaudeCodeHeadlessEvents = {
  event: [HeadlessEvent]
  // Convenience aliases — same data, typed per-event.
  activity: [string]
  idle: []
  screen: [ScreenSnapshot]
  'jsonl-entry': [JsonlEntry, string]
  'jsonl-error': [Error]
  'trust-dialog': [TrustDialogState]
  'resume-prompt': [ResumePromptState]
  'permission-prompt': [PermissionPromptState]
  'compaction-state': [CompactionState]
  'slash-picker': [SlashPickerState]
  exit: [{ exitCode: number; signal?: number }]

  // Live-owner decision stream. Fires whenever an ownership helper
  // accepts or rejects a claim, promotes between owners, or clears
  // the owner. Diagnostic-only — consumers that render a
  // ProxyDebugPanel can subscribe to watch live-turn authority
  // change hands. NOT wired through the `event` union because the
  // reducer in Agent Code doesn't need a new branch for this.
  'live-owner-change': [LiveOwnerDecision]
}

export interface ClaudeCodeHeadless {
  on<K extends keyof ClaudeCodeHeadlessEvents>(
    event: K,
    listener: (...args: ClaudeCodeHeadlessEvents[K]) => void,
  ): this
  off<K extends keyof ClaudeCodeHeadlessEvents>(
    event: K,
    listener: (...args: ClaudeCodeHeadlessEvents[K]) => void,
  ): this
  emit<K extends keyof ClaudeCodeHeadlessEvents>(
    event: K,
    ...args: ClaudeCodeHeadlessEvents[K]
  ): boolean
}

export class ClaudeCodeHeadless extends EventEmitter {
  // Resume should open near "where the conversation is now", not
  // replay every historical turn since the beginning of time. We load
  // a bounded tail snapshot to rebuild the recent feed context, then
  // switch to normal append-only tailing for new writes.
  private static readonly RESUME_BOOTSTRAP_TAIL_LINES = 200
  private readonly terminal: HeadlessTerminal
  private readonly cwd: string
  private readonly resumeSessionId: string | null
  private stopJsonlTail: (() => Promise<void>) | null = null
  private lastActivity: string | null = null
  // Debounce timer for `idle`.
  //
  // CC redraws the spinner cell every frame, but in practice there are
  // *long* windows (multi-second) where the spinner row is replaced by
  // a transient header — tool-call summaries, the "Bash(...)" preview,
  // a "Tip:" footer line, etc. — and the bottom-up SPINNER_VERB_RE walk
  // returns null even though CC is clearly still working. With the
  // previous 250ms threshold the indicator flashed green for a
  // quarter-second per turn and snapped back to "idle" almost
  // immediately. The user reported this directly: "it sometimes flashes
  // green for a quarter of a second, then it goes back to inactive."
  //
  // 2500ms is empirically wide enough to bridge the longest spinner
  // gap CC's TUI shows during a normal turn (tool output animation
  // cycles ~1.5s), without introducing perceptible lag at the end of a
  // turn — the user finishes reading the assistant block before the
  // green pip drops.
  //
  // ---------------------------------------------------------------------------
  // FALSE NEGATIVES WHEN USED AS A "DID THIS SUBMIT?" SIGNAL
  // ---------------------------------------------------------------------------
  //
  // Do NOT use the `'activity'` event as a binary verdict for "did
  // Claude accept and start processing my submit?" The 2500ms debounce
  // makes flashing less painful, but it does NOT make the underlying
  // SPINNER_VERB_RE walk reliable: there are real windows in the TUI
  // where the spinner row is wholly replaced (Bash() preview, tool
  // result chrome) and the regex returns null mid-turn.
  //
  // We learned this the hard way while building the paste-submit
  // reproduction harness at Agent Code's
  // `vendor/in_progress/paste-submit-repro/`. With the verdict logic
  // gated on "did `'activity'` fire after `\r`?", scenarios 01 and 04
  // both landed on exactly 8/10 at N=10. Iteration positions where
  // the verdict said FAIL were indistinguishable from PASS by every
  // other signal — Claude HAD submitted, the composer HAD cleared, a
  // JSONL entry landed shortly after — but the spinner row at the
  // moment we sampled showed a transient header, the regex matched
  // nothing, and `'activity'` never fired for that window. Switching
  // the verdict to "did the `[Pasted text #N]` placeholder clear from
  // the composer?" pushed both scenarios to 10/10.
  //
  // If you need to verify a submit succeeded, prefer one of:
  //   * "the composer's `[Pasted text #N]` placeholder is gone" —
  //     reliable, screen-truth; what Agent Code's harness ended up using
  //   * "a new JSONL assistant entry appeared on the committed
  //     channel" — authoritative, but lags submit by several seconds
  //   * any combination of the above — "submit succeeded if EITHER
  //     screen cleared OR committed channel saw an entry" is the
  //     forgiving combination for UX features that just need a coarse
  //     "are we working now?" signal
  //
  // ---------------------------------------------------------------------------
  private idleDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private trustDialogState: TrustDialogState = { visible: false }
  private lastTrustKey: string | null = null
  private resumePromptState: ResumePromptState = { visible: false }
  private lastResumePromptKey: string | null = null
  private permissionPromptState: PermissionPromptState = { visible: false }
  private lastPermissionPromptKey: string | null = null
  private compactionState: CompactionState = { visible: false }
  private lastCompactionKey: string | null = null
  private pickerState: SlashPickerState = { visible: false, items: [] }
  private lastPickerKey: string | null = null

  // --- Three-channel truth surface ---------------------------------------
  //
  // These channels are the new public contract (see docs/channels).
  // They run IN ADDITION TO the existing flat event surface so we
  // don't break Agent Code today. The split lets consumers treat live
  // semantic text, visible terminal state, and committed transcript
  // history as three independent streams instead of reverse-engineering
  // which is which from a blended event list.
  readonly semantic = new SemanticChannel()
  readonly screen = new ScreenChannel()
  readonly committed = new CommittedChannel()

  /** Shadow SemanticChannel — receives screen-fallback publishes and
   *  everything else keyed to the synthetic screen-sourced turnId
   *  (`live-<ts>`).
   *
   *  WHY this channel exists:
   *
   *  Screen-sourced live deltas were the original sin that made the
   *  main `semantic` channel impossible to reason about — proxy and
   *  screen would race for the same `activeTurnId` slot, the channel
   *  would silently auto-heal, and the renderer reducer would see
   *  turn starts and deltas flap between turnIds. The 2026-04-18
   *  headless-live-turn-redesign plan draws a hard line: screen is a
   *  fallback/overlay source, not a live content source. So we route
   *  all screen-sourced startTurn/applyDelta/finishTurn calls here
   *  instead of onto `semantic`.
   *
   *  The channel is public so the Agent Code debug panel and the
   *  headless testing harness can still observe screen-fallback
   *  activity. The point is that the RENDERER does not subscribe to
   *  this channel — Agent Code's assistant rendering path consumes only
   *  `semantic`, which means it will no longer see screen-derived
   *  content even when proxy is absent. That is deliberate: the user
   *  has explicitly accepted degraded live UX for Claude-without-
   *  proxy in exchange for eliminating the cross-source flicker.
   *
   *  Screen parsing for OVERLAYS (trust dialog, slash picker,
   *  compaction banner, resume prompt, activity state) continues to
   *  fire on the `screen` channel — that part was never the problem. */
  readonly semanticShadow = new SemanticChannel()
  /** Proxy adapter when `options.proxy` was set, else null. Exposed
   *  so consumers can inspect flow decisions (flow_selected /
   *  flow_ignored events on the semantic channel) and call
   *  `handleTransportEvent` directly if they need to bypass the
   *  convenience forwarder on this class. */
  readonly proxy: ClaudeProxyAdapter | null

  /** Internal id for the current screen-driven live turn. Claude's
   *  JSONL only appends finished assistant turns (one line per commit),
   *  so the live turn does not have a real provider-assigned uuid while
   *  it is still streaming. We synthesise a "live-<start-ts>" id so
   *  semantic deltas have something stable to attach to, then emit the
   *  provider-assigned uuid on the committed channel once the JSONL
   *  entry lands. Consumers reconciling across channels should match
   *  on text + timing, not id equality — see README. */
  private liveSemanticTurnId: string | null = null
  /** Last screen-derived assistant text we published as a semantic
   *  delta. Used to suppress duplicate deltas when the screen
   *  snapshotter fires but the assistant block hasn't actually changed. */
  private lastScreenSemanticText = ''
  /** Screen-fallback baseline — the assistant block visible on the
   *  TUI at the moment a live turn starts. While the extracted text
   *  still equals this baseline, the turn has not actually produced
   *  new bytes; publishing it as the first `text_delta` would leak
   *  the PREVIOUS turn's answer into the new turn. We hold deltas
   *  until the buffer moves past the baseline, at which point the
   *  screen has genuine new content to stream. Fixes the "stale
   *  previous assistant text rendered below new user prompt" bug. */
  private screenBaselineText = ''
  private screenBaselineSatisfied = false

  /** Live-turn ownership.
   *
   *  Only one producer may publish lifecycle events on the
   *  authoritative `this.semantic` channel at a time. This field
   *  tracks that producer. Helpers on the class (`claimLiveOwner`,
   *  `clearLiveOwner`, etc.) are the one place that mutates it — the
   *  rest of the code asks "may I publish?" by consulting
   *  `canSourceMutateLiveTurn`.
   *
   *  Screen is a legitimate `LiveOwnerKind` here EVEN THOUGH screen
   *  no longer publishes on the authoritative channel. The reason is
   *  that ownership is a session-wide concept: if screen has claimed
   *  the live turn (because it saw activity first), proxy must not
   *  silently take over the renderer's view by pushing onto
   *  `this.semantic` while screen is still publishing on shadow. By
   *  modelling screen ownership explicitly we can express "proxy has
   *  preempted screen" as a single transition instead of two
   *  unrelated side effects. */
  private liveOwner: LiveOwnerState = {
    kind: null,
    turnId: null,
    startedAt: null,
    status: 'idle',
  }

  constructor(options: ClaudeCodeHeadlessOptions) {
    super()
    this.cwd = options.cwd
    this.resumeSessionId = options.resumeSessionId ?? null

    this.terminal = new HeadlessTerminal({
      pty: options.pty,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      snapshotIntervalMs: options.snapshotIntervalMs ?? 16,
    })

    // Proxy adapter is created lazily — only when the consumer opted
    // in. Creating it unconditionally would allocate empty per-flow
    // Maps and TextDecoders for sessions that never see proxy
    // traffic, and more importantly would blur the semantic-source
    // contract: `this.proxy !== null` is the signal the screen path
    // checks to know it should NOT publish semantic deltas.
    this.proxy = options.proxy
      ? new ClaudeProxyAdapter({
          channel: this.semantic,
          attributionPolicy: options.proxy.attributionPolicy,
          onDiagnostic: options.proxy.onDiagnostic,
          // Pass-throughs for sidecar Haiku filtering. The adapter
          // owns the decision logic; this class is just plumbing the
          // caller's session-model knowledge through. See
          // ClaudeProxyAdapter for why both fields exist.
          getSessionModel: options.proxy.getSessionModel,
          sidecarModelPattern: options.proxy.sidecarModelPattern,
        })
      : null

    // Proxy ownership claim via the authoritative SemanticChannel.
    //
    // The ClaudeProxyAdapter publishes directly onto `this.semantic`
    // using the Anthropic `msg_…` id as the turnId. We mirror those
    // lifecycle events into the orchestrator's `liveOwner` so the
    // rest of the class can answer "is proxy live right now?" without
    // peeking into adapter internals.
    //
    // WHY we listen INSTEAD of wrapping adapter publishes in ownership
    // checks:
    //
    //   * The adapter stays provider-focused — it shouldn't need a
    //     back-reference to orchestrator policy.
    //   * Anthropic's SSE guarantees a single `message_start` before
    //     any content blocks, so the listener latches ownership at
    //     exactly the right moment without the adapter doing extra
    //     bookkeeping.
    //   * If screen was live when proxy arrives, `transitionLiveOwner`
    //     cleanly seals the screen fallback on the shadow channel and
    //     hands authority to proxy.
    //
    // The listener is attached after the adapter is constructed so
    // that the adapter's own turn_started emission goes through the
    // new strict SemanticChannel, which then fires the event this
    // listener picks up.
    this.semantic.on('turn_started', ev => {
      if (ev.source !== 'proxy') return
      this.transitionLiveOwner('proxy', ev.turnId, 'proxy turn_started')
    })
    this.semantic.on('turn_completed', ev => {
      if (ev.source !== 'proxy') return
      // Proxy completion transitions the slot to `reconciling` rather
      // than clearing it outright.
      //
      // WHY the two-phase wind-down:
      //
      //   The live SSE turn has ended from the model's perspective,
      //   but Claude does not commit the assistant message to the
      //   JSONL transcript until some delay after SSE closes. Between
      //   `turn_completed` and the eventual `turn_committed` on the
      //   committed channel, the assistant turn is "done but not yet
      //   durable". The redesign plan (Task 5 of 2026-04-18-headless-
      //   live-turn-redesign.md) calls that window reconciling.
      //
      //   Marking the slot reconciling instead of idle lets debug
      //   tooling surface the window clearly, and leaves room for
      //   phase 5's `turn_reconciled` / `turn_durably_committed`
      //   events without another state-machine change.
      //
      //   A brand-new turn (proxy or screen) can still claim
      //   ownership: `claimLiveOwner` treats reconciling as "free
      //   enough to evict" so the next turn is not blocked on a
      //   previous turn's durability wait. Full clearing happens
      //   either (a) on the next claim or (b) — phase 5 — when the
      //   committed channel confirms the JSONL commit.
      if (this.liveOwner.kind === 'proxy' && this.liveOwner.turnId === ev.turnId) {
        this.beginReconcilingLiveOwner('proxy turn_completed')
      }
    })

    // --- Wire terminal events ---

    // On every screen snapshot, run all parsers and emit structured events.
    this.terminal.on('screen', (snap) => {
      const trust = detectTrustDialog(snap.plain)
      const trustKey = trust.visible
        ? JSON.stringify({
            workspace: trust.workspace ?? null,
            options: trust.options ?? [],
          })
        : null
      this.trustDialogState = trust

      const resumePrompt = detectResumePrompt(snap.plain)
      const resumePromptKey = resumePrompt.visible
        ? JSON.stringify({
            age: resumePrompt.sessionAgeText ?? null,
            tokens: resumePrompt.tokenCountText ?? null,
            selectedIndex: resumePrompt.selectedIndex ?? 0,
          })
        : null
      this.resumePromptState = resumePrompt

      const permissionPrompt = detectPermissionPrompt(snap.plain)
      const permissionPromptKey = permissionPrompt.visible
        ? JSON.stringify({
            title: permissionPrompt.title ?? null,
            toolName: permissionPrompt.toolName ?? null,
            command: permissionPrompt.command ?? null,
            options: permissionPrompt.options ?? [],
            selectedIndex: permissionPrompt.selectedIndex ?? 0,
          })
        : null
      this.permissionPromptState = permissionPrompt

      const compaction = detectCompaction(snap.plain)
      const compactionKey = compaction.visible
        ? JSON.stringify({
            phase: compaction.phase ?? null,
            statusText: compaction.statusText ?? null,
            errorText: compaction.errorText ?? null,
          })
        : null
      this.compactionState = compaction

      const picker = detectSlashPicker(this.terminal.getTerminal())
      const pickerKey = picker.visible ? JSON.stringify(picker) : null
      this.pickerState = picker

      // Forward raw screen (legacy flat surface).
      this.emit('screen', snap)
      this.emit('event', { type: 'screen', ts: Date.now(), ...snap })

      // Screen channel — visual terminal truth.
      //
      // This fires for EVERY snapshot because the channel is for
      // consumers mirroring the PTY; they want the same cadence the
      // terminal is actually rendering at. Semantic throttling
      // (dedupe-on-unchanged-text) is handled below in the semantic
      // branch, not here — mirroring the terminal and producing
      // semantic deltas are different jobs with different cadence
      // requirements.
      this.screen.publishSnapshot({ plain: snap.plain, markdown: snap.markdown })

      // Semantic fallback via the SHADOW channel.
      //
      // Screen-derived live text does NOT land on `this.semantic` —
      // the Agent Code renderer subscribes to the authoritative
      // channel and we do not want screen content driving assistant
      // rendering. See the class-level note on `semanticShadow` and
      // the 2026-04-18 redesign plan for the rule.
      //
      // We still run the extractor and fire deltas on shadow so the
      // debug panel and any future bootstrap-only consumer can see
      // what screen would have said. When a stronger owner (proxy)
      // preempts screen via `transitionLiveOwner`, the
      // `liveOwner.kind === 'screen'` gate below stops publishing
      // immediately — finalize is handled during the transition.
      if (
        this.liveOwner.kind === 'screen' &&
        this.liveSemanticTurnId
      ) {
        // Extract from the wider `recent` window (~200 rows), not
        // just the viewport — taller replies scroll the `⏺` marker
        // out of the visible region and the narrow extractor returns
        // empty while the assistant is still actively writing.
        const fullText = extractAssistantInProgress(snap.recent)

        // Baseline gate. If the live turn just started and the TUI
        // still shows the PREVIOUS assistant's text, publishing
        // `fullText` as the first delta would leak that old answer
        // into the new turn (the user sees yesterday's reply briefly
        // under their new prompt). Suppress until the extracted text
        // actually differs from the baseline captured at turn start.
        if (!this.screenBaselineSatisfied) {
          if (!fullText || fullText === this.screenBaselineText) {
            return
          }
          this.screenBaselineSatisfied = true
        }

        if (fullText && fullText !== this.lastScreenSemanticText) {
          // Compute the markdown flavor from the wider `recent`
          // snapshot rather than re-running the extractor on
          // markdown — the extractor is written against plain text.
          // This is a coarse approximation; the committed channel is
          // still the source of truth for final formatting.
          const textDelta = fullText.startsWith(this.lastScreenSemanticText)
            ? fullText.slice(this.lastScreenSemanticText.length)
            : undefined
          this.lastScreenSemanticText = fullText
          this.semanticShadow.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText,
            textDelta,
            markdownText: extractAssistantInProgress(snap.recentMarkdown) || undefined,
            source: 'screen',
            confidence: 'fallback',
          })
        }
      }

      // Activity detection.
      //
      // Source of truth: CC's rotating spinner line (see
      // parsers/ScreenParser.ts detectActivity). Transitions to
      // active are emitted immediately — the user wants to see that
      // CC started working as fast as possible. Transitions to idle
      // are debounced (see idleDebounceTimer field) so a single
      // spinner-less snapshot between frames can't flip the UI.
      //
      // Previously Agent Code also subscribed to a caffeinate-based
      // ProcessInspector, which either over-reported (idle sessions
      // still had caffeinate from parent shells) or under-reported
      // (CC didn't always spawn one for quick turns). We ripped it
      // and consolidated on the screen spinner for both providers.
      const activity = detectActivity(snap.plain)
      if (activity !== this.lastActivity) {
        if (activity) {
          // Cancel any pending idle transition — we're clearly working.
          if (this.idleDebounceTimer) {
            clearTimeout(this.idleDebounceTimer)
            this.idleDebounceTimer = null
          }
          this.lastActivity = activity
          this.emit('activity', activity)
          this.emit('event', { type: 'activity', ts: Date.now(), status: activity })

          // Screen channel — the mirror of "is the spinner up".
          this.screen.publishActivity({ active: true, status: activity })

          // Screen-fallback `stream_phase` — published to the
          // authoritative semantic channel ONLY when no proxy is
          // running. The proxy adapter's phase derivation is
          // strictly higher-confidence (it sees content_block_start
          // per kind and can distinguish thinking/responding/tool-input);
          // the screen spinner can't tell those apart because the
          // rotating-glyph line is the same in every sub-phase. When
          // proxy is off, `thinking` is the conservative bucket —
          // upstream Claude Code itself labels mid-stream activity
          // as `thinking` in the spinner and that's the closest
          // analog for "something is happening, don't know what
          // exactly." The shadow channel always gets the event too
          // so debug tooling can see screen-derived phase regardless.
          if (!this.proxy) {
            this.semantic.publishStreamPhase({
              turnId: this.liveSemanticTurnId,
              phase: 'thinking',
              source: 'screen',
              confidence: 'fallback',
            })
          }
          this.semanticShadow.publishStreamPhase({
            turnId: this.liveSemanticTurnId,
            phase: 'thinking',
            source: 'screen',
            confidence: 'fallback',
          })

          // Screen-fallback live turn — opens on the SHADOW channel.
          //
          // We only open a screen-fallback turn when nothing else
          // owns the live slot. If proxy has already claimed (via
          // its listener above), `claimLiveOwner('screen', …)` will
          // reject and we skip publishing entirely. This is the
          // "pre-owner bootstrap" rule from the redesign plan —
          // screen is permitted as a fallback but may not race a
          // stronger source.
          //
          // The synthetic `live-<ts>` turnId keeps state keyed
          // consistently across the screen applyDelta path, the
          // idle-debounce finishTurn path, and the JSONL-promotion
          // bridge — all of which publish on shadow.
          if (!this.liveSemanticTurnId && this.liveOwner.kind === null) {
            const candidateTurnId = `live-${Date.now()}`
            const decision = this.claimLiveOwner(
              'screen',
              candidateTurnId,
              'screen activity detected',
            )
            if (decision.accept) {
              this.liveSemanticTurnId = candidateTurnId
              this.lastScreenSemanticText = ''
              // Capture the assistant block currently on screen as
              // the baseline. Until the next delta differs from
              // this, the "turn" has not produced any real new
              // bytes — it's just the previous turn's text still
              // rendered in the TUI buffer. See screenBaselineText
              // field docs.
              this.screenBaselineText = extractAssistantInProgress(snap.recent) || ''
              this.screenBaselineSatisfied = false
              this.semanticShadow.startTurn({
                turnId: candidateTurnId,
                role: 'assistant',
                source: 'screen',
                confidence: 'fallback',
              })
            }
          }
        } else {
          // Defer the idle emission — give the next snapshot a chance
          // to reinstate the spinner before we tell consumers we're
          // idle. If a later snapshot brings activity back, we just
          // never fire.
          if (this.idleDebounceTimer) clearTimeout(this.idleDebounceTimer)
          this.idleDebounceTimer = setTimeout(() => {
            this.idleDebounceTimer = null
            // Only flip if still idle by the time the debounce fires.
            if (detectActivity(this.terminal.snapshotPlain())) return
            this.lastActivity = null
            this.emit('idle')
            this.emit('event', { type: 'idle', ts: Date.now() })

            // Screen channel — mirror the debounced idle transition.
            this.screen.publishActivity({ active: false, status: null })

            // Screen-fallback `stream_phase` → idle. Same gating as
            // the active→true path above: only hit `this.semantic`
            // when no proxy is running, so we don't clobber a
            // higher-confidence phase the adapter has already set.
            if (!this.proxy) {
              this.semantic.publishStreamPhase({
                turnId: null,
                phase: 'idle',
                source: 'screen',
                confidence: 'fallback',
              })
            }
            this.semanticShadow.publishStreamPhase({
              turnId: null,
              phase: 'idle',
              source: 'screen',
              confidence: 'fallback',
            })

            // Close the screen fallback (if any) on the shadow
            // channel and release screen ownership. Safe to call
            // unconditionally — `finalizeScreenFallbackTurn` is a
            // no-op when no live turn was open, and
            // `clearLiveOwner` is a no-op when ownership is already
            // idle. Proxy-owned turns are finalized by their own
            // `turn_completed`, not by this debounce.
            if (this.liveOwner.kind === 'screen') {
              this.finalizeScreenFallbackTurn('screen idle debounce')
              this.clearLiveOwner('screen idle debounce')
            }
          }, 2500)
        }
      }

      // Trust dialog detection
      if (trustKey !== this.lastTrustKey) {
        this.lastTrustKey = trustKey
        this.emit('trust-dialog', trust)
        this.screen.publishTrustDialog(trust)
        if (trust.visible) {
          this.emit('event', {
            type: 'trust_dialog',
            ts: Date.now(),
            workspace: trust.workspace,
            accept: () => this.write(TRUST_DIALOG_ACCEPT_KEYS),
            reject: () => this.write('2\r'), // option 2 = "No, exit"
          })
        }
      }

      // Resume-choice prompt detection
      if (resumePromptKey !== this.lastResumePromptKey) {
        this.lastResumePromptKey = resumePromptKey
        this.emit('resume-prompt', resumePrompt)
        this.screen.publishResumePrompt(resumePrompt)
        if (resumePrompt.visible) {
          this.emit('event', {
            type: 'resume_prompt',
            ts: Date.now(),
            state: resumePrompt,
            confirm: () => this.write('\r'),
            cancel: () => this.write('\x1b'),
          })
        }
      }

      // Permission prompt detection
      if (permissionPromptKey !== this.lastPermissionPromptKey) {
        this.lastPermissionPromptKey = permissionPromptKey
        this.emit('permission-prompt', permissionPrompt)
        if (permissionPrompt.visible) {
          this.emit('event', {
            type: 'permission_prompt',
            ts: Date.now(),
            state: permissionPrompt,
            approve: () => this.write(PERMISSION_PROMPT_APPROVE_KEYS),
            deny: () => this.write(PERMISSION_PROMPT_DENY_KEYS),
          })
        }
      }

      if (compactionKey !== this.lastCompactionKey) {
        this.lastCompactionKey = compactionKey
        this.emit('compaction-state', compaction)
        this.screen.publishCompaction(compaction)
        this.emit('event', {
          type: 'compaction_state',
          ts: Date.now(),
          state: compaction,
        })
      }

      // Slash picker detection
      if (pickerKey !== this.lastPickerKey) {
        this.lastPickerKey = pickerKey
        this.emit('slash-picker', picker)
        this.screen.publishSlashPicker(picker)
        this.emit('event', { type: 'slash_picker', ts: Date.now(), state: picker })
      }
    })

    this.terminal.on('exit', ({ exitCode, signal }) => {
      if (this.idleDebounceTimer) {
        clearTimeout(this.idleDebounceTimer)
        this.idleDebounceTimer = null
      }
      this.emit('exit', { exitCode, signal })
      this.emit('event', { type: 'exit', ts: Date.now(), exitCode, signal })
      void this.cleanup()
    })
  }

  // --- Live-turn ownership helpers --------------------------------------
  //
  // WHY these live on the orchestrator and not on SemanticChannel:
  //
  // The channel is a transport — it knows `activeTurnId` and nothing
  // else. The ownership *policy* (which source is allowed to publish,
  // when promotions happen, whether screen yields to proxy) needs
  // visibility across proxy state, screen state, JSONL state, and the
  // consumer's configuration. That's the orchestrator's job.
  //
  // Every ownership transition is explicit — no side-effect
  // promotions hiding in delta handlers. See the redesign plan at
  // docs/superpowers/plans/2026-04-18-headless-live-turn-redesign.md
  // for the full rationale.

  /** True if `kind` is currently allowed to mutate the live turn for
   *  `turnId`. A `null` owner accepts any kind (bootstrap case). */
  private canSourceMutateLiveTurn(
    kind: LiveOwnerKind,
    turnId: string | null,
  ): boolean {
    if (this.liveOwner.kind === null) return true
    if (this.liveOwner.kind !== kind) return false
    if (turnId && this.liveOwner.turnId && turnId !== this.liveOwner.turnId) {
      return false
    }
    return true
  }

  /** Claim the live-turn slot for `kind` with `turnId`. Emits a
   *  `live-owner-change` diagnostic. Returns the decision so callers
   *  can branch on `accept`. */
  private claimLiveOwner(
    kind: LiveOwnerKind,
    turnId: string,
    reason: string,
  ): LiveOwnerDecision {
    const prev = this.liveOwner
    const now = Date.now()
    // Re-claiming the same slot is idempotent — accepts without
    // firing a spurious transition event, which keeps debug panels
    // quiet during legitimate same-turn refreshes.
    if (prev.kind === kind && prev.turnId === turnId) {
      const decision: LiveOwnerDecision = {
        accept: true,
        action: 'start',
        kind,
        turnId,
        reason: `re-claim: ${reason}`,
        prev,
        next: prev,
        ts: now,
      }
      return decision
    }

    // Another owner is already live. Deny — unless that owner is in
    // `reconciling` state (waiting on durability confirmation after
    // its SSE turn ended). Reconciling owners can be evicted by a
    // new claim because their live phase is already over; blocking
    // new turns on a reconciliation window would stall the session.
    //
    // When evicting a reconciling owner we still emit a `clear`
    // decision first so debug tooling sees the slot transition
    // explicitly instead of a silent overwrite.
    if (prev.kind !== null && prev.kind !== kind) {
      if (prev.status === 'reconciling') {
        this.clearLiveOwner(
          `evicted by ${kind} claim (was reconciling ${prev.kind}:${prev.turnId})`,
        )
        // Re-read after eviction; ownership is now idle.
      } else {
        const decision: LiveOwnerDecision = {
          accept: false,
          action: 'drop',
          kind,
          turnId,
          reason: `owner=${prev.kind} turnId=${prev.turnId} — ${reason}`,
          prev,
          next: prev,
          ts: now,
        }
        this.emit('live-owner-change', decision)
        return decision
      }
    }

    const next: LiveOwnerState = {
      kind,
      turnId,
      startedAt: now,
      status: 'live',
    }
    this.liveOwner = next
    const decision: LiveOwnerDecision = {
      accept: true,
      action: 'start',
      kind,
      turnId,
      reason,
      prev,
      next,
      ts: now,
    }
    this.emit('live-owner-change', decision)
    return decision
  }

  /** Transition the current owner from `live` to `reconciling`.
   *  Kind and turnId are preserved; only `status` flips. Used after
   *  a proxy `turn_completed` so debug tooling can see the slot is
   *  waiting on durable JSONL commit before it frees up. No-op if
   *  there is no current owner or the owner is already reconciling. */
  private beginReconcilingLiveOwner(reason: string): void {
    const prev = this.liveOwner
    if (prev.kind === null) return
    if (prev.status === 'reconciling') return
    const next: LiveOwnerState = {
      kind: prev.kind,
      turnId: prev.turnId,
      startedAt: prev.startedAt,
      status: 'reconciling',
    }
    this.liveOwner = next
    this.emit('live-owner-change', {
      accept: true,
      action: 'finalize',
      kind: prev.kind,
      turnId: prev.turnId ?? '',
      reason,
      prev,
      next,
      ts: Date.now(),
    })
  }

  /** Release the live-turn slot. Safe to call with no current owner;
   *  emits no transition event in that case (keeps shutdown quiet). */
  private clearLiveOwner(reason: string): void {
    const prev = this.liveOwner
    if (prev.kind === null) return
    const next: LiveOwnerState = {
      kind: null,
      turnId: null,
      startedAt: null,
      status: 'idle',
    }
    this.liveOwner = next
    this.emit('live-owner-change', {
      accept: true,
      action: 'clear',
      kind: prev.kind,
      turnId: prev.turnId ?? '',
      reason,
      prev,
      next,
      ts: Date.now(),
    })
  }

  /** Promote from one owner to another. Used when proxy arrives after
   *  screen has been streaming — we seal the screen fallback on the
   *  shadow channel, release the screen owner, and claim proxy on the
   *  real channel. Centralising the transition keeps the reset of
   *  screen-specific bookkeeping in one place. */
  private transitionLiveOwner(
    nextKind: LiveOwnerKind,
    nextTurnId: string,
    reason: string,
  ): LiveOwnerDecision {
    const prev = this.liveOwner
    if (prev.kind === null) {
      return this.claimLiveOwner(nextKind, nextTurnId, reason)
    }
    if (prev.kind === nextKind && prev.turnId === nextTurnId) {
      return {
        accept: true,
        action: 'start',
        kind: nextKind,
        turnId: nextTurnId,
        reason: `no-op transition: ${reason}`,
        prev,
        next: prev,
        ts: Date.now(),
      }
    }

    // Close out the outgoing owner's bookkeeping. Screen needs a
    // shadow-channel finalize so shadow subscribers see a clean
    // close; other kinds don't need anything here because their
    // publishing lives on `this.semantic` and the orchestrator is
    // not the one calling finishTurn for them.
    if (prev.kind === 'screen') {
      this.finalizeScreenFallbackTurn('preempted by ' + nextKind)
    }

    const next: LiveOwnerState = {
      kind: nextKind,
      turnId: nextTurnId,
      startedAt: Date.now(),
      status: 'live',
    }
    this.liveOwner = next
    const decision: LiveOwnerDecision = {
      accept: true,
      action: 'promote',
      kind: nextKind,
      turnId: nextTurnId,
      reason: `${prev.kind} → ${nextKind}: ${reason}`,
      prev,
      next,
      ts: Date.now(),
    }
    this.emit('live-owner-change', decision)
    return decision
  }

  /** Close out the screen fallback on the shadow channel and reset
   *  screen-specific state fields. Idempotent. Kept as a helper so
   *  every "screen turn is over" path (idle debounce, proxy preempt,
   *  JSONL promotion) clears the same fields in the same order —
   *  prior inline resets had drifted and let a later turn inherit a
   *  prior turn's baseline text. */
  private finalizeScreenFallbackTurn(reason: string): void {
    if (this.liveSemanticTurnId) {
      this.semanticShadow.finishTurn({
        turnId: this.liveSemanticTurnId,
        fullText: this.lastScreenSemanticText || undefined,
        source: 'screen',
        confidence: 'fallback',
      })
    }
    this.liveSemanticTurnId = null
    this.lastScreenSemanticText = ''
    this.screenBaselineText = ''
    this.screenBaselineSatisfied = false
    void reason
  }

  /**
   * Start processing: resolve the JSONL project dir, attach the
   * transcript tailer. Call this after the PTY is spawned.
   *
   * The JSONL tailer is attached BEFORE the terminal starts
   * processing PTY data so we don't miss any transcript entries.
   */
  async start(): Promise<{ projectDir: string }> {
    const projectDir = await getProjectDirForCwd(this.cwd)

    // Single JSONL sink. Deduplicated here because on the fresh and
    // resume paths we want identical channel routing: the committed
    // channel gets the raw entry, and whenever a JSONL entry commits
    // an assistant turn we promote the currently-active screen-driven
    // semantic turn to source='jsonl' with confidence='high' before
    // finalising. That's the cleanest way to let late subscribers
    // see the authoritative text even though the live stream came
    // from the screen extractor.
    const onJsonlEntry = (entry: JsonlEntry, filePath: string) => {
      this.emit('jsonl-entry', entry, filePath)
      this.emit('event', {
        type: 'jsonl_entry', ts: Date.now(), entry, file: filePath,
      })

      const typed = entry as unknown as Entry
      this.committed.publishEntry(typed, filePath)

      // Tool_result extraction used to happen here, bridging committed
      // results onto the SEMANTIC channel as a synthetic `tool_result`
      // event. As of the 2026-04-18 redesign (Task 6 of
      // docs/superpowers/plans/2026-04-18-headless-live-turn-redesign.md)
      // the extraction has moved into `CommittedChannel.publishEntry`
      // and fires on the COMMITTED channel instead.
      //
      // WHY the move: Anthropic's SSE never carries tool_result content;
      // it arrives only in the next user-role JSONL entry, long after
      // the assistant turn has naturally ended. The old bridge kept the
      // renderer's live assistant turn artificially alive so that late
      // arrivals could mutate it — exactly the "committed data leaks
      // back into live semantics" leak the redesign plan identifies as
      // the root cause of cross-layer ownership confusion.
      //
      // The renderer's pairing-by-`toolUseId` logic is unchanged; it
      // now subscribes to `committed.tool_result` instead of
      // `semantic.tool_result`. See `CommittedChannel.publishEntry`
      // for the extraction + emission.

      // JSONL promotion of the screen-fallback turn — SHADOW only.
      //
      // WHY this now targets `semanticShadow` instead of `semantic`:
      //
      // The `liveSemanticTurnId` is the synthetic `live-<ts>` id that
      // the screen fallback minted when activity was detected. Since
      // screen lifecycle runs on the shadow channel (see the 2026-
      // 04-18 redesign plan), the real `this.semantic` never saw a
      // `turn_started` for this id. Publishing a JSONL-sourced delta
      // or completion onto the real channel would trip the channel's
      // strict `lifecycle_violation` guard and be dropped.
      //
      // Routing this promotion to the shadow channel lets shadow
      // subscribers (debug panel, testing harness) see the authoritative
      // JSONL text as the closing delta on the screen fallback turn —
      // a clean story on the shadow timeline. The renderer still gets
      // the settled assistant text through the `committed` channel,
      // which is where durable state belongs anyway.
      //
      // Proxy ownership is deliberately NOT inspected here: this path
      // only fires when screen owns (`liveOwner.kind === 'screen'`);
      // proxy-owned turns are finalized by their own SSE lifecycle on
      // the real channel, never by JSONL commits.
      if (
        this.liveOwner.kind === 'screen' &&
        this.liveSemanticTurnId &&
        isConversationEntry(typed) &&
        typed.type === 'assistant'
      ) {
        const msg = typed.message
        let text = ''
        if (typeof msg.content === 'string') {
          text = msg.content
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
            .filter(Boolean)
            .join('\n')
        }
        if (text) {
          this.semanticShadow.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText: text,
            source: 'jsonl',
            confidence: 'high',
          })
          this.semanticShadow.finishTurn({
            turnId: this.liveSemanticTurnId,
            fullText: text,
            source: 'jsonl',
            confidence: 'high',
          })
          this.liveSemanticTurnId = null
          this.lastScreenSemanticText = ''
          this.screenBaselineText = ''
          this.screenBaselineSatisfied = false
          this.clearLiveOwner('jsonl committed assistant turn')
        }
      }
    }
    const onJsonlError = (err: Error) => {
      this.emit('jsonl-error', err)
      this.committed.publishError(err)
    }

    if (this.resumeSessionId) {
      const filePath = join(projectDir, `${this.resumeSessionId}.jsonl`)
      const stop = tailSessionFile(
        filePath,
        (entry) => onJsonlEntry(entry, filePath),
        onJsonlError,
        {
          bootstrapTailLines: ClaudeCodeHeadless.RESUME_BOOTSTRAP_TAIL_LINES,
        },
      )
      this.stopJsonlTail = stop
    } else {
      this.stopJsonlTail = await tailNewSessionFile(
        projectDir,
        onJsonlEntry,
        onJsonlError,
      )
    }

    // Now that the JSONL tailer is wired (and any fresh-session file
    // has been registered with the watcher), let PTY data start flowing
    // into the headless terminal mirror. Splitting attach() out of the
    // HeadlessTerminal constructor is what makes the tailer-first
    // ordering enforceable — see HeadlessTerminal file header for why.
    this.terminal.attach()

    return { projectDir }
  }

  // --- Input ---

  /** Write raw bytes to the PTY. Used for keystroke synthesis. */
  write(data: string): void {
    this.terminal.write(data)
  }

  /** Send a prompt: write the text + carriage return. For multi-line
   *  prompts, wraps in bracketed paste so CC treats embedded newlines
   *  as literal input rather than submit events. */
  sendPrompt(text: string): void {
    if (text.includes('\n')) {
      this.write(`\x1b[200~${text}\x1b[201~\r`)
    } else {
      this.write(text + '\r')
    }
  }

  /**
   * Poll the live screen snapshot for Claude's `[Pasted text #N]`
   * placeholder. Resolves as soon as the placeholder is visible, or
   * after `timeoutMs` if it never materializes.
   *
   * WHY this method exists:
   *   The paste-submit-repro harness at Agent Code's
   *   `vendor/in_progress/paste-submit-repro/` characterized the
   *   "paste-then-Enter sometimes does nothing" bug as follows:
   *   Claude's TUI runs a paste accumulator between
   *   `\x1b[200~`...`\x1b[201~` markers; an Enter that arrives BEFORE
   *   the accumulator commits is absorbed as more paste content
   *   instead of being treated as submit. The visible signal that
   *   Claude has committed the paste is the `[Pasted text #N]`
   *   placeholder appearing in the composer row.
   *
   *   Agent Code's production fix was a 125 ms wall-clock delay between
   *   the paste payload and `\r`. The harness shows the window can
   *   stretch past 1 s under load (scenario 03 with a 1000 ms delay
   *   STILL races 2/3 of the time), so any wall-clock value is wrong
   *   in kind, not in magnitude. Polling the visible placeholder is
   *   load-independent.
   *
   * WHY a timeout fallback is mandatory:
   *   Claude's future UI revisions could rename the placeholder,
   *   change its format, or remove it entirely. Without a bound the
   *   caller would hang forever. 2000 ms is ~10x the observed
   *   maximum wait in the harness sample (~100 ms p95) — large
   *   enough that a real placeholder appearance always wins, small
   *   enough that the timeout-fallback path doesn't make a real
   *   submit feel laggy.
   *
   * WHY 10 ms polling:
   *   The harness measured placeholder appearances at p50 ~50 ms and
   *   p95 ~108 ms. 10 ms keeps the worst-case latency between
   *   placeholder appearance and our resolution under one frame.
   *
   * WHY this lives on the headless class:
   *   `snapshotPlain()` is a synchronous read from the in-process
   *   xterm buffer. Polling it from the consumer (Agent Code renderer)
   *   would require an IPC round trip every 10 ms — 100 IPC messages
   *   per second to avoid a single race. Doing the poll in-process
   *   reduces the cost to one IPC after the placeholder is visible.
   *
   * KNOWN CAVEAT — see the comment block above `scheduleFlush` in
   * `terminal/HeadlessTerminal.ts`: under heavy synchronized-output
   * pressure, the package's `'screen'` event can stall. THIS METHOD
   * SIDESTEPS THAT BUG by polling `snapshotPlain()` directly, which
   * reads the live xterm buffer regardless of whether `'screen'`
   * fires. Do not refactor to subscribe to `'screen'` — it would
   * reintroduce the stall.
   */
  awaitPastePlaceholder(
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<{ kind: 'appeared'; waitedMs: number } | { kind: 'timeout' }> {
    const timeoutMs = opts.timeoutMs ?? 2_000
    const pollIntervalMs = opts.pollIntervalMs ?? 10
    const startedAt = Date.now()
    return new Promise(resolve => {
      const tick = (): void => {
        const plain = this.terminal.snapshotPlain()
        if (/\[Pasted text #\d+/.test(plain)) {
          resolve({ kind: 'appeared', waitedMs: Date.now() - startedAt })
          return
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve({ kind: 'timeout' })
          return
        }
        setTimeout(tick, pollIntervalMs)
      }
      tick()
    })
  }

  /** Resize both the PTY and the headless terminal. */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  // --- State queries ---

  /** True if CC's spinner is NOT visible on screen (waiting for input). */
  isIdle(): boolean {
    return this.lastActivity === null
  }

  /** True if CC's spinner IS visible (working). */
  isWorking(): boolean {
    return this.lastActivity !== null
  }

  /** Current activity verb (e.g. "Cogitating…") or null if idle. */
  getActivity(): string | null {
    return this.lastActivity
  }

  /** Current plain-text screen snapshot. */
  getScreen(): string {
    return this.terminal.snapshotPlain()
  }

  /** Current markdown-reconstructed screen snapshot. */
  getScreenMarkdown(): string {
    return this.terminal.snapshotMarkdown()
  }

  /** Extract the current in-progress assistant text from the screen. */
  getAssistantInProgress(): string {
    return extractAssistantInProgress(this.terminal.snapshotPlain())
  }

  getSlashPickerState(): SlashPickerState {
    return this.pickerState
  }

  getTrustDialogState(): TrustDialogState {
    return this.trustDialogState
  }

  getResumePromptState(): ResumePromptState {
    return this.resumePromptState
  }

  getCompactionState(): CompactionState {
    return this.compactionState
  }

  /** List resumable sessions for this cwd. */
  async listResumableSessions(limit?: number): Promise<SessionInfo[]> {
    return listSessionsForCwd(this.cwd, { limit })
  }

  /** True if the PTY has exited. */
  isExited(): boolean {
    return this.terminal.isExited()
  }

  // --- Proxy integration ---

  /** Forward a transport event from the consumer's proxy runtime
   *  (mitmproxy-style: `{ kind, flow_id, url, host, path, method,
   *  headers, status_code, chunk_b64, body, … }`) into the adapter.
   *  No-op when proxy was not configured in options. */
  handleProxyTransportEvent(event: ProxyTransportEvent): void {
    this.proxy?.handleTransportEvent(event)
  }

  // --- Cleanup ---

  /** Stop processing: detach the JSONL tailer and terminal. Does NOT
   *  kill the PTY — the consumer owns its lifecycle. */
  async stop(): Promise<void> {
    this.terminal.dispose()
    await this.cleanup()
  }

  private async cleanup(): Promise<void> {
    if (this.idleDebounceTimer) {
      clearTimeout(this.idleDebounceTimer)
      this.idleDebounceTimer = null
    }
    if (this.stopJsonlTail) {
      try {
        await this.stopJsonlTail()
      } catch {
        // best-effort
      }
      this.stopJsonlTail = null
    }
    // Proxy adapter has its own flow state (per-flow TextDecoders,
    // SSE buffers, per-block accumulators). Releasing it here means a
    // stop → restart cycle starts from a clean slate instead of
    // replaying stale partial state.
    this.proxy?.dispose()
  }
}
