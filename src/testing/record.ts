#!/usr/bin/env tsx
/**
 * testing/record.ts — capture a Claude Code session for offline analysis.
 *
 * Spawns `claude` in a PTY, attaches ClaudeCodeHeadless to it, bridges
 * stdin/stdout for interactive use, and records every event to disk.
 *
 * Usage:
 *   npx tsx src/testing/record.ts                       # interactive
 *   CLAUDE_HEADLESS_SCRIPT=src/testing/scripts/hello.json \ # scripted
 *     npx tsx src/testing/record.ts
 *
 * Env vars:
 *   CLAUDE_HEADLESS_CWD            — override working directory
 *   CLAUDE_HEADLESS_BINARY         — override binary (default: `claude`)
 *   CLAUDE_HEADLESS_SCRIPT         — path to a JSON script for headless mode
 *   CLAUDE_HEADLESS_RESUME_FIXTURE — path to a JSONL fixture to resume from
 *
 * Outputs:
 *   recordings/<ts>/meta.json
 *   recordings/<ts>/raw.txt
 *   recordings/<ts>/raw.events.jsonl
 *   recordings/<ts>/snapshots.jsonl
 *   recordings/<ts>/jsonl.jsonl
 */

import { mkdir, readFile, writeFile, copyFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { spawn as ptySpawn } from 'node-pty'

import { ClaudeCodeHeadless } from '../ClaudeCodeHeadless.js'
import { getProjectDirForCwd } from '../transcript/ProjectDir.js'
import { TRUST_DIALOG_ACCEPT_KEYS } from '../parsers/TrustDialogParser.js'

// --- Script types ---

type ScriptStep =
  | { type: 'wait'; ms: number }
  | { type: 'send'; data: string }

type Script = {
  autoAcceptTrust?: boolean
  steps: ScriptStep[]
}

async function loadScript(path: string): Promise<Script> {
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text) as Script
  if (!Array.isArray(parsed.steps)) throw new Error(`script ${path} has no "steps" array`)
  return parsed
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function main(): Promise<void> {
  const scriptPath = process.env.CLAUDE_HEADLESS_SCRIPT
  const scripted = !!scriptPath
  const script: Script | null = scripted ? await loadScript(scriptPath!) : null
  const resumeFixture = process.env.CLAUDE_HEADLESS_RESUME_FIXTURE ?? null

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const recordingDir = join('recordings', ts)
  await mkdir(recordingDir, { recursive: true })

  // These recording scripts are developer tooling, not user data migration
  // code. After the compatibility-removal PR, accepting retired env names here
  // would keep a hidden behavior surface alive and make fixtures depend on
  // whatever aliases happen to be exported in the caller's shell.
  const cwd = process.env.CLAUDE_HEADLESS_CWD ?? process.cwd()
  const binary = process.env.CLAUDE_HEADLESS_BINARY ?? 'claude'
  const cols = process.stdout.columns ?? 120
  const rows = process.stdout.rows ?? 40

  // --- Resume fixture: stage into CC's projects dir ---
  let resumeSessionId: string | undefined
  if (resumeFixture) {
    const projectDir = await getProjectDirForCwd(cwd)
    await mkdir(projectDir, { recursive: true })
    resumeSessionId = randomUUID()
    const stagedPath = join(projectDir, `${resumeSessionId}.jsonl`)
    await copyFile(resumeFixture, stagedPath)
    process.stderr.write(`[record] staged fixture → ${stagedPath}\n`)
  }

  const meta = {
    startedAt: new Date().toISOString(),
    cwd, cols, rows, binary,
    mode: scripted ? 'scripted' : 'interactive',
    scriptPath: scriptPath ?? null,
    resumeFixture,
    resumeSessionId: resumeSessionId ?? null,
  }
  await writeFile(join(recordingDir, 'meta.json'), JSON.stringify(meta, null, 2))

  // Open append streams for recording.
  const rawStream = createWriteStream(join(recordingDir, 'raw.txt'), { flags: 'a' })
  const rawEventsStream = createWriteStream(join(recordingDir, 'raw.events.jsonl'), { flags: 'a' })
  const snapshotsStream = createWriteStream(join(recordingDir, 'snapshots.jsonl'), { flags: 'a' })
  const jsonlStream = createWriteStream(join(recordingDir, 'jsonl.jsonl'), { flags: 'a' })

  // --- Spawn the PTY ---
  const args: string[] = []
  if (resumeSessionId) args.push('--resume', resumeSessionId)

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'

  const pty = ptySpawn(binary, args, {
    name: 'xterm-256color',
    cols, rows, cwd, env,
  })

  // --- Attach ClaudeCodeHeadless ---
  const headless = new ClaudeCodeHeadless({
    pty, cwd, cols, rows,
    snapshotIntervalMs: 16,
    resumeSessionId,
  })

  // Record raw PTY data (via the terminal's pty-data event is internal,
  // but we can tap pty.onData directly since we own the PTY).
  pty.onData((data: string) => {
    if (!scripted) process.stdout.write(data)
    rawStream.write(data)
    rawEventsStream.write(JSON.stringify({ ts: Date.now(), data }) + '\n')
  })

  let lastSnapshot = ''
  let trustHandled = false

  headless.on('screen', snap => {
    if (snap.plain === lastSnapshot) return
    lastSnapshot = snap.plain
    snapshotsStream.write(JSON.stringify({ ts: Date.now(), text: snap.plain }) + '\n')
  })

  headless.on('jsonl-entry', (entry, file) => {
    jsonlStream.write(JSON.stringify({ ts: Date.now(), file, entry }) + '\n')
  })

  headless.on('trust-dialog', trust => {
    if (script?.autoAcceptTrust && !trustHandled) {
      trustHandled = true
      process.stderr.write(`[record] auto-accepting trust dialog for ${trust.workspace ?? '?'}\n`)
      headless.write(TRUST_DIALOG_ACCEPT_KEYS)
    }
  })

  headless.on('exit', ({ exitCode, signal }) => {
    process.stderr.write(`\n[record] CC exited (code=${exitCode}, signal=${signal ?? '-'})\n`)
    void shutdown(exitCode ?? 0)
  })

  // Interactive mode: bridge stdin
  if (!scripted) {
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', chunk => {
      if (chunk.length === 1 && chunk[0] === 0x11) {
        process.stderr.write('\n[record] Ctrl-Q — stopping\n')
        void shutdown(0)
        return
      }
      headless.write(chunk.toString('utf8'))
    })
    process.stdout.on('resize', () => {
      headless.resize(process.stdout.columns ?? 120, process.stdout.rows ?? 40)
    })
  }

  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    try { pty.kill() } catch { /* already gone */ }
    await headless.stop()
    rawStream.end()
    rawEventsStream.end()
    snapshotsStream.end()
    jsonlStream.end()
    process.stderr.write(`[record] saved to ${recordingDir}\n`)
    process.exit(code)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  const { projectDir } = await headless.start()
  process.stderr.write(
    `[record] tailing JSONL at ${projectDir}\n[record] writing to ${recordingDir}\n\n`,
  )

  if (scripted && script) {
    process.stderr.write(`[record] running ${script.steps.length} steps\n`)
    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i]
      if (step.type === 'wait') {
        process.stderr.write(`[record] step ${i + 1}: wait ${step.ms}ms\n`)
        await sleep(step.ms)
      } else {
        const preview = step.data.replace(/[\r\n]/g, '⏎').slice(0, 60)
        process.stderr.write(`[record] step ${i + 1}: send ${preview}\n`)
        headless.write(step.data)
      }
    }
    process.stderr.write('[record] script complete\n')
    await shutdown(0)
  }
}

main().catch(err => {
  console.error('[record] fatal:', err)
  process.exit(1)
})
