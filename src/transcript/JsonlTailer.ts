import { watch } from 'chokidar'
import {
  closeSync,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
  statSync,
  unwatchFile,
  watchFile,
  type Stats,
} from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { basename, join } from 'path'
import { StringDecoder } from 'node:string_decoder'

// Node-only (chokidar + fs). Used by downstream applications that need
// to tail CC's transcript files. NOT importable from browser contexts.

/**
 * Watches a single JSONL file and emits parsed objects line-by-line as the
 * file grows. Append-only: it remembers a byte offset and reads everything
 * past it on the tick of a polling-based stat watcher.
 *
 * Partial trailing lines are buffered until the next read brings the
 * terminating newline.
 *
 * Why fs.watchFile (poll) instead of chokidar's fs.watch path:
 *   chokidar on macOS defaults to fs.watch-based change detection for
 *   single files, which is known to silently miss rapid appends from
 *   non-editor writers (append-only files that don't atomic-rename).
 *   Users saw it concretely: submit a prompt, CC writes
 *   the user entry + a bunch of attachments to the JSONL, and the
 *   feed wouldn't update until some unrelated later write nudged
 *   chokidar into re-reading. "The prompt didn't appear."
 *
 *   fs.watchFile polls stat() on an interval and fires whenever
 *   size/mtime changes. At 100ms interval the latency is imperceptible
 *   (~half a human reaction time), the CPU cost is trivial (one stat
 *   call every 100ms per tailer), and it's reliable on every fs/OS
 *   combination because it doesn't rely on kernel event delivery.
 *
 * Concurrency: `readNew()` can be triggered while a previous read is
 * still in flight — the fs.read stream is async, so its `end` handler
 * (where `offset` is advanced) runs on a future tick. Without
 * serialization a second trigger could read from a stale offset,
 * producing duplicate emits AND stomping `offset` backwards in the
 * first call's `end` handler. The `reading` / `pendingRead` flags
 * below form a simple "queue at most one re-entry" pattern: while a
 * read is in flight, subsequent triggers just set `pendingRead`; when
 * the in-flight read completes we immediately re-run if anything was
 * queued. This guarantees strict serialization with zero unbounded
 * queuing and zero concurrency.
 */
