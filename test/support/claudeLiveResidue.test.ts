import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
