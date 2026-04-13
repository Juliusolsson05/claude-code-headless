import { execFile } from 'child_process'

// ProcessInspector — Claude-only process-tree activity detection.
//
// Instead of screen-scraping activity indicators (fragile regex against
// TUI text that breaks when the UI changes), we inspect Claude Code's
// actual process tree. Claude spawns `caffeinate` while it's actively
// working a turn, which is a reliable boolean signal independent of
// terminal rendering.
//
// Architecture:
//   - ClaudeCodeHeadless owns a ProcessInspector, started after the
//     consumer-owned PTY already exists.
//   - Inspector polls at a configurable interval (default 1s).
//   - Each poll calls `pgrep -P <pid>` to get child processes, then
//     checks for Claude's `caffeinate` helper.
//   - Returns a ProcessState that consumers use for activity detection.
//
// macOS only for now. Linux/Windows would need different child-process
// enumeration but the interface stays the same.

export type ProcessState = {
  /** True when the agent is actively working a turn. Detected by the
   *  presence of a `caffeinate` descendant Claude spawns while a
   *  turn is in progress. */
  active: boolean
  /** PIDs of direct children of the root process. */
  children: number[]
}

const EMPTY_STATE: ProcessState = { active: false, children: [] }

export class ProcessInspector {
  private rootPid: number
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private _state: ProcessState = EMPTY_STATE
  private onChange: (state: ProcessState) => void

  constructor(
    rootPid: number,
    onChange: (state: ProcessState) => void,
    intervalMs = 1000,
  ) {
    this.rootPid = rootPid
    this.onChange = onChange
    this.intervalMs = intervalMs
  }

  get state(): ProcessState {
    return this._state
  }

  start(): void {
    if (this.timer) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async poll(): Promise<void> {
    try {
      const children = await getChildPids(this.rootPid)
      const active = await hasCaffeinateDescendant(this.rootPid)
      const next: ProcessState = { active, children }

      // Only notify on change to avoid flooding subscribers.
      if (next.active !== this._state.active) {
        this._state = next
        this.onChange(next)
      } else {
        this._state = next
      }
    } catch {
      this._state = EMPTY_STATE
    }
  }
}

/** Get direct child PIDs of a process. */
function getChildPids(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], (err, stdout) => {
      if (err) { resolve([]); return }
      const pids = stdout
        .trim()
        .split('\n')
        .map(s => parseInt(s, 10))
        .filter(n => !isNaN(n))
      resolve(pids)
    })
  })
}

/** Check if any descendant of `pid` (up to maxDepth levels) is caffeinate. */
async function hasCaffeinateDescendant(pid: number, maxDepth = 4): Promise<boolean> {
  let frontier = [pid]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const checks = await Promise.all(
      frontier.map(p =>
        new Promise<boolean>(res => {
          execFile('pgrep', ['-P', String(p), 'caffeinate'], (e, out) => {
            res(!e && out.trim().length > 0)
          })
        }),
      ),
    )
    if (checks.some(Boolean)) return true

    const nextFrontier: number[] = []
    await Promise.all(
      frontier.map(async p => {
        const children = await getChildPids(p)
        nextFrontier.push(...children)
      }),
    )
    frontier = nextFrontier
  }
  return false
}