export class FileTailer<T> {
  private offset = 0
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private anchor = Buffer.alloc(0)
  private identity: { dev: number; ino: number } | null = null
  private readonly onDiscontinuity?: () => void
  private reportedDiscontinuity = false
  private idleWaiters: Array<() => void> = []
  private closed = false
  // Poll interval for fs.watchFile in milliseconds. 100ms gives
  // reliable pickup with imperceptible latency and negligible CPU.
  // Tuning lower doesn't noticeably help humans; tuning higher
  // starts to show up as "typing feels sluggish" when submit →
  // feed-update takes noticeable wall time.
  private static readonly POLL_INTERVAL_MS = 100
  // Stall watchdog window. 15s is ~150 missed polls — unambiguous death,
  // never a slow disk. Cheap: one stat per window per tailer.
  private static readonly WATCHDOG_MS = 15_000
  // Resume bootstrap intentionally reads a bounded tail slice instead
  // of the whole transcript. The goal is "show the recent context and
  // start following new appends", not "hydrate a megabyte-scale
  // historical archive before first paint". 512 KB is large enough to
  // hold the last few hundred normal JSONL entries even when some tool
  // outputs are chunky, while still capping startup cost.
  private static readonly BOOTSTRAP_TAIL_BYTES = 512 * 1024
  private reading = false
  private pendingRead = false
  private relocating = false
  /**
   * The stat listener MUST be stored and passed to unwatchFile on close.
   * WHY: `unwatchFile(path)` with no listener removes EVERY stat-watcher
   * for that path in the whole process (Node semantics). agent-code's
   * replaceSession spawns the new session before killing the old one, and
   * on an in-place resume both tail the SAME transcript file — so the old
   * session's close was deterministically killing the new pane's watcher.
   * Root cause of the "dead committed channel" / "prompt stuck in queue"
   * bug family (agent-code residue plan 2026-07, P0).
   */
  private statListener: ((curr: Stats, prev: Stats) => void) | null = null
  /** Wall-clock of the last poll tick — feeds the stall watchdog. */
  private lastPollAt = Date.now()
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(
    private filePath: string,
    private readonly onEntry: (entry: T) => void,
    private readonly onError?: (err: Error) => void,
    options?: {
      /**
       * When set, do NOT replay the whole file from byte 0 on startup.
       * Instead, synchronously parse only the most recent N complete
       * JSONL lines, then begin tailing from EOF for future appends.
       *
       * Used by resume flows so long transcripts open at the current
       * end of the conversation instead of making the renderer watch
       * thousands of historical entries stream by.
       */
      bootstrapTailLines?: number
      /**
       * Stall-watchdog window override. Production default (15s) is
       * unambiguous watcher death; tests shrink it so the self-heal
       * path is exercisable in milliseconds. 0/undefined = default.
       */
      watchdogMs?: number
      /** Let an exact-session owner resolve replacement before bytes are consumed. */
      onDiscontinuity?: () => void
    },
  ) {
    this.onDiscontinuity = options?.onDiscontinuity
    const bootstrapTailLines = options?.bootstrapTailLines ?? 0
    if (bootstrapTailLines > 0) {
      this.bootstrapTail(bootstrapTailLines)
    } else {
      // Read whatever is already in the file synchronously on
      // construct — CC often writes several entries before the watcher
      // would tick. This gives us a clean baseline offset before the
      // poll loop starts.
      this.readNew()
    }

    this.statListener = (curr, prev) => {
      if (this.closed) return
      this.lastPollAt = Date.now()
      // Only act when the file has actually grown or its mtime
      // moved. stat returns size=0 when the file briefly
      // disappears (rare, but happens on some atomic-rename
      // writers); we let the next tick pick it back up.
      if (curr.size <= prev.size && curr.mtimeMs === prev.mtimeMs) {
        return
      }
      this.readNew()
    }
    watchFile(
      filePath,
      { interval: FileTailer.POLL_INTERVAL_MS, persistent: true },
      this.statListener,
    )

    // Stall watchdog: if the file has grown past our offset but the stat
    // watcher hasn't ticked in a whole watchdog window, the watcher is
    // dead (historical cause: another FileTailer on the same path closed
    // with an unscoped unwatchFile — fixed above, but ANY future
    // watcher-death recurrence self-heals here instead of silently
    // killing the committed channel). Re-arm and surface a diagnostic so
    // debug bundles show the event instead of an unexplained stale tail.
    const watchdogMs = options?.watchdogMs || FileTailer.WATCHDOG_MS
    this.watchdog = setInterval(() => {
      if (this.closed || this.statListener === null) return
      if (Date.now() - this.lastPollAt < watchdogMs) return
      let size = 0
      try {
        size = statSync(this.filePath).size
      } catch {
        return // file briefly missing — next tick
      }
      if (size <= this.offset) return
      unwatchFile(this.filePath, this.statListener)
      watchFile(
        this.filePath,
        { interval: FileTailer.POLL_INTERVAL_MS, persistent: true },
        this.statListener,
      )
      this.onError?.(new Error('tail-stalled: stat watcher dead with unread data; re-armed'))
      this.readNew()
    }, watchdogMs)
    // Never hold the process open just for the watchdog.
    this.watchdog.unref?.()
  }

