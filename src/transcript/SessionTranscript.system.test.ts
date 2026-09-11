import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { ClaudeCodeHeadless, getProjectDirForCwd, resolveClaudeTranscriptPath } from '../index.js'

const ID = '11111111-1111-4111-8111-111111111111'
let root: string
let cwd: string
let worktree: string
const sessions: ClaudeCodeHeadless[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-relocation-'))
  cwd = join(root, 'project'); worktree = join(cwd, '.worktrees', 'feature')
  await mkdir(worktree, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'))
})
afterEach(async () => {
  try { await Promise.all(sessions.splice(0).map(session => session.stop())) }
  finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
async function pathFor(directory: string): Promise<string> {
  const path = join(await getProjectDirForCwd(directory), `${ID}.jsonl`)
  await mkdir(dirname(path), { recursive: true }); return path
}
function user(n: number, sessionId = ID): string {
  return JSON.stringify({ type: 'user', sessionId, uuid: `user-${n}`, timestamp: new Date(1_000 + n).toISOString(), message: { role: 'user', content: `prompt ${n}` } }) + '\n'
}
function moved(directory: string): string {
  return JSON.stringify({ type: 'relocated', sessionId: ID, relocatedCwd: directory }) + '\n'
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 4_000
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  expect(predicate()).toBe(true)
}
// Consumer-owned PTY with no process or personal configuration access. The
// public headless API consumes real disk records; a screen is not our oracle.
function pty(): IPty {
  return { pid: 1, process: 'fixture', cols: 80, rows: 24, handleFlowControl: false,
    write() {}, resize() {}, clear() {}, pause() {}, resume() {}, kill() {},
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  }
}
function session(options: { allowMissingTranscript?: boolean } = {}) {
  const headless = new ClaudeCodeHeadless({ pty: pty(), cwd, resumeSessionId: ID, ...options })
  const seen: number[] = []; const errors: string[] = []
  headless.on('jsonl-entry', entry => { if (entry.type === 'user') seen.push(Number(String(entry.uuid).slice(5))) })
  headless.on('jsonl-error', error => errors.push(error.message))
  sessions.push(headless); return { headless, seen, errors }
}
describe('exact Claude transcript identity across worktrees', () => {
  it('resumes a relocated transcript when the original file is gone', async () => {
    const actual = await pathFor(worktree)
    await writeFile(actual, moved(worktree) + user(1))
    expect(await resolveClaudeTranscriptPath(cwd, ID)).toBe(actual)
    const { headless, seen } = session()
    expect(await headless.start()).toMatchObject({ projectDir: dirname(actual) })
    expect(seen).toEqual([1]); await appendFile(actual, user(2))
    await waitFor(() => seen.includes(2)); expect(seen).toEqual([1, 2])
  })
  it('follows relocation metadata when the original file still exists', async () => {
    const original = await pathFor(cwd); const actual = await pathFor(worktree)
    await writeFile(original, user(1) + moved(worktree)); await copyFile(original, actual)
    await appendFile(actual, user(2))
    expect(await resolveClaudeTranscriptPath(cwd, ID)).toBe(actual)
  })
  it('rejects ambiguous copies instead of choosing the newest transcript', async () => {
    await writeFile(await pathFor(worktree), user(1))
    await writeFile(await pathFor(join(root, 'other')), user(2))
    await expect(resolveClaudeTranscriptPath(cwd, ID)).rejects.toThrow(/ambiguous/i)
  })
  it('rejects a matching filename carrying a foreign session id', async () => {
    await writeFile(await pathFor(cwd), user(1, 'foreign-session'))
    await expect(resolveClaudeTranscriptPath(cwd, ID)).rejects.toThrow(/identity/i)
  })
  it('surfaces missing resumes while an explicitly fresh session waits for its first write', async () => {
    await expect(session().headless.start()).rejects.toThrow(/transcript.*not found/i)
    const fresh = session({ allowMissingTranscript: true }); await fresh.headless.start()
    await writeFile(await pathFor(cwd), user(1))
    await waitFor(() => fresh.seen.includes(1)); expect(fresh.seen).toEqual([1])
  })
  it('preserves a partial first append when an explicitly fresh reader starts', async () => {
    const file = await pathFor(cwd)
    const line = user(1)
    await writeFile(file, line.slice(0, 40))
    const fresh = session({ allowMissingTranscript: true })
    await fresh.headless.start()
    await appendFile(file, line.slice(40))
    await waitFor(() => fresh.seen.includes(1))
    expect(fresh.seen).toEqual([1])
    expect(fresh.errors).toEqual([])
  })

  it('finds a fresh file relocated before its first observation', async () => {
    const fresh = session({ allowMissingTranscript: true })
    await fresh.headless.start()
    // A fast native move can finish between stat polls. Never observing the
    // original file does not make this assigned UUID a permanently empty chat.
    await writeFile(await pathFor(worktree), moved(worktree) + user(1))
    await waitFor(() => fresh.seen.includes(1))
    expect(fresh.seen).toEqual([1])
    expect(fresh.errors).toEqual([])
  })

  it('does not guess through a stale relocation destination', async () => {
    await writeFile(await pathFor(cwd), user(1) + moved(worktree))
    await expect(resolveClaudeTranscriptPath(cwd, ID)).rejects.toThrow(/relocation/i)
  })
  it('rejects relocation cycles and foreign destination identities', async () => {
    const original = await pathFor(cwd); const actual = await pathFor(worktree)
    await writeFile(original, user(1) + moved(worktree))
    await writeFile(actual, user(1) + moved(cwd))
    await expect(resolveClaudeTranscriptPath(cwd, ID)).rejects.toThrow(/cycle/i)
    await writeFile(actual, user(2, 'foreign-session'))
    await expect(resolveClaudeTranscriptPath(cwd, ID)).rejects.toThrow(/identity/i)
  })

  it('rejects unsafe session ids before resolving a filesystem path', async () => {
    await expect(resolveClaudeTranscriptPath(cwd, '../outside')).rejects.toThrow(/session id/i)
  })
})
describe('live Claude transcript relocation', () => {
  it.each(['rename', 'copy'] as const)('continues its cursor after %s and return to the original cwd', async mode => {
    const original = await pathFor(cwd); const actual = await pathFor(worktree)
    await writeFile(original, user(1)); const { headless, seen } = session()
    await headless.start(); expect(seen).toEqual([1])
    await appendFile(original, moved(worktree))
    if (mode === 'rename') await rename(original, actual)
    else await copyFile(original, actual)
    // More intervening records than the bootstrap window: replaying only the
    // last 120 records would lose work, while replaying the whole copy doubles it.
    await appendFile(actual, Array.from({ length: 350 }, (_, i) => user(i + 2)).join(''))
    await waitFor(() => seen.includes(351))
    expect(seen).toEqual(Array.from({ length: 351 }, (_, i) => i + 1))
    await appendFile(actual, moved(cwd))
    if (mode === 'rename') await rename(actual, original)
    else { await copyFile(actual, original); await rm(actual) }
    await appendFile(original, user(352)); await waitFor(() => seen.includes(352))
    expect(seen).toEqual(Array.from({ length: 352 }, (_, i) => i + 1))
    await headless.stop(); await appendFile(original, user(353))
    await new Promise(resolve => setTimeout(resolve, 150)); expect(seen).not.toContain(353)
  })
  it('follows a short redirect stub replacing the original file', async () => {
    const original = await pathFor(cwd); const actual = await pathFor(worktree)
    await writeFile(original, Array.from({ length: 10 }, (_, n) => user(n)).join(''))
    const { headless, seen } = session(); await headless.start()
    await rename(original, actual)
    await writeFile(original, moved(worktree))
    await appendFile(actual, user(10))
    await waitFor(() => seen.includes(10))
    expect(seen).toEqual(Array.from({ length: 11 }, (_, n) => n))
  })

  it('recovers when a redirect destination appears after the first failed lookup', async () => {
    const original = await pathFor(cwd); const actual = await pathFor(worktree)
    await writeFile(original, user(1)); const { headless, seen, errors } = session()
    await headless.start()
    await appendFile(original, moved(worktree))
    await waitFor(() => errors.some(error => /relocation.*unavailable/i.test(error)))
    await copyFile(original, actual)
    await appendFile(actual, user(2))
    await waitFor(() => seen.includes(2))
    expect(seen).toEqual([1, 2])
  })

  it('preserves an incomplete UTF-8 record across a move', async () => {
    const original = await pathFor(cwd); const actual = await pathFor(worktree)
    await writeFile(original, user(1)); const { headless, seen } = session()
    await headless.start()
    const line = Buffer.from(user(2).replace('prompt 2', 'prompt 🌳'))
    const split = line.indexOf(Buffer.from('🌳')) + 2
    let sawRelocation = false
    headless.on('jsonl-entry', entry => { if (entry.type === 'relocated') sawRelocation = true })
    await appendFile(original, Buffer.concat([Buffer.from(moved(worktree)), line.subarray(0, split)]))
    // Wait for the durable relocation marker: its callback proves that the
    // same read consumed the partial record into the reader's pending buffer.
    await waitFor(() => sawRelocation)
    await rename(original, actual)
    await appendFile(actual, line.subarray(split))
    await waitFor(() => seen.includes(2))
    expect(seen).toEqual([1, 2])
  })

  it('refuses divergent history instead of reusing a cursor in different bytes', async () => {
    const original = await pathFor(cwd); const actual = await pathFor(worktree)
    await writeFile(original, user(1)); const { headless, seen, errors } = session()
    await headless.start(); await writeFile(actual, user(999) + user(1000))
    await appendFile(original, moved(worktree))
    await waitFor(() => errors.some(error => /diverg/i.test(error)))
    expect(seen).toEqual([1])
  })
})
