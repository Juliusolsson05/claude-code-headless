import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * A working directory for a live Claude run that leaves nothing behind in the
 * user's real Claude home except what they already have (#1329, split from
 * agent-code#1295).
 *
 * WHY inside the package checkout and not `os.tmpdir()`: Claude saves an
 * accepted folder trust under the cwd's GIT ROOT
 * (vendor/claude-code-src/full/utils/config.ts, getProjectPathForConfig). A
 * fresh `/T/composer-live-*` cwd has no git root, so every run wrote a new
 * `projects` entry for a throwaway path into the REAL `~/.claude.json`, where
 * it stayed forever. Inside the checkout Claude keys the entry by the
 * repository's shared git directory. Measured 2026-09-27 with two consecutive
 * live runs from a worktree of this package: the first added exactly one entry,
 * `<agent-code>/.git/modules/claude-code-headless`, which every checkout and
 * worktree of the package shares, and the second added none. The installed
 * Claude still showed the dialog under an already-trusted PARENT, so trust is
 * not inherited in practice, whatever the vendored source's parent walk
 * suggests; the gain is one shared entry, not zero. THIS code never writes
 * `~/.claude.json` (rewriting it races every running Claude session); the
 * Claude process the live test launches writes that one trust entry itself
 * when the test accepts the dialog (review of claude-code-headless#68, a).
 *
 * WHY the transcript directory is removed by exact name: Claude keys a
 * session's transcript directory by the sanitized ORIGINAL cwd
 * (sessionStoragePortable.ts, getProjectDir: every non-alphanumeric character
 * becomes `-`). The cwd carries a fresh UUID, so the directory name is unique
 * to this run and nothing else can match it. Past 200 sanitized characters
 * Claude appends a hash we cannot reproduce (Bun.hash), so the helper then
 * deletes nothing and says so, rather than guessing at a name.
 */
export const CLAUDE_SANITIZED_PATH_LIMIT = 200

export function sanitizeClaudeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

export type LiveClaudeCwd = {
  cwd: string
  /** Removes this run's transcript directory and the cwd; returns what it could not remove. */
  cleanup(): string[]
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export function createLiveClaudeCwd(options: { packageRoot: string; configHome?: string }): LiveClaudeCwd {
  const parent = join(options.packageRoot, '.live-cwd')
  mkdirSync(parent, { recursive: true })
  // realpath: Claude records process.cwd(), which the OS reports with symlinks
  // resolved (macOS /var → /private/var), so the name must be derived from it.
  const cwd = join(realpathSync(parent), `composer-${randomUUID()}`)
  mkdirSync(cwd)
  // Resolved against the CHILD's cwd, because that is where Claude resolves a
  // relative CLAUDE_CONFIG_DIR (review of #68, a: resolving it against the
  // test runner's cwd aimed the delete at a directory Claude never used). An
  // empty value is the same relative case; Claude's `??` keeps it.
  const configHome = options.configHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const projects = resolve(cwd, configHome, 'projects')
  return {
    cwd,
    cleanup() {
      const residue: string[] = []
      const sanitized = sanitizeClaudeProjectPath(cwd)
      const transcripts = join(projects, sanitized)
      if (sanitized.length > CLAUDE_SANITIZED_PATH_LIMIT) {
        residue.push(`${projects}/${sanitized.slice(0, 40)}… (name is hashed past ${CLAUDE_SANITIZED_PATH_LIMIT} characters; not removed)`)
      } else if (isSymlink(projects) || isSymlink(transcripts)) {
        // Never follow a symlink into a recursive delete (review of #68, a):
        // a lexical containment check cannot see where a linked `projects`
        // points, so a linked parent or target is left alone and reported.
        residue.push(`${transcripts} (a symlink is on the path; not removed)`)
      } else {
        rmSync(transcripts, { recursive: true, force: true })
        if (existsSync(transcripts)) residue.push(transcripts)
      }
      rmSync(cwd, { recursive: true, force: true })
      if (existsSync(cwd)) residue.push(cwd)
      return residue
    },
  }
}
