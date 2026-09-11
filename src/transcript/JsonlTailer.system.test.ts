import { appendFileSync, mkdtempSync, renameSync, rmSync, unwatchFile, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileTailer } from './JsonlTailer.js'

// Regression tests for the scoped-unwatch fix (agent-code residue plan P0,
// 2026-07). The bug: close() called unwatchFile(path) with NO listener
// argument — Node removes EVERY stat-watcher for that path process-wide.
// agent-code's replaceSession spawns the new session before killing the
// old, and on in-place resume both tail the SAME rollout file, so the old
// session's close deterministically killed the new pane's watcher: the
// "dead committed channel" / "prompt stuck in queue" bug family. Prompts
// were in the rollout 12ms after submit and never ingested.

const openTailers: FileTailer<unknown>[] = []
const temporaryDirectories: string[] = []

function makeFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tailer-test-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'rollout.jsonl')
  writeFileSync(file, JSON.stringify({ seq: 0 }) + '\n')
  return file
}

function tail(file: string, out: number[], watchdogMs?: number, onError?: (e: Error) => void): FileTailer<{ seq: number }> {
  const t = new FileTailer<{ seq: number }>(file, e => out.push(e.seq), onError, watchdogMs ? { watchdogMs } : undefined)
  openTailers.push(t as FileTailer<unknown>)
  return t
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return pred()
}

afterEach(async () => {
  try {
    while (openTailers.length > 0) await openTailers.pop()?.close()
  } finally {
    // WHY cleanup is in finally rather than after close(): a watcher failure
    // is exactly the scenario these tests exercise. Leaving the fixture behind
    // when close throws makes later files depend on the order Vitest chose.
    while (temporaryDirectories.length > 0) {
      rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
    }
  }
})

describe('FileTailer scoped unwatch', () => {
  it('continues a prefix-preserving atomic replacement without a relocation owner', async () => {
    const file = makeFile(); const seen: number[] = []; const diagnostics: string[] = []
    tail(file, seen, undefined, error => diagnostics.push(error.message))
    expect(await waitFor(() => seen.includes(0), 5_000)).toBe(true)
    // The generic public tail helpers have no exact-session relocation callback.
    // A copied prefix on a new inode remains a valid append-only continuation.
    writeFileSync(file + '.next', [0, 1].map(seq => JSON.stringify({ seq })).join('\n') + '\n')
    renameSync(file + '.next', file)
    expect(await waitFor(() => seen.includes(1), 5_000)).toBe(true)
    appendFileSync(file, JSON.stringify({ seq: 2 }) + '\n')
    expect(await waitFor(() => seen.includes(2), 5_000)).toBe(true)
    expect(seen).toEqual([0, 1, 2]); expect(diagnostics).toEqual([])
  }, 10_000)

  it(
    'a second tailer on the same path survives the first one closing',
    async () => {
      const file = makeFile()
      const seenByB: number[] = []
      const a = tail(file, [])
      tail(file, seenByB)

      // WHY readiness is observed before closing A: FileTailer intentionally
      // bootstraps through an asynchronous read stream. Racing the append
      // against that bootstrap tests scheduler luck rather than scoped unwatch
      // ownership, and failed under coverage load despite correct watcher
      // behavior. Seeing seq=0 proves B owns a live initialized tail first.
      expect(await waitFor(() => seenByB.includes(0), 5_000)).toBe(true)

      // The exact production sequence: old session (A) closes while the new
      // session (B) tails the same rollout.
      await a.close()
      appendFileSync(file, JSON.stringify({ seq: 1 }) + '\n')
      appendFileSync(file, JSON.stringify({ seq: 2 }) + '\n')

      expect(await waitFor(() => seenByB.includes(2), 5_000)).toBe(true)
      expect(seenByB).toContain(1)
    },
    15_000,
  )

  it('watchdog self-heals a murdered watcher and surfaces a diagnostic', async () => {
    const file = makeFile()
    const seen: number[] = []
    const diagnostics: string[] = []
    tail(file, seen, 200, e => diagnostics.push(e.message))

    // Simulate the legacy bug class from a third party: strip EVERY
    // watcher on the path (this is exactly what the unscoped
    // unwatchFile(path) used to do to innocent tailers).
    unwatchFile(file)
    appendFileSync(file, JSON.stringify({ seq: 1 }) + '\n')

    // The stat watcher is dead, so only the watchdog can deliver this.
    expect(await waitFor(() => seen.includes(1), 3000)).toBe(true)
    expect(diagnostics.some(m => m.includes('tail-stalled'))).toBe(true)
  })
})
