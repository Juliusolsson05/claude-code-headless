import { EventEmitter } from 'events'
import { access, mkdir, readFile, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { spawn, type ChildProcess } from 'child_process'

import { canonicalizePath, sanitizePath } from '../../transcript/ProjectDir.js'

export type ProxyCapturedEvent = Record<string, unknown>

export type ProxyServerInfo = {
  workDir: string
  confDir: string
  mitmDumpPath: string
  proxyPort: number
  proxyUrl: string
  addonPath: string
  eventsFile: string
  caCertPath: string
}

export type ProxyServerEvents = {
  event: [ProxyCapturedEvent]
  stderr: [string]
  stdout: [string]
}

export type CreateProxyServerOptions = {
  /** Explicit root for ad-hoc experiments. When set, createProxyServer
   *  behaves like the old implementation and writes under this path. */
  baseDir?: string
  /** Human-facing project identity for app-owned storage layout. */
  cwd?: string
  /** Stable label such as a resumed conversation id or the shell
   *  session id. Used only for directory naming. */
  sessionKey?: string
}

export class ProxyServer extends EventEmitter {
  private child: ChildProcess | null = null
  private watcherTimer: ReturnType<typeof setInterval> | null = null
  private lastEventOffset = 0
  private readonly stderrTail: string[] = []
  private childExitCode: number | null = null
  private childExitSignal: NodeJS.Signals | null = null

  constructor(readonly info: ProxyServerInfo) {
    super()
  }

  async start(): Promise<void> {
    const env = {
      ...process.env,
      MITMPROXY_SSLKEYLOGFILE: join(this.info.workDir, 'sslkeylog.log'),
      PROXY_EVENTS_FILE: this.info.eventsFile,
    }

    this.child = spawn(
      this.info.mitmDumpPath,
      [
        '--listen-host',
        '127.0.0.1',
        '--listen-port',
        String(this.info.proxyPort),
        '--set',
        `confdir=${this.info.confDir}`,
        // Scope MITM to api.anthropic.com only. Every other host
        // is passed through as a raw TCP tunnel.
        //
        // WHY this matters: the agent inherits HTTPS_PROXY through
        // its env, which cascades into every child process it
        // spawns (bash tool calls → git, curl, npm, brew, …).
        // Without scoping, those children hit our proxy, receive a
        // cert signed by the mitmproxy CA, and fail TLS validation
        // — the visible symptom is "SSL cert verify failed" on
        // `git push`.
        //
        // WHY allow_hosts and not ignore_hosts: a previous attempt
        // used ignore_hosts with a negative-lookahead regex
        // (^(?!api\.anthropic\.com($|:)).*). Python's standalone
        // re.search agreed with that regex, but mitmproxy 12.2.2
        // evidently parses the filter differently and tunneled
        // *every* host including api.anthropic.com — capture went
        // to zero flows. allow_hosts flips the polarity: we enumerate
        // the one host we DO want to MITM. Positive match, no
        // lookaheads, no parser edge cases.
        //
        // The (:443)? anchor keeps the match tight — both
        // "api.anthropic.com" and "api.anthropic.com:443" match,
        // but spoofed variants like "api.anthropic.com.evil.com"
        // do not.
        '--set',
        String.raw`allow_hosts=^api\.anthropic\.com(:443)?$`,
        '-s',
        this.info.addonPath,
      ],
      {
        cwd: this.info.workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    this.child.stdout?.on('data', chunk => {
      this.emit('stdout', chunk.toString('utf8'))
    })
    this.child.stderr?.on('data', chunk => {
      const text = chunk.toString('utf8')
      this.pushStderrTail(text)
      this.emit('stderr', text)
    })
    this.child.once('exit', (code, signal) => {
      this.childExitCode = code
      this.childExitSignal = signal
    })

    await this.waitForCa()
    this.startPollingEvents()
  }

  async stop(): Promise<void> {
    if (this.watcherTimer) {
      clearInterval(this.watcherTimer)
      this.watcherTimer = null
    }
    if (!this.child) return
    const child = this.child
    this.child = null
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // best-effort
        }
      }, 2000)
    })
  }

  private async waitForCa(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        await access(this.info.caCertPath, fsConstants.R_OK)
        return
      } catch {
        if (this.childExitCode !== null || this.childExitSignal !== null) {
          const exitSummary = this.childExitSignal
            ? `signal ${this.childExitSignal}`
            : `code ${this.childExitCode ?? 'unknown'}`
          const stderr = this.stderrTail.join('').trim()
          throw new Error(
            stderr.length > 0
              ? `mitmproxy exited before CA became ready (${exitSummary}): ${stderr}`
              : `mitmproxy exited before CA became ready (${exitSummary})`,
          )
        }
        await sleep(200)
      }
    }
    throw new Error(`Timed out waiting for mitmproxy CA at ${this.info.caCertPath}`)
  }

  private pushStderrTail(text: string): void {
    if (!text) return
    this.stderrTail.push(text)
    if (this.stderrTail.length > 20) {
      this.stderrTail.splice(0, this.stderrTail.length - 20)
    }
  }

  private startPollingEvents(): void {
    this.watcherTimer = setInterval(async () => {
      try {
        const text = await readFile(this.info.eventsFile, 'utf8').catch(() => '')
        if (!text || text.length <= this.lastEventOffset) return
        const unread = text.slice(this.lastEventOffset)

        // Only advance the offset past the LAST complete line we see.
        // Earlier versions advanced to `text.length` up-front, which
        // silently dropped any in-flight partial line when mitmdump's
        // write was mid-flush during the poll: the partial failed
        // JSON.parse, got swallowed by the catch, and the completed
        // line on the next poll was already past `lastEventOffset`.
        //
        // The newline-terminator invariant: mitmAddon.py writes
        // `json.dumps(payload) + "\n"` per event, so a correctly
        // flushed record always ends in `\n`. Anything after the
        // final `\n` in the buffer is a partial write-in-progress and
        // must be retried on the next tick.
        const lastNl = unread.lastIndexOf('\n')
        if (lastNl === -1) {
          // No complete line yet; leave offset untouched so we re-
          // read the partial next tick.
          return
        }
        const completeBlock = unread.slice(0, lastNl)
        this.lastEventOffset += lastNl + 1 // skip past the consumed \n

        for (const line of completeBlock.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            this.emit('event', JSON.parse(trimmed) as ProxyCapturedEvent)
          } catch {
            // A parse error on a line we've committed to (offset
            // already advanced past `\n`) means mitmdump wrote
            // garbage, not that the line was partial. Drop silently;
            // the line was terminated and we can't do anything with
            // it.
          }
        }
      } catch {
        // best-effort
      }
    }, 200)
  }
}

