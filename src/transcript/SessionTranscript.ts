import { open, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { FileTailer, type JsonlEntry } from './JsonlTailer.js'
import { getProjectDirForCwd, getProjectsDir } from './ProjectDir.js'

// Launch cwd is a discovery hint, not session identity: native EnterWorktree
// moves the same UUID between Claude project directories. Keep this resolver
// shared by live observation and host history/rewind callers, otherwise a pane
// can display proxy output while acknowledging prompts against a missing file.
const INSPECTION_BYTES = 256 * 1024
const MAX_RELOCATION_HOPS = 16

async function inspect(file: string, sessionId: string): Promise<{ relocatedCwd: string | null } | null> {
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const { size } = await handle.stat()
    if (size === 0) return null // a just-created fresh file has no identity yet
    const head = Buffer.alloc(Math.min(size, INSPECTION_BYTES))
    await handle.read(head, 0, head.length, 0)
    let text = head.toString('utf8')
    if (size > head.length) {
      text = text.slice(0, text.lastIndexOf('\n') + 1)
      const start = Math.max(head.length, size - INSPECTION_BYTES)
      const tail = Buffer.alloc(size - start)
      await handle.read(tail, 0, tail.length, start)
      const tailText = tail.toString('utf8')
      text += start === head.length ? tailText : tailText.slice(tailText.indexOf('\n') + 1)
    }
    let matched = false
    let relocatedCwd: string | null = null
    for (const line of text.split('\n')) {
      let value: Record<string, unknown>
      try { value = JSON.parse(line) } catch { continue }
      if (!value || typeof value !== 'object') continue
      if (typeof value.sessionId !== 'string') continue
      if (value.sessionId !== sessionId) {
        throw new Error(`Claude transcript identity mismatch for ${sessionId}`)
      }
      matched = true
      if (value.type === 'relocated' && typeof value.relocatedCwd === 'string') {
        if (!isAbsolute(value.relocatedCwd)) throw new Error('Invalid Claude transcript relocation directory')
        relocatedCwd = value.relocatedCwd
      }
    }
    // A matching filename alone is insufficient: copied/exported transcripts
    // can retain another identity. Bounded inspection fails explicitly rather
    // than selecting unreadable data or parsing every multi-megabyte tool result.
    if (!matched) throw new Error(`Claude transcript identity is unverified for ${sessionId}`)
    return { relocatedCwd }
  } finally { await handle.close() }
}

function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Claude session id')
}

/** Resolve exactly one native session; null means no durable file was found. */
export async function resolveClaudeTranscriptPath(cwd: string, sessionId: string): Promise<string | null> {
  validateSessionId(sessionId)
  const filename = `${sessionId}.jsonl`
  const hinted = join(await getProjectDirForCwd(cwd), filename)
  const follow = async (start: string): Promise<string | null> => {
    const visited = new Set<string>()
    let file = start
    for (let hop = 0; hop < MAX_RELOCATION_HOPS; hop++) {
      if (visited.has(file)) throw new Error(`Claude transcript relocation cycle for ${sessionId}`)
      visited.add(file)
      const found = await inspect(file, sessionId)
      if (!found) {
        if (file === start) return null
        throw new Error(`Claude transcript relocation destination unavailable for ${sessionId}`)
      }
      if (!found.relocatedCwd) return file
      const target = join(await getProjectDirForCwd(found.relocatedCwd), filename)
      // Native snapshots repeat relocation metadata at the destination. A
      // self-pointer is the terminal node, not a cycle or another move.
      if (target === file) return file
      file = target
    }
    throw new Error(`Claude transcript relocation chain too long for ${sessionId}`)
  }
  const direct = await follow(hinted)
  if (direct) return direct
  const root = getProjectsDir()
  const directories = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const resolved = new Set<string>()
  // Inspect only this UUID's immediate project files, never recursive subagent
  // transcripts. Sequential reads bound descriptors even with thousands of
  // projects; no mtime heuristic may decide which conversation receives input.
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    const file = join(root, directory.name, filename)
    if (file === hinted) continue
    const candidate = await follow(file)
    if (candidate) resolved.add(candidate)
  }
  if (resolved.size > 1) throw new Error(`Claude transcript is ambiguous for ${sessionId}`)
  return resolved.values().next().value ?? null
}

