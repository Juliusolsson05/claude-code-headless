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
// backwards compatibility with existing cc-shell consumers.
import { CommittedChannel } from './channels/CommittedChannel.js'
import { ScreenChannel } from './channels/ScreenChannel.js'
import { SemanticChannel } from './channels/SemanticChannel.js'
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
  'compaction-state': [CompactionState]
  'slash-picker': [SlashPickerState]
  exit: [{ exitCode: number; signal?: number }]
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
  // Debounce timer for idle.
  //
  // CC redraws the spinner cell every frame, but in practice there are
  // *long* windows (multi-second) where the spinner row is replaced by
  // a transient header — tool-call summaries, the "Bash(...)" preview,
  // a "Tip:" footer line, etc. — and the bottom-up SPINNER_VERB_RE walk
  // returns null even though CC is clearly still working. With the
  // previous 250ms threshold the indicator flashed green for a
  // quarter-second per turn and snapped back to "idle" almost
  // immediately. The user reports this directly: "it sometimes flashes
  // green for a quarter of a second, then it goes back to inactive."
  //
  // 2500ms is empirically wide enough to bridge the longest spinner
  // gap CC's TUI shows during a normal turn (tool output animation
  // cycles ~1.5s), without introducing perceptible lag at the end of a
  // turn — the user finishes reading the assistant block before the
  // green pip drops.
  private idleDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private trustDialogState: TrustDialogState = { visible: false }
  private lastTrustKey: string | null = null
  private resumePromptState: ResumePromptState = { visible: false }
  private lastResumePromptKey: string | null = null
  private compactionState: CompactionState = { visible: false }
  private lastCompactionKey: string | null = null
  private pickerState: SlashPickerState = { visible: false, items: [] }
  private lastPickerKey: string | null = null

  // --- Three-channel truth surface ---------------------------------------
  //
  // These channels are the new public contract (see docs/channels).
  // They run IN ADDITION TO the existing flat event surface so we
  // don't break cc-shell today. The split lets consumers treat live
  // semantic text, visible terminal state, and committed transcript
  // history as three independent streams instead of reverse-engineering
  // which is which from a blended event list.
  readonly semantic = new SemanticChannel()
  readonly screen = new ScreenChannel()
  readonly committed = new CommittedChannel()
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
        })
      : null

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

      // Semantic channel — live assistant text (source='screen').
      //
      // We derive semantic deltas from the screen extractor as long as
      // a turn is active. Skipped entirely when `this.proxy` is
      // present: the consumer opted into proxy-sourced semantics, and
      // two publishers fighting over `activeTurnId` produces incorrect
      // source_changed events and wrong `turn_delta.fullText`
      // snapshots. Screen channel publishing is unaffected — the app
      // still gets screen snapshots for overlays/PTY mirroring.
      if (!this.proxy && this.liveSemanticTurnId) {
        const fullText = extractAssistantInProgress(snap.plain)
        if (fullText && fullText !== this.lastScreenSemanticText) {
          // Compute the markdown flavor from the full snapshot rather
          // than re-running the extractor on markdown — the extractor
          // is written against plain text. This is a coarse
          // approximation; the committed channel is still the source
          // of truth for final formatting.
          const textDelta = fullText.startsWith(this.lastScreenSemanticText)
            ? fullText.slice(this.lastScreenSemanticText.length)
            : undefined
          this.lastScreenSemanticText = fullText
          this.semantic.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText,
            textDelta,
            markdownText: extractAssistantInProgress(snap.markdown) || undefined,
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
      // Previously cc-shell also subscribed to a caffeinate-based
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

          // Semantic channel — idle→active is our best screen-level
          // proxy for "assistant turn started". Skipped when proxy
          // is configured: the adapter will emit `turn_started` with
          // the real Anthropic message id once `message_start`
          // arrives. We still mint the `liveSemanticTurnId` string
          // below in the proxy branch (just not publish) so legacy
          // screen-path code reading it for diagnostics keeps
          // working — but we do not call `startTurn` to avoid
          // fighting the adapter over `activeTurnId`.
          if (!this.liveSemanticTurnId) {
            this.liveSemanticTurnId = `live-${Date.now()}`
            this.lastScreenSemanticText = ''
            if (!this.proxy) {
              this.semantic.startTurn({
                turnId: this.liveSemanticTurnId,
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

            // Semantic channel — close out the screen-driven live turn
            // with whatever text the extractor last saw. Skipped when
            // proxy is configured: the adapter owns turn completion
            // via `message_delta` / `response-end`, and letting an
            // idle-timeout closer race against it would produce
            // duplicate `turn_completed` events. If JSONL later
            // commits a different/better text, the committed channel
            // will carry that truth; we don't retroactively mutate
            // the semantic stream because reconciliation across
            // channels is the consumer's call, not ours.
            if (this.liveSemanticTurnId) {
              if (!this.proxy) {
                this.semantic.finishTurn({
                  turnId: this.liveSemanticTurnId,
                  fullText: this.lastScreenSemanticText || undefined,
                  source: 'screen',
                  confidence: 'fallback',
                })
              }
              this.liveSemanticTurnId = null
              this.lastScreenSemanticText = ''
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

      if (
        isConversationEntry(typed) &&
        typed.type === 'user' &&
        Array.isArray(typed.message.content)
      ) {
        // WHY bridge committed tool_result blocks back onto the semantic channel:
        //
        // Anthropic's live SSE stream never carries tool results. They arrive in
        // the NEXT user-role transcript entry after the tool has finished. If we
        // leave them on the committed channel only, a renderer that is correctly
        // using semantic state for live turns still has to subscribe to two
        // independent sources and re-implement pairing logic by tool_use_id.
        //
        // Claude's own UI doesn't have that split-brain problem because it owns
        // both the stream loop and transcript reconciliation internally. cc-shell
        // does not, so the safe contract here is: semantic owns "live turn
        // structure", and that includes late-arriving tool results. The committed
        // channel remains the durable source of truth; this bridge just mirrors
        // the result shape onto the semantic bus so the renderer does not have to
        // guess where tool output lives.
        const semanticTurnId =
          typeof typed.parentUuid === 'string' && typed.parentUuid
            ? typed.parentUuid
            : typed.uuid
        for (const block of typed.message.content) {
          if (block.type !== 'tool_result') continue
          const content =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map(item =>
                      typeof item === 'string'
                        ? item
                        : typeof item.text === 'string'
                          ? item.text
                          : '',
                    )
                    .filter(Boolean)
                    .join('\n')
                : ''
          this.semantic.publishToolResult({
            turnId: semanticTurnId,
            toolUseId: block.tool_use_id,
            content,
            isError: block.is_error === true,
            source: 'jsonl',
            confidence: 'high',
          })
        }
      }

      // Promote the active screen-driven live semantic turn to
      // authoritative text once JSONL commits an assistant message.
      // We do this ONLY while a live turn is still open AND proxy is
      // not configured. When proxy is configured the adapter owns
      // semantic publishing end-to-end (with the real Anthropic
      // message id as turnId); firing a jsonl-sourced promotion
      // against the screen-path's synthetic `live-<ts>` id would
      // collide with the adapter's turnId and emit source_changed
      // events that confuse the renderer. The committed channel
      // still carries the canonical text either way, so nothing is
      // lost for consumers that want the settled view.
      if (
        !this.proxy &&
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
          this.semantic.applyDelta({
            turnId: this.liveSemanticTurnId,
            fullText: text,
            source: 'jsonl',
            confidence: 'high',
          })
          this.semantic.finishTurn({
            turnId: this.liveSemanticTurnId,
            fullText: text,
            source: 'jsonl',
            confidence: 'high',
          })
          this.liveSemanticTurnId = null
          this.lastScreenSemanticText = ''
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