export async function createProxyServer(
  options?: string | CreateProxyServerOptions,
): Promise<ProxyServer> {
  const opts = typeof options === 'string' ? { baseDir: options } : (options ?? {})
  const workDir = await createWorkDir(opts)
  const confDir = await resolveConfDir(opts, workDir)
  await mkdir(confDir, { recursive: true })
  const mitmDumpPath = await resolveMitmDumpPath(opts.baseDir)
  const addonPath = await resolveAddonPath()
  const proxyPort = await getFreePort()
  const eventsFile = join(workDir, 'proxy-events.jsonl')
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const caCertPath = join(confDir, 'mitmproxy-ca-cert.pem')

  return new ProxyServer({
    workDir,
    confDir,
    mitmDumpPath,
    proxyPort,
    proxyUrl,
    addonPath,
    eventsFile,
    caCertPath,
  })
}

async function resolveConfDir(
  options: CreateProxyServerOptions,
  workDir: string,
): Promise<string> {
  if (options.baseDir) {
    return join(workDir, 'mitmproxy-conf')
  }
  // App sessions should share one stable mitmproxy CA/config.
  //
  // A fresh per-session confdir forces mitmproxy down the CA creation
  // path on every resume. That makes continuing sessions feel slow and
  // also turns any mitmdump startup hiccup into a "proxy startup
  // failed" timeout. Keep per-run logs in `workDir`, but reuse one
  // shared confdir for the CA material itself.
  return join(homedir(), '.config', 'cc-shell', 'proxy', '_shared-conf')
}

