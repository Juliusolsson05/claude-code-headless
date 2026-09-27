import { open, readFile, stat, type FileHandle } from 'fs/promises'
import { dirname, extname, join } from 'path'

/**
 * The previous generation's path, as mitmAddon.py `_rotated_path()` names it:
 * `proxy-events.jsonl` -> `proxy-events.1.jsonl`. The two MUST agree; the addon
 * renames to this path and the tail drains it after a rotation.
 */
export function rotatedEventsPath(eventsFile: string): string {
  const ext = extname(eventsFile)
  return `${eventsFile.slice(0, eventsFile.length - ext.length)}.1${ext}`
}

/**
 * The addon's rotation counter, next to the events file (mitmAddon.py
 * `_ROTATIONS_FILE_NAME`). It only ever increases, and is bumped BEFORE each
 * rename, so a reader that sees a rename also sees its count.
 */
export function rotationsCounterPath(eventsFile: string): string {
  return join(dirname(eventsFile), 'proxy-events.rotations')
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
 * DELIVERY CONTRACT — exactly once and in order, OR an explicit gap:
 *   - one rotation between polls: the held generation is finished, then the
 *     new one. Nothing lost.
 *   - two rotations between polls, including one that lands while the poll
 *     itself is between awaits: the held generation is finished, the live one
 *     is opened, and the unseen generation between them — necessarily at `.1`
 *     — is read whole before it. Nothing lost. Pinned at every path-level
 *     await point by the rotation tests.
 *   - three or more (the poller stalled for >= 1 GiB of traffic at the
 *     512 MiB default): the generations between are deleted before anyone
 *     could read them. That is reported as `lostGenerations` from the addon's
 *     rotation counter instead of being passed off as exactly-once. The
 *     count is a lower bound: a rotation that races the counter read is
 *     reported on the next poll.
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
export class EventsFileTail {
  private held: { fh: FileHandle; ino: number; rotationsAtOpen: number } | null = null
  private offset = 0

  constructor(private readonly eventsFile: string) {}

  async poll(): Promise<EventsFilePoll> {
    const lines: string[] = []
    let lostGenerations = 0
    if (!this.held) {
      if (!(await this.openLive())) return { lines, lostGenerations }
    }
    const held = this.held!
    lines.push(...(await this.readHeld()))

    // Rotated? Only the PATH can say; the handle keeps naming the old inode.
    const live = await stat(this.eventsFile).catch(() => null)
    if (live && live.ino !== held.ino) {
      // The rename happened before this stat, so the held inode is final:
      // finish it. Its trailing partial line (only after a writer crash) is
      // dropped with the generation.
      lines.push(...(await this.readHeld()))
      await this.closeHeld()
      let generationsRead = 1
      // Take the live handle BEFORE looking at `.1`. Then any generation
      // between the one we finished and the one we now hold can only be at
      // `.1` (a later rename would move the held live file itself there, which
      // the inode check below recognises). Checking `.1` first and opening the
      // live path second let a rename slip between the two and skip a whole
      // generation (found by the per-await-point rotation test).
      const liveOpened = await this.openLive()
      const current = this.held
      const middle = await this.openIfUnseen(rotatedEventsPath(this.eventsFile), held.ino, current?.ino)
      if (middle) {
        // A complete, renamed generation we never opened: read it whole,
        // before the live one, to keep the order.
        const liveOffset = this.offset
        this.held = { ...middle, rotationsAtOpen: 0 }
        lines.push(...(await this.readHeld()))
        await this.closeHeld()
        this.held = current
        this.offset = liveOffset
        generationsRead += 1
      }
      if (liveOpened) lines.push(...(await this.readHeld()))
      // Every rename since we opened the finished file moved exactly one
      // generation out of the live path; the ones we did not read are gone.
      // A rename that races openLive's counter read is counted on the next
      // rotation instead of this one.
      const rotated = (current?.rotationsAtOpen ?? (await this.readRotations())) - held.rotationsAtOpen
      lostGenerations = Math.max(0, rotated - generationsRead)
    }
    return { lines, lostGenerations }
  }

  async close(): Promise<void> {
    await this.closeHeld()
  }

  private async openLive(): Promise<boolean> {
    const rotationsAtOpen = await this.readRotations()
    const fh = await open(this.eventsFile, 'r').catch(() => null)
    if (!fh) return false
    const { ino } = await fh.stat()
    this.held = { fh, ino, rotationsAtOpen }
    this.offset = 0
    return true
  }

  private async openIfUnseen(path: string, ...seen: Array<number | undefined>): Promise<{ fh: FileHandle; ino: number } | null> {
    const fh = await open(path, 'r').catch(() => null)
    if (!fh) return null
    const { ino } = await fh.stat()
    if (seen.includes(ino)) {
      await fh.close().catch(() => {})
      return null
    }
    this.offset = 0
    return { fh, ino }
  }

  private async closeHeld(): Promise<void> {
    const held = this.held
    this.held = null
    await held?.fh.close().catch(() => {})
  }

  private async readRotations(): Promise<number> {
    const raw = await readFile(rotationsCounterPath(this.eventsFile), 'utf8').catch(() => '0')
    const value = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  /**
   * Read [offset, current size) of the HELD generation and return its complete
   * lines, advancing `offset` only past the last `\n`. Anything after it is a
   * write in progress and is re-read next time. (An earlier version advanced
   * to end-of-read up-front and silently dropped a line mid-flush.)
   */
  private async readHeld(): Promise<string[]> {
    const fh = this.held!.fh
    const { size } = await fh.stat()
    if (size < this.offset) {
      // Same inode, shorter: truncated in place. mitmdump never does this; a
      // manual `: > proxy-events.jsonl` would. Restart rather than wait
      // forever for the file to grow past a stale offset.
      this.offset = 0
    }
    if (size === this.offset) return []
    let buf = Buffer.alloc(size - this.offset)
    const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
    buf = buf.subarray(0, bytesRead)
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl === -1) return []
    this.offset += lastNl + 1
    return buf
      .subarray(0, lastNl)
      .toString('utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  }
}