  private bootstrapTail(maxLines: number): void {
    if (this.closed || maxLines <= 0) return

    let fd: number
    let stat: Stats
    try {
      fd = openSync(this.filePath, 'r')
    } catch {
      return
    }
    try { stat = fstatSync(fd) } catch (err) {
      closeSync(fd); this.onError?.(err as Error); return
    }
    this.identity = { dev: stat.dev, ino: stat.ino }
    if (stat.size <= 0) {
      this.offset = 0
      closeSync(fd)
      return
    }

    const bytesToRead = Math.min(FileTailer.BOOTSTRAP_TAIL_BYTES, stat.size)
    const start = Math.max(0, stat.size - bytesToRead)
    const buf = Buffer.alloc(bytesToRead)

    try {
      let read = 0
      while (read < bytesToRead) {
        const count = readSync(fd, buf, read, bytesToRead - read, start + read)
        if (count === 0) throw new Error('Claude transcript changed during bootstrap')
        read += count
      }
    } catch (err) {
      this.onError?.(err as Error)
      if (fd !== null) {
        try { closeSync(fd) } catch { /* best-effort */ }
      }
      return
    }
    try {
      closeSync(fd)
    } catch {
      // best-effort close
    }

    let text = this.decoder.write(buf)
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
    }

    const lastNewline = text.lastIndexOf('\n')
    this.buffer = text.slice(lastNewline + 1)
    const lines = text.slice(0, lastNewline + 1)
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)

    const recent = lines.slice(-maxLines)
    for (const line of recent) {
      try {
        const obj = JSON.parse(line) as T
        this.onEntry(obj)
      } catch (err) {
        this.onError?.(err as Error)
      }
    }

    // Start live tailing from EOF after the bootstrap snapshot. Any
    // later append will be picked up by the poll watcher below.
    this.offset = stat.size
    this.anchor = Buffer.from(buf.subarray(Math.max(0, buf.length - 256)))
    // Keep any incomplete final JSONL/UTF-8 record for the first live read.
    // Consuming EOF without this buffer loses a prompt committed during startup.
  }

  private readNew(): void {
    if (this.closed) return
    if (this.reading || this.relocating) {
      // A read is in flight; queue a re-run instead of starting a
      // concurrent stream. See the class block comment for why
      // concurrent reads are unsafe.
      this.pendingRead = true
      return
    }
    this.reading = true

    let stat: Stats
    let fd: number | null = null
    try {
      // Pin and inspect the actual descriptor, not stat(path) followed by an
      // asynchronous open(path). A rename in that gap used to feed redirect
      // bytes into our decoder and advance the cursor before relocation ran.
      fd = openSync(this.filePath, 'r')
      stat = fstatSync(fd)
      const replaced = this.identity && (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)
      const continuous = this.cursorMatches(fd)
      // Exact-session owners must resolve a replacement before taking bytes
      // from it. Generic tailSessionFile/tailNewSessionFile have no such owner;
      // their existing contract follows atomic copies when the prefix matches.
      if (!continuous || (replaced && this.onDiscontinuity)) {
        closeSync(fd)
        this.reading = false
        if (this.onDiscontinuity) this.onDiscontinuity()
        else if (!this.reportedDiscontinuity) {
          this.reportedDiscontinuity = true
          this.onError?.(new Error('JSONL transcript diverged; cursor cannot be reused'))
        }
        return
      }
      this.identity = { dev: stat.dev, ino: stat.ino }
      this.reportedDiscontinuity = false
    } catch {
      if (fd !== null) closeSync(fd)
      // File temporarily missing — atomic-rename writers do this.
      // Skip and wait for the next poll tick.
      this.reading = false
      return
    }
    if (stat.size <= this.offset) {
      closeSync(fd)
      this.reading = false
      // If a re-run was queued while we were between the guard and
      // here, we still need to honor it even though this stat was a
      // no-op — the file may have grown between the two stats.
      if (this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
      return
    }

    const stream = createReadStream(this.filePath, {
      fd,
      autoClose: true,
      start: this.offset,
      end: stat.size - 1,
    })

    const chunks: Buffer[] = []
    let bytesRead = 0
    stream.on('data', d => {
      const bytes = typeof d === 'string' ? Buffer.from(d) : d
      chunks.push(bytes)
      bytesRead += bytes.length
    })
    stream.on('end', () => {
      // Do not mutate even the UTF-8 decoder until the requested snapshot was
      // read completely. A truncated/erroring read must leave a retryable cursor
      // and partial-codepoint state, not half-consumed replacement data.
      if (bytesRead !== stat.size - this.offset) {
        this.onDiscontinuity?.()
        this.finishRead()
        return
      }
      let chunk = ''
      for (const bytes of chunks) {
        chunk += this.decoder.write(bytes)
        this.anchor = Buffer.from(Buffer.concat([this.anchor, bytes]).subarray(-256))
      }
      this.offset = stat.size
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      // Last element is either '' (clean newline) or a partial line.
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed) as T
          this.onEntry(obj)
        } catch (err) {
          this.onError?.(err as Error)
        }
      }
      this.finishRead()
    })
    stream.on('error', err => {
      this.onError?.(err)
      this.finishRead()
    })
  }

  private finishRead(): void {
    this.reading = false
    for (const resolve of this.idleWaiters.splice(0)) resolve()
    // Serializing both retries and relocation keeps one authoritative cursor.
    if (this.pendingRead) { this.pendingRead = false; this.readNew() }
  }

  private cursorMatches(fd: number): boolean {
    const actual = Buffer.alloc(this.anchor.length)
    const bytes = readSync(fd, actual, 0, actual.length, this.offset - actual.length)
    return bytes === actual.length && actual.equals(this.anchor)
  }

  /**
   * Retarget an exact-session file without resetting the consumed byte cursor.
   * Native relocation preserves the transcript prefix, whether moved by rename
   * or copied to a new inode. Verify bytes at the cursor before reusing it: a
   * bootstrap replay can duplicate user prompts, while starting at EOF loses
   * every append made between the move and our discovery tick.
   *
   * Identity validation belongs to SessionTranscript; this lower-level reader
   * checks a bounded 256-byte anchor immediately before the cursor. This is a
   * continuity check for native append-only moves, not a full-file integrity
   * hash. A mismatch is explicit rather than guessing where rewritten history
   * ends, and large sessions do not require rereading their consumed prefix.
   */
  async relocate(filePath: string): Promise<void> {
    this.relocating = true
    try {
      if (this.reading) await new Promise<void>(resolve => this.idleWaiters.push(resolve))
      if (this.closed) return
      const fd = openSync(filePath, 'r')
      try {
        if (!this.cursorMatches(fd)) {
          throw new Error('Claude transcript diverged during relocation; cursor cannot be reused')
        }
        const stat = fstatSync(fd)
        this.identity = { dev: stat.dev, ino: stat.ino }
      } finally { closeSync(fd) }
      if (this.statListener) unwatchFile(this.filePath, this.statListener)
      this.filePath = filePath
      if (this.statListener) watchFile(filePath, { interval: FileTailer.POLL_INTERVAL_MS, persistent: true }, this.statListener)
    } finally {
      this.relocating = false
      this.pendingRead = false
      this.readNew()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.reading) await new Promise<void>(resolve => this.idleWaiters.push(resolve))
    if (this.watchdog !== null) clearInterval(this.watchdog)
    // Scoped unwatch — see statListener's WHY. Passing the listener is
    // the entire fix; do not "simplify" back to unwatchFile(path).
    if (this.statListener !== null) {
      unwatchFile(this.filePath, this.statListener)
      this.statListener = null
    }
  }
}