async function resolveAddonPath(): Promise<string> {
  const here = dirname(new URL(import.meta.url).pathname)
  const candidates = [
    join(here, 'mitmAddon.py'),
    resolve(here, '../../../src/testing/proxy-testing/mitmAddon.py'),
    resolve(process.cwd(), 'claude-code-headless/src/testing/proxy-testing/mitmAddon.py'),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK)
      return candidate
    } catch {
      // try next
    }
  }
  throw new Error('Unable to locate mitmAddon.py for proxy-testing')
}

function sanitizeSegment(value: string): string {
  const sanitized = sanitizePath(value).replace(/-+/g, '-').replace(/^-|-$/g, '')
  return sanitized.length > 0 ? sanitized : 'unknown'
}

async function createWorkDir(options: CreateProxyServerOptions): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let root: string
  let dir: string

  if (options.baseDir) {
    root = options.baseDir
    dir = join(root, timestamp)
  } else {
    // WHY default to hidden app state instead of cwd / tmp:
    //
    // The proxy runtime writes CA material, decrypted event logs, and other
    // debugging artifacts that are operationally useful but absolutely not
    // project files. Letting the caller's cwd become the storage root made
    // normal app usage spray timestamped folders into the user's repo. The
    // app-facing default is therefore a conventional hidden state location:
    //   ~/.config/cc-shell/proxy/<sanitized-cwd>/<session-key>/<timestamp>/
    //
    // This mirrors the broader "session artifacts live in hidden state dirs"
    // convention used by Claude/Codex transcript storage, while keeping the
    // path readable enough to map back to the originating workspace +
    // session/conversation.
    root = join(homedir(), '.config', 'cc-shell', 'proxy')
    const cwdSegment = options.cwd
      ? sanitizeSegment(await canonicalizePath(options.cwd))
      : 'unknown-project'
    const sessionSegment = options.sessionKey
      ? sanitizeSegment(options.sessionKey)
      : `run-${timestamp}`
    dir = join(root, cwdSegment, sessionSegment, timestamp)
  }
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'session-meta.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        cwd: options.cwd ?? null,
        sessionKey: options.sessionKey ?? null,
      },
      null,
      2,
    ),
    'utf8',
  ).catch(() => {
    // best-effort metadata only
  })
  return dir
}

async function resolveMitmDumpPath(baseDir?: string): Promise<string> {
  const envPath = process.env.CC_PROXY_TEST_MITMDUMP
  if (envPath) return envPath

  // Candidate lookup order:
  //   1. explicit `baseDir` passed by the caller (the canonical path
  //      when cc-shell is embedding this package).
  //   2. `./.proxy-testing/venv/bin/mitmdump` under cwd — covers the
  //      case where this package is the process root (running the
  //      proxy harness directly via `npm run proxy-test-bootstrap`).
  //   3. `./packages/claude-code-headless/.proxy-testing/...` under
  //      cwd — the cc-shell monorepo layout post tree-reshape
  //      (Phase 5 moved the submodule from the repo root into
  //      `packages/`). Keep this AHEAD of the pre-reshape candidate
  //      so cc-shell checkouts find the binary without re-running
  //      the bootstrap script.
  //   4. `./claude-code-headless/.proxy-testing/...` under cwd — the
  //      pre-reshape cc-shell layout. Kept for backwards compat with
  //      any older checkouts still on a branch that hasn't merged
  //      the monorepo reshape yet.
  //   5+. homebrew / /usr/local fallback.
  const candidates = [
    join(baseDir ?? process.cwd(), '.proxy-testing', 'venv', 'bin', 'mitmdump'),
    join(process.cwd(), '.proxy-testing', 'venv', 'bin', 'mitmdump'),
    join(process.cwd(), 'packages', 'claude-code-headless', '.proxy-testing', 'venv', 'bin', 'mitmdump'),
    join(process.cwd(), 'claude-code-headless', '.proxy-testing', 'venv', 'bin', 'mitmdump'),
    '/opt/homebrew/bin/mitmdump',
    '/usr/local/bin/mitmdump',
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // try next
    }
  }
  throw new Error(
    'Unable to find mitmdump. Run `npm run proxy-test-bootstrap` first or set CC_PROXY_TEST_MITMDUMP.',
  )
}

async function getFreePort(): Promise<number> {
  const net = await import('net')
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Failed to obtain ephemeral port'))
        return
      }
      const port = addr.port
      server.close(err => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
