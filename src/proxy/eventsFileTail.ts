import { open, stat } from 'fs/promises'
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

/**
 * Incremental, rotation-aware reader of the mitm addon's events file.
 *
 * WHY this exists as its own class (agent-code #1273): the addon now rotates
 * the live file (rename to `proxy-events.1.jsonl`, start a fresh one) so a
 * long session's file is bounded. This file is the TRANSPORT from mitmdump to
 * the adapter, so a rotation must not lose or repeat a single event. The logic
 * lived inline in ProxyServer behind a 200 ms timer; as a class it can be
 * driven step by step against the real addon in tests.
 *
 * WHY incremental (open + read from `offset`), never readFile(whole file): the
 * poller originally did `readFile(eventsFile, 'utf8')` every 200 ms. The file
 * reached 308 MB on 2026-07-07, each poll allocated a file-sized string in V8's
 * large_object_space, several were reachable at once without an in-flight
 * guard, and the main process OOMed (heapUsed 2726 MB, 2702 MB of it
 * large_object_space). Reading only [offset, size) keeps each poll proportional
 * to NEW bytes. The in-flight guard is the caller's (ProxyServer).
 *
 * ROTATION CONTRACT (writer side in mitmAddon.py `_write`): the addon is the
 * only writer, single-threaded, open-append-close per line, and renames only
 * after a whole line. So once the path's inode changes, the old inode — now at
 * `rotatedEventsPath` — is complete and will never grow again. Draining it from
 * our saved offset and then starting the new file at 0 yields every line
 * exactly once, in order. The addon keeps ONE previous generation; two
 * rotations between polls would need >= 2 x 512 MiB in 200 ms, which the
 * addon cannot produce, and the shrink fallback below still restarts cleanly.
 *
 * OFFSET SEMANTICS: `offset` is a BYTE offset. Byte slicing is safe because we
 * only cut at `\n` (0x0A never appears inside a UTF-8 multibyte sequence), and
 * the addon writes `json.dumps(...)` with ensure_ascii=True anyway.
 */
export class EventsFileTail {
  private offset = 0
  /** Inode of the file `offset` refers to; null until the file first exists. */
  private ino: number | null = null

  constructor(private readonly eventsFile: string) {}

  /** Complete lines appended since the last call, across a rotation. */
  async poll(): Promise<string[]> {
    const st = await stat(this.eventsFile).catch(() => null)
    if (!st) {
      // Absent: not created yet, or renamed away and the addon has not written
      // the next line. Keep our position; the next poll sees the new inode.
      return []
    }
    const lines: string[] = []
    if (this.ino !== null && st.ino !== this.ino) {
      // Rotated: finish the old generation first so no line written between
      // our last poll and the rename is lost. Its trailing partial line (only
      // possible after a writer crash) is dropped with the generation.
      const rotated = await stat(rotatedEventsPath(this.eventsFile)).catch(() => null)
      if (rotated && rotated.ino === this.ino) {
        lines.push(...(await this.readComplete(rotatedEventsPath(this.eventsFile), rotated.size)))
      }
      this.offset = 0
    } else if (st.size < this.offset) {
      // Same inode but shorter (truncated in place), or a file we never saw
      // the inode of was recreated: restart from 0 rather than never reading
      // again. mitmdump itself never truncates.
      this.offset = 0
    }
    this.ino = st.ino
    lines.push(...(await this.readComplete(this.eventsFile, st.size)))
    return lines
  }

  /**
   * Read [offset, size) and return its complete lines, advancing `offset` only
   * past the last `\n`. Anything after it is a write in progress and is re-read
   * on the next poll. (Earlier versions advanced to end-of-read up-front and
   * silently dropped a line that was mid-flush during the poll.)
   */
  private async readComplete(path: string, size: number): Promise<string[]> {
    if (size <= this.offset) return []
    const fh = await open(path, 'r')
    let buf: Buffer
    try {
      buf = Buffer.alloc(size - this.offset)
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close().catch(() => {})
    }
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
