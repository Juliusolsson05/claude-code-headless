import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createLiveClaudeCwd, sanitizeClaudeProjectPath } from './claudeLiveResidue.js'

// Never the real Claude home: a throwaway config dir and package root.
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }

describe('live Claude cwd (#1329)', () => {
  it('lives under the package checkout and removes exactly its own transcript directory and cwd', () => {
    const packageRoot = temp('cch-pkg-')
    const configHome = temp('cch-config-')
    const live = createLiveClaudeCwd({ packageRoot, configHome })
    expect(live.cwd).toContain(`${join('.live-cwd', 'composer-')}`)

    // What a real run leaves: its own transcript dir, plus an unrelated one
    // that must survive (another session of the developer's).
    const own = join(configHome, 'projects', sanitizeClaudeProjectPath(live.cwd))
    const unrelated = join(configHome, 'projects', '-Users-someone-project')
    for (const dir of [own, unrelated]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.jsonl'), '{}\n')
    }
    writeFileSync(join(live.cwd, 'scratch.txt'), 'x')

    expect(live.cleanup()).toEqual([])
    expect(existsSync(own)).toBe(false)
    expect(existsSync(live.cwd)).toBe(false)
    expect(existsSync(join(unrelated, 'session.jsonl'))).toBe(true)
  })

  it('removes nothing it cannot name exactly when the sanitized path would be hashed', () => {
    const packageRoot = join(temp('cch-pkg-'), 'x'.repeat(190))
    mkdirSync(packageRoot, { recursive: true })
    const configHome = temp('cch-config-')
    const live = createLiveClaudeCwd({ packageRoot, configHome })
    const prefixDir = join(configHome, 'projects', sanitizeClaudeProjectPath(live.cwd).slice(0, 200))
    mkdirSync(prefixDir, { recursive: true })

    const residue = live.cleanup()
    expect(residue).toHaveLength(1)
    expect(residue[0]).toMatch(/not removed/)
    expect(existsSync(prefixDir)).toBe(true)
    expect(existsSync(live.cwd)).toBe(false)
  })

  // Review of #68 (a), P1: a relative CLAUDE_CONFIG_DIR was resolved against
  // the test RUNNER's cwd, but Claude resolves it against its own (the live
  // cwd), so cleanup aimed at a directory Claude never used.
  it('resolves a relative config home against the live cwd, never the runner cwd', () => {
    const packageRoot = temp('cch-pkg-')
    const relative = `rel-config-${process.pid}-${Date.now()}`
    const live = createLiveClaudeCwd({ packageRoot, configHome: relative })
    const name = sanitizeClaudeProjectPath(live.cwd)
    const decoy = resolve(process.cwd(), relative, 'projects', name)
    const claudes = join(live.cwd, relative, 'projects', name)
    try {
      mkdirSync(decoy, { recursive: true })
      writeFileSync(join(decoy, 'keep.txt'), 'not ours')
      mkdirSync(claudes, { recursive: true })
      expect(live.cleanup()).toEqual([])
      expect(existsSync(join(decoy, 'keep.txt'))).toBe(true)
      expect(existsSync(claudes)).toBe(false)
    } finally {
      rmSync(resolve(process.cwd(), relative), { recursive: true, force: true })
    }
  })

  // Review of #68 (a), P1: a lexical containment check cannot see through a
  // symlinked `projects`, and rmSync follows it. A link on the path is left
  // alone and reported.
  it('never deletes through a symlinked projects directory', () => {
    const packageRoot = temp('cch-pkg-')
    const configHome = temp('cch-config-')
    const elsewhere = temp('cch-elsewhere-')
    symlinkSync(elsewhere, join(configHome, 'projects'))
    const live = createLiveClaudeCwd({ packageRoot, configHome })
    const sentinel = join(elsewhere, sanitizeClaudeProjectPath(live.cwd))
    mkdirSync(sentinel)
    writeFileSync(join(sentinel, 'keep.txt'), 'not ours to delete')

    const residue = live.cleanup()
    expect(residue).toHaveLength(1)
    expect(residue[0]).toMatch(/symlink/)
    expect(existsSync(join(sentinel, 'keep.txt'))).toBe(true)
    expect(existsSync(live.cwd)).toBe(false)
  })
})
