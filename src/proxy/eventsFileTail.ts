import { open, stat, type FileHandle } from 'fs/promises'
import { extname } from 'path'

/**
 * The previous generation's path, as mitmAddon.py `_rotated_path()` names it:
 * `proxy-events.jsonl` -> `proxy-events.1.jsonl`. The two MUST agree; the addon
 * renames to this path and the tail drains it after a rotation.
 */
export function rotatedEventsPath(eventsFile: string): string {
  const ext = extname(eventsFile)
  return `${eventsFile.slice(0, eventsFile.length - ext.length)}.1${ext}`
}

export type EventsFilePoll = {
  /** Complete lines, oldest first. */
  lines: string[]
  /**
   * Whole generations that were rotated away AND deleted before this tail
   * could read them — their events are gone. 0 in every normal run; see the
   * class comment for when it is not.
   */
  lostGenerations: number
}

/**
 * Incremental, rotation-aware reader of the mitm addon's events file.
 *
 * WHY this exists (agent-code #1273): the addon rotates the live file
 * (rename to `proxy-events.1.jsonl`, start a fresh one) so a long session's
 * file is bounded. This file is the TRANSPORT from mitmdump to the adapter —
 * the live transcript is built from its `response-chunk` lines — so a
 * rotation must not lose, split or repeat events.
 *
 * WHY the tail HOLDS AN OPEN HANDLE on the generation it is reading (review
 * of claude-code-headless#64, steering q53): the first version stat()ed the
 * path and later open()ed it by name. A rotation between those two calls made
 * it read the NEW file with the OLD file's size and offset, then drain the old
 * generation from that wrong offset on the next poll — reviewers reproduced
 * `b,c,d` arriving as `d,c,d`. A handle names one inode for its whole life:
 * its size comes from fstat on that same handle, and its bytes stay readable
 * after the addon renames it, and even after a second rotation deletes it.
 * Rotation is detected by the PATH's inode differing from the held one; the
 * held generation is then read to its end (the addon never writes to an inode
 * after renaming it, so that end is final) before the next one starts at 0.
 *
 * GENERATIONS: every live file the addon creates by rotating starts with a
 * header line `{"kind":"generation","generation":n}` (the first file has none
 * and is generation 0). The tail strips it and so always knows which generation
 * it holds. (The first design kept a counter file beside the log; bumped
 * before or after the rename, a reader could pair it with the wrong file and
 * report a lost generation as 0 — round 2 of the #64 review.)
 *
 * DELIVERY CONTRACT — exactly once and in order, OR an explicit gap:
 *   Whenever the tail adopts a live file of generation n, every generation
 *   below n it has not finished is either read — the one directly below n can
 *   only be at `.1` — or counted in `lostGenerations`. That covers one or two
 *   rotations between polls, rotations while a poll is between awaits, and a
 *   rotation before the very first poll. Only generations deleted before
 *   anyone could read them (the poller stalled through >= 1 GiB of traffic at
 *   the 512 MiB default) are lost, and they are counted exactly.
 *   We chose the bounded, reported gap over an acknowledgement protocol
 *   (the addon keeping generations until the app confirms them) because an
 *   ack channel would need a second writer in the app, and a stalled or dead
 *   app would then let the proxy's disk use grow without bound again — the
 *   very bug #1273 is about.
 *
 * WHY incremental reads from an offset, never readFile(whole file): the poller
 * originally did `readFile(eventsFile, 'utf8')` every 200 ms. The file reached
 * 308 MB on 2026-07-07; each poll allocated a file-sized string in V8's
 * large_object_space, several were reachable at once, and the main process
 * OOMed (heapUsed 2726 MB, 2702 MB of it large_object_space). Reading only
 * [offset, size) keeps each poll proportional to NEW bytes. The in-flight
 * guard is the caller's (ProxyServer).
 *
 * OFFSET SEMANTICS: `offset` is a BYTE offset into the held generation. Byte
 * slicing is safe because we only cut at `\n` (0x0A never appears inside a
 * UTF-8 multibyte sequence), and the addon writes ensure_ascii JSON anyway.
 */
type Held = {
  fh: FileHandle
  ino: number
  /** From the header line; null until the file's first line has been seen. */
  generation: number | null
}

export class EventsFileTail {
  private held: Held | null = null
  private offset = 0
  /** Highest generation fully read or already counted as lost. */
  private settledGeneration = -1

  constructor(private readonly eventsFile: string) {}