/** Exact-session observation with cursor continuity across native relocation. */
export async function followClaudeTranscript<T extends JsonlEntry>(
  cwd: string,
  sessionId: string,
  onEntry: (entry: T, file: string) => void,
  onError: (error: Error) => void,
  options: { bootstrapTailLines: number; allowMissing: boolean },
): Promise<{ projectDir: string; stop: () => Promise<void> }> {
  validateSessionId(sessionId)
  // The caller explicitly owns a freshly assigned UUID. Its original file may
  // be absent or halfway through its first append; bootstrap that exact path
  // and validate each completed entry. Global discovery here would both reject
  // valid partial first writes and scan every project on every fresh spawn.
  const resolved = options.allowMissing ? null : await resolveClaudeTranscriptPath(cwd, sessionId)
  if (!resolved && !options.allowMissing) throw new Error(`Claude transcript not found for session ${sessionId}`)
  let file: string = resolved ?? join(await getProjectDirForCwd(cwd), `${sessionId}.jsonl`)
  let lastFileStat = await stat(file).catch(() => null)
  let closed = false
  let hasObservedEntry = false
  let relocationRevision = 0
  let checkedRelocationRevision = 0
  let retryDelayMs = 500
  let lastError: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  const tailer = new FileTailer<T>(file, entry => {
    if (closed) return
    hasObservedEntry = true
    // Identity is checked for every live record as well as initial discovery.
    // A foreign record must never enter a host's prompt-acceptance observer.
    if (typeof entry.sessionId === 'string' && entry.sessionId !== sessionId) {
      onError(new Error(`Claude transcript identity mismatch for ${sessionId}`)); return
    }
    if (entry.type === 'relocated') relocationRevision += 1
    onEntry(entry, file)
  }, onError, { bootstrapTailLines: options.bootstrapTailLines })
  const check = async (): Promise<void> => {
    try {
      const currentStat = await stat(file).catch(() => null)
      const replaced = lastFileStat !== null && currentStat !== null && (
        lastFileStat.ino !== currentStat.ino || lastFileStat.dev !== currentStat.dev ||
        currentStat.size < lastFileStat.size
      )
      lastFileStat = currentStat
      const present = currentStat !== null
      const revision = relocationRevision
      if (revision === checkedRelocationRevision && present && !replaced && lastError === null) return
      const next = await resolveClaudeTranscriptPath(cwd, sessionId)
      // A fresh UUID may still be waiting for its first write, or its original
      // file may already have moved between polls. Discovery must remain live
      // even before the first observed record. Back off absent fresh files
      // without diagnosing disconnection; normal created files take stat's
      // fast path above and never require this cross-project scan.
      if (!next && !hasObservedEntry && options.allowMissing && revision === 0) {
        retryDelayMs = Math.min(10_000, retryDelayMs * 2)
        return
      }
      if (!next) throw new Error(`Claude transcript not found for session ${sessionId}`)
      if (closed) return
      // A move may replace its original file with a short redirect stub. The
      // byte tail cannot see a shorter file's marker, so inode/size changes also
      // trigger resolution. Merely checking existence would strand that shape.
      if (next !== file || replaced) {
        await tailer.relocate(next)
        file = next
        lastFileStat = await stat(file).catch(() => null)
      }
      // A newer relocation may arrive while resolution is awaiting disk I/O.
      // A boolean reset would erase it and strand copy-based moves whose old
      // file still exists. Acknowledge only the revision actually inspected.
      checkedRelocationRevision = revision
      retryDelayMs = 500
      lastError = null
    } catch (error) {
      // Missing destinations can outlive a move (unmounted/deleted worktrees).
      // Bound repeated discovery work while retaining a recovery opportunity
      // inside the host's 20-second durable-acceptance window.
      retryDelayMs = Math.min(10_000, retryDelayMs * 2)
      const err = error instanceof Error ? error : new Error(String(error))
      if (!closed && err.message !== lastError) { lastError = err.message; onError(err) }
    }
  }
  const schedule = (): void => {
    timer = setTimeout(() => {
      if (closed) return
      running = check().finally(() => { running = null; if (!closed) schedule() })
    }, retryDelayMs)
    timer.unref?.()
  }
  schedule()
  return {
    projectDir: dirname(file),
    stop: async () => {
      closed = true
      if (timer) clearTimeout(timer)
      await running
      await tailer.close()
    },
  }
}