export type JsonlEntry = Record<string, unknown>

/**
 * Watches a CC project directory for the JSONL file CC creates when the
 * session starts, then tails it. Use case:
 *
 *   1. The consumer spawns `claude` with cwd=X
 *   2. Before/right after spawn, we call `tailNewSessionFile(projectDir, ...)`
 *   3. CC creates ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
 *   4. The tailer notices the new .jsonl, opens it, and starts emitting entries
 *
 * Returns a stop() function that tears down both the directory watcher
 * and the file tailer.
 */
export async function tailNewSessionFile<T extends JsonlEntry = JsonlEntry>(
  projectDir: string,
  onEntry: (entry: T, file: string) => void,
  onError?: (err: Error) => void,
  options?: {
    /**
     * Fresh Claude sessions can create their root transcript before
     * this watcher is fully armed because the caller must already
     * have an IPty before it can construct ClaudeCodeHeadless. When
     * provided, files whose mtime/ctime land after this timestamp are
     * treated as candidates for "the session we just spawned" even if
     * they already existed by the time our initial directory snapshot
     * ran.
     */
    freshSinceMs?: number
  },
): Promise<() => Promise<void>> {
  // Ensure the directory exists. CC creates it on first write, but we
  // need a stable directory before we can arm either the watcher or
  // the timestamp-based recovery path below. mkdir -p is harmless if
  // it already exists.
  await mkdir(projectDir, { recursive: true })

  // Snapshot the existing files so we can ignore old transcripts and
  // only pick up the JSONL produced by the session we're about to
  // start.
  //
  // WHY the timestamp escape hatch exists:
  //
  // The public invariant sounds simple: "attach the tailer before the
  // terminal mirror starts processing PTY data." That is true, but it
  // is not strong enough. The PTY process itself is already alive by
  // the time ClaudeCodeHeadless can exist, and Claude can create
  // `<sessionId>.jsonl` in the narrow spawn -> tailer window. The old
  // code put that file into `existing` and then ignored it forever,
  // leaving the app with proxy/semantic events but no committed
  // transcript and no providerSessionId capture. A timestamp taken
  // immediately before spawning the PTY lets us distinguish "old
  // transcript from last week" from "fresh transcript created while
  // we were still wiring the tailer."
  const existing = new Set<string>()
  const freshCandidates: string[] = []
  try {
    for (const name of await readdir(projectDir)) {
      if (!name.endsWith('.jsonl')) continue
      existing.add(name)
      if (typeof options?.freshSinceMs === 'number') {
        const filePath = join(projectDir, name)
        try {
          const stat = statSync(filePath)
          const changedAt = Math.max(stat.mtimeMs, stat.ctimeMs)
          if (changedAt >= options.freshSinceMs) {
            freshCandidates.push(filePath)
          }
        } catch (err) {
          onError?.(err as Error)
        }
      }
    }
  } catch (err) {
    onError?.(err as Error)
  }

  let tailer: FileTailer<T> | null = null

  const attach = (filePath: string) => {
    if (tailer) return
    tailer = new FileTailer<T>(
      filePath,
      entry => onEntry(entry, filePath),
      onError,
    )
  }

  const dirWatcher = watch(projectDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: false,
  })

  dirWatcher.on('add', filePath => {
    const name = basename(filePath)
    if (!name.endsWith('.jsonl')) return
    if (existing.has(name)) return
    attach(filePath)
  })

  dirWatcher.on('error', err => onError?.(err as Error))

  // Attach after the watcher is registered so that, if our timestamp
  // candidate was not actually the right file and Claude creates the
  // real root transcript a moment later, the normal add path is still
  // active. In the pathological case we are fixing, this immediately
  // opens the already-created fresh file and emits its initial lines,
  // which also gives the renderer the providerSessionId it persists.
  freshCandidates
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs
      } catch {
        return 0
      }
    })
    .slice(0, 1)
    .forEach(attach)

  return async () => {
    await dirWatcher.close()
    if (tailer) await tailer.close()
  }
}

/**
 * Convenience for tailing a specific session file by absolute path
 * (when the file is already known).
 */
export function tailSessionFile<T extends JsonlEntry = JsonlEntry>(
  filePath: string,
  onEntry: (entry: T) => void,
  onError?: (err: Error) => void,
  options?: {
    bootstrapTailLines?: number
  },
): () => Promise<void> {
  const tailer = new FileTailer<T>(filePath, onEntry, onError, options)
  return async () => {
    await tailer.close()
  }
}