  async poll(): Promise<EventsFilePoll> {
    const out: EventsFilePoll = { lines: [], lostGenerations: 0 }
    if (!this.held && !(await this.openLive())) return out
    await this.readLive(out)

    // Rotated? Only the PATH can say; the handle keeps naming the old inode.
    const live = await stat(this.eventsFile).catch(() => null)
    if (live && live.ino !== this.held!.ino) {
      // The rename happened before this stat, so the held inode is final:
      // finish it. Its trailing partial line (only after a writer crash) is
      // dropped with the generation.
      await this.readLive(out)
      const finished = this.held!
      if (finished.generation !== null) this.settledGeneration = Math.max(this.settledGeneration, finished.generation)
      await this.closeHeld()
      if (await this.openLive()) await this.readLive(out)
    }
    return out
  }

  async close(): Promise<void> {
    await this.closeHeld()
  }

  private async openLive(): Promise<boolean> {
    const fh = await open(this.eventsFile, 'r').catch(() => null)
    if (!fh) return false
    const { ino } = await fh.stat()
    this.held = { fh, ino, generation: null }
    this.offset = 0
    return true
  }

  /**
   * Read the held live generation. The first time its generation becomes
   * known, settle every older generation first — read the one at `.1` if it is
   * unread, count the rest as lost — so lines stay in order.
   */
  private async readLive(out: EventsFilePoll): Promise<void> {
    const held = this.held!
    const lines = await this.readFrom(held)
    if (lines === null) return
    if (held.generation === null) {
      held.generation = generationOf(lines[0]) ?? 0
      if (generationOf(lines[0]) !== null) lines.shift()
      await this.settleBelow(held.generation, held.ino, out)
    }
    out.lines.push(...lines)
  }

  private async settleBelow(generation: number, liveIno: number, out: EventsFilePoll): Promise<void> {
    const settledBefore = this.settledGeneration
    let readRotated = 0
    if (generation - 1 > settledBefore) {
      // The generation directly below the live one can only be at `.1`: the
      // addon renames live -> `.1` and then creates the next live file.
      const rotated = await open(rotatedEventsPath(this.eventsFile), 'r').catch(() => null)
      if (rotated) {
        const liveOffset = this.offset
        try {
          const { ino } = await rotated.stat()
          // Never the live file itself (a rename racing this open). The
          // generation we just finished never gets here: its generation is known
          // once its last read resolves, so `generation - 1` is already settled.
          if (ino !== liveIno) {
            this.offset = 0
            const lines = (await this.readFrom({ fh: rotated, ino, generation: null })) ?? []
            const header = generationOf(lines[0])
            if (header !== null) lines.shift()
            if ((header ?? 0) === generation - 1) {
              out.lines.push(...lines)
              readRotated = 1
            }
          }
        } catch {
          // An I/O error on `.1` fails closed: the generation is counted as
          // lost below instead of throwing away the live lines already read
          // (round 2 of the #64 review).
        } finally {
          this.offset = liveOffset
          await rotated.close().catch(() => {})
        }
      }
    }
    // Everything between what we had settled and the live generation that was
    // neither read nor still readable is gone: count it, exactly.
    out.lostGenerations += Math.max(0, generation - 1 - settledBefore - readRotated)
    this.settledGeneration = Math.max(settledBefore, generation - 1)
  }

  private async closeHeld(): Promise<void> {
    const held = this.held
    this.held = null
    await held?.fh.close().catch(() => {})
  }

  /**
   * Read [offset, current size) of `file` and return its complete lines (null
   * when there is no complete line yet), advancing `offset` only past the last
   * `\n`. Loops until the size fstat reported, because a FileHandle read may
   * return fewer bytes than asked (review of #64: a short read before closing
   * a finished generation silently dropped its tail).
   */
  private async readFrom(file: Held): Promise<string[] | null> {
    const { size } = await file.fh.stat()
    if (size < this.offset) {
      // Same inode, shorter: truncated in place. mitmdump never does this; a
      // manual `: > proxy-events.jsonl` would. Restart rather than wait
      // forever for the file to grow past a stale offset.
      this.offset = 0
    }
    if (size === this.offset) return null
    const buf = Buffer.alloc(size - this.offset)
    let filled = 0
    while (filled < buf.length) {
      const { bytesRead } = await file.fh.read(buf, filled, buf.length - filled, this.offset + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const data = buf.subarray(0, filled)
    const lastNl = data.lastIndexOf(0x0a)
    if (lastNl === -1) return null
    this.offset += lastNl + 1
    return data
      .subarray(0, lastNl)
      .toString('utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  }
}

/** The generation a header line names, or null when the line is not a header. */
function generationOf(line: string | undefined): number | null {
  if (line === undefined || !line.includes('"generation"')) return null
  try {
    const value = JSON.parse(line) as { kind?: unknown; generation?: unknown }
    return value.kind === 'generation' && typeof value.generation === 'number' && Number.isInteger(value.generation)
      ? value.generation
      : null
  } catch {
    return null
  }
}
