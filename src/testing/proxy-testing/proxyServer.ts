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
        // ignore_hosts makes mitmproxy a raw TCP tunnel for every
        // host that DOESN'T match api.anthropic.com. We set
        // HTTPS_PROXY on the spawned Claude process so our proxy
        // can tap the SSE stream from the Anthropic API — but that
        // env var also applies to every child the agent spawns
        // (bash tool calls, git, curl, npm, brew, …). Without this
        // flag the proxy MITM-terminates those connections too,
        // presents a cert signed by the mitmproxy CA, and the
        // caller's trust store rejects it — visible as "SSL cert
        // verify failed" when the agent tries to `git push`, etc.
        //
        // Negative-lookahead regex: match (and therefore PASS
        // THROUGH) any host that is not api.anthropic.com at the
        // start of the string followed by end-of-string or colon.
        // The ($|:) anchor rejects spoofed subdomains like
        // api.anthropic.com.evil.com — that form does NOT pass
        // through and stays under MITM, which is what we want
        // because we'd rather fail noisily than trust an
        // impostor.
        '--set',
        String.raw`ignore_hosts=^(?!api\.anthropic\.com($|:)).*`,
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
      this.emit('stderr', chunk.toString('utf8'))
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
        await sleep(200)
      }
    }
    throw new Error(`Timed out waiting for mitmproxy CA at ${this.info.caCertPath}`)
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
  const confDir = join(workDir, 'mitmproxy-conf')
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

  const candidates = [
    join(baseDir ?? process.cwd(), '.proxy-testing', 'venv', 'bin', 'mitmdump'),
    join(process.cwd(), '.proxy-testing', 'venv', 'bin', 'mitmdump'),
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
