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
import { ProcessInspector, type ProcessState } from './terminal/ProcessInspector.js'
import {
  tailNewSessionFile,
  tailSessionFile,
  type JsonlEntry,
} from './transcript/JsonlTailer.js'
import { getProjectDirForCwd } from './transcript/ProjectDir.js'
import { listSessionsForCwd, type SessionInfo } from './transcript/SessionList.js'

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
export type ProcessStateEvent = {
  type: 'process_state'; ts: number; state: ProcessState
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
  | ProcessStateEvent
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
  'process-state': [ProcessState]
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
  private readonly terminal: HeadlessTerminal
  private readonly cwd: string
  private readonly resumeSessionId: string | null
  private readonly inspector: ProcessInspector | null
  private stopJsonlTail: (() => Promise<void>) | null = null
  private lastActivity: string | null = null
  private lastProcessActive: boolean | null = null
  private trustDialogState: TrustDialogState = { visible: false }
  private lastTrustKey: string | null = null
  private resumePromptState: ResumePromptState = { visible: false }
  private lastResumePromptKey: string | null = null
  private compactionState: CompactionState = { visible: false }
  private lastCompactionKey: string | null = null
  private pickerState: SlashPickerState = { visible: false, items: [] }
  private lastPickerKey: string | null = null

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
    this.inspector =
      typeof options.pty.pid === 'number' && options.pty.pid > 0
        ? new ProcessInspector(options.pty.pid, state => {
            this.lastProcessActive = state.active
            this.emit('process-state', state)
            this.emit('event', { type: 'process_state', ts: Date.now(), state })
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

      // Forward raw screen
      this.emit('screen', snap)
      this.emit('event', { type: 'screen', ts: Date.now(), ...snap })

      // Activity detection
      const activity = detectActivity(snap.plain)
      if (activity !== this.lastActivity) {
        this.lastActivity = activity
        if (activity) {
          this.emit('activity', activity)
          this.emit('event', { type: 'activity', ts: Date.now(), status: activity })
        } else {
          this.emit('idle')
          this.emit('event', { type: 'idle', ts: Date.now() })
        }
      }

      // Trust dialog detection
      if (trustKey !== this.lastTrustKey) {
        this.lastTrustKey = trustKey
        this.emit('trust-dialog', trust)
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
        this.emit('event', { type: 'slash_picker', ts: Date.now(), state: picker })
      }
    })

    this.terminal.on('exit', ({ exitCode, signal }) => {
      this.inspector?.stop()
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

    if (this.resumeSessionId) {
      const filePath = join(projectDir, `${this.resumeSessionId}.jsonl`)
      const stop = tailSessionFile(
        filePath,
        (entry) => {
          this.emit('jsonl-entry', entry, filePath)
          this.emit('event', {
            type: 'jsonl_entry', ts: Date.now(), entry, file: filePath,
          })
        },
        (err) => this.emit('jsonl-error', err),
      )
      this.stopJsonlTail = stop
    } else {
      this.stopJsonlTail = await tailNewSessionFile(
        projectDir,
        (entry, file) => {
          this.emit('jsonl-entry', entry, file)
          this.emit('event', {
            type: 'jsonl_entry', ts: Date.now(), entry, file,
          })
        },
        (err) => this.emit('jsonl-error', err),
      )
    }

    this.inspector?.start()

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
    if (this.lastProcessActive != null) return !this.lastProcessActive
    return this.lastActivity === null
  }

  /** True if CC's spinner IS visible (working). */
  isWorking(): boolean {
    if (this.lastProcessActive != null) return this.lastProcessActive
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

  // --- Cleanup ---

  /** Stop processing: detach the JSONL tailer and terminal. Does NOT
   *  kill the PTY — the consumer owns its lifecycle. */
  async stop(): Promise<void> {
    this.terminal.dispose()
    await this.cleanup()
  }

  private async cleanup(): Promise<void> {
    this.inspector?.stop()
    if (this.stopJsonlTail) {
      try {
        await this.stopJsonlTail()
      } catch {
        // best-effort
      }
      this.stopJsonlTail = null
    }
  }
}
