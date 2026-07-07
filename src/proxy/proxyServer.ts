import { EventEmitter } from 'events'
import { access, mkdir, open, stat, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { fileURLToPath } from 'url'

import { canonicalizePath, sanitizePath } from '../transcript/ProjectDir.js'
import type { ProxyTransportEvent } from './ClaudeProxyAdapter.js'

export type ProxyCapturedEvent = ProxyTransportEvent

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
  /** Host-owned root for generated proxy runtime folders.
   *
   *  WHY this is an option instead of a package constant:
   *    This package is intended to be embeddable outside any one app. The
   *    caller owns retention, disk quotas, backups, and "where does app
   *    state live on this OS?" decisions. The headless package only needs
   *    a writable root so it can produce logs and mitmproxy state. */
  storageRoot?: string
  /** Exact runtime directory. Useful for tests or callers that already
   *  allocated a per-session debug folder. */
  runDir?: string
  /** Exact mitmproxy confdir. Callers should use this when several proxy
   *  instances need to share one CA across sessions. */
  confDir?: string
  /** Exact JSONL file for captured proxy events. If omitted, a
   *  `proxy-events.jsonl` file is created inside the runtime directory. */
  eventsFile?: string
  /** Exact mitmdump executable path. */
  mitmDumpPath?: string
  /** Exact mitmproxy addon path. */
  addonPath?: string
  /** Human-facing project identity for app-owned storage layout. */
  cwd?: string
  /** Stable label such as a resumed conversation id or the shell
   *  session id. Used only for directory naming. */
  sessionKey?: string
}

const caBootstrapLocks = new Map<string, Promise<void>>()

async function canReadFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

async function withCaBootstrapLock(confDir: string, action: () => Promise<void>): Promise<void> {
  const prior = caBootstrapLocks.get(confDir) ?? Promise.resolve()
  const current = prior.catch(() => {
    // The lock protects future callers from overlapping startup; it must not
    // permanently poison the queue if an earlier mitmdump fails before writing
    // the CA. The caller that failed still receives its original error from
    // its own awaited promise, while the next caller gets a fresh attempt.
  }).then(action)

  // Store the same promise object we compare against in cleanup. A previous
  // shape used `current.finally(...)` for storage and `=== current` for the
  // identity check; those are two different Promise instances, so the entry
  // never matched and never got deleted — a slow leak of resolved promises
  // keyed by confDir. Now the map holds `current` directly and the .finally
  // is attached separately for the cleanup side-effect.
  caBootstrapLocks.set(confDir, current)
  current.finally(() => {
    if (caBootstrapLocks.get(confDir) === current) {
      caBootstrapLocks.delete(confDir)
    }
  })

  await current
}

export class ProxyServer extends EventEmitter {
  private child: ChildProcess | null = null
  private watcherTimer: ReturnType<typeof setInterval> | null = null
  // BYTE offset of consumed events-file content (see pollEventsOnce for
  // why bytes, not chars). Reset to 0 only if the file shrinks.
  private lastEventOffset = 0
  // In-flight guard for pollEventsOnce: setInterval re-fires regardless of
  // whether the previous async body finished, and overlapping polls were
  // half of the 2026-07-07 OOM (each overlap held a whole-file string
  // alive). Skipping a tick is always safe — the next tick reads from the
  // same offset.
  private pollInFlight = false
  private readonly stderrTail: string[] = []
  private childExitCode: number | null = null
  private childExitSignal: NodeJS.Signals | null = null

  constructor(readonly info: ProxyServerInfo) {
    super()
  }

  async start(): Promise<void> {
    try {
      const caAlreadyExists = await canReadFile(this.info.caCertPath)

      // WHY a missing shared CA is a single-process critical section:
      //
      // Agent Code restores several Claude panes at once from a single Node
      // main process — `createProxyServer` is invoked from `ClaudeSession` in
      // the Electron main, so every concurrent pane shares this module's
      // global state. If the shared mitmproxy confdir has just been deleted
      // as part of a debug-storage cleanup, every restored pane can start
      // `mitmdump` in the same second. mitmproxy lazily creates its CA on
      // startup, so concurrent first starts race through CA generation. The
      // losing shape is nasty: one live proxy can keep an in-memory CA/cert
      // pair while a different generated CA wins on disk. Claude then
      // receives NODE_EXTRA_CA_CERTS pointing at the disk winner, connects
      // through the live proxy using the in-memory loser, and reports:
      //   "SSL certificate verification failed. Check your proxy..."
      //
      // The serialization is therefore a module-scoped Promise queue, not a
      // filesystem lock — that's intentional because the race we observe is
      // intra-process. Multiple Agent Code app instances racing against the
      // same confdir is not a scenario this guard covers (and it would have
      // larger problems anyway, e.g. workspace.json contention). If the
      // headless package ever grows a multi-process spawner that targets the
      // same confdir, replace this with a real `mkdir`/`open('wx')`
      // filesystem lock and recheck the CA inside it.
      //
      // Serialising only the bootstrap case keeps normal proxy startup cheap
      // while making "delete the app proxy cache and restore many panes"
      // deterministic. Once the CA file exists, later proxies can safely start
      // in parallel because they all read the same persisted CA material.
      if (!caAlreadyExists) {
        await withCaBootstrapLock(this.info.confDir, () => this.startUnlocked())
        return
      }

      await this.startUnlocked()
    } catch (error) {
      await this.writeStartupError(error)
      throw error
    }
  }

  private async startUnlocked(): Promise<void> {
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

  private async writeStartupError(error: unknown): Promise<void> {
    // WHY write a sidecar file instead of relying on stderr:
    //
    // The production Electron app is usually launched via Finder/open, so the
    // main-process stderr stream is not something the user naturally has in a
    // terminal scrollback. The renderer only receives a normalized spawn error
    // and proxy event logs are not created when TLS fails before mitmproxy sees
    // an HTTP request. This file sits beside `session-meta.json`, giving the
    // app and future debugging agents a durable, per-session answer to "did the
    // proxy fail to start, and what did mitmdump say?" without dumping request
    // bodies or auth-bearing headers.
    await writeFile(
      join(this.info.workDir, 'startup-error.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
          mitmDumpPath: this.info.mitmDumpPath,
          addonPath: this.info.addonPath,
          confDir: this.info.confDir,
          caCertPath: this.info.caCertPath,
          stderrTail: this.stderrTail.join('').trim(),
          childExitCode: this.childExitCode,
          childExitSignal: this.childExitSignal,
        },
        null,
        2,
      ),
      'utf8',
    ).catch(() => {
      // Diagnostics must never mask the original startup failure.
    })
  }

  private startPollingEvents(): void {
    // The poll body is async; setInterval will happily fire again while a
    // previous body is still awaiting I/O, so the body itself carries an
    // in-flight guard (see pollEventsOnce). Do NOT inline the async work
    // here without that guard — overlap is exactly what OOMed us before.
    this.watcherTimer = setInterval(() => {
      void this.pollEventsOnce()
    }, 200)
  }

  // Incremental read of the mitm addon's events file.
  //
  // WHY incremental (open + read from lastEventOffset), never
  // readFile(whole file): this poller originally did
  // `readFile(eventsFile, 'utf8')` every 200ms and sliced off
  // `lastEventOffset` afterwards. The events file grows without bound over
  // a session (Claude API request/response bodies land here; a single
  // long-lived resume session reached 308 MB on 2026-07-07), so each poll
  // allocated a file-sized JS string. Strings that big go straight to V8's
  // large_object_space, which is only reclaimed by MAJOR GCs — so dead
  // copies piled up between major GCs (observed as a 300 MB → 2.4 GB → 300
  // MB heap sawtooth whose amplitude tracked the file size). And because
  // the old setInterval callback was async with no in-flight guard, once
  // the read latency exceeded the 200ms period several whole-file strings
  // were REACHABLE at once. The 2026-07-07 main-process OOM crashed with
  // heapUsed 2726 MB of which 2702 MB was large_object_space, and the
  // final last-resort mark-compacts freed nothing — that was N concurrent
  // 308 MB read results in flight. Reading only [lastEventOffset, size)
  // keeps each poll proportional to NEW bytes, exactly like the
  // FileTailer/SubAgentWatcher incremental-read fixes before it.
  //
  // OFFSET SEMANTICS: lastEventOffset is a BYTE offset now (it was a
  // JS-string char offset when we decoded the whole file). Byte slicing is
  // safe here because we only ever cut at `\n` boundaries — 0x0A never
  // appears inside a UTF-8 multibyte sequence — and in practice
  // mitmAddon.py writes `json.dumps(payload)` with the default
  // ensure_ascii=True, so the file is pure ASCII anyway.
  private async pollEventsOnce(): Promise<void> {
    if (this.pollInFlight) return
    this.pollInFlight = true
    try {
      const st = await stat(this.info.eventsFile).catch(() => null)
      if (!st) return
      if (st.size < this.lastEventOffset) {
        // File shrank (recreated/truncated). mitmdump only appends, so
        // this means a new file replaced the old one — restart from 0
        // rather than silently never reading again.
        this.lastEventOffset = 0
      }
      if (st.size === this.lastEventOffset) return

      const fh = await open(this.info.eventsFile, 'r')
      let buf: Buffer
      try {
        const toRead = st.size - this.lastEventOffset
        buf = Buffer.alloc(toRead)
        const { bytesRead } = await fh.read(buf, 0, toRead, this.lastEventOffset)
        buf = buf.subarray(0, bytesRead)
      } finally {
        await fh.close().catch(() => {})
      }

      // Only advance the offset past the LAST complete line we see.
      // Earlier versions advanced to end-of-read up-front, which
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
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl === -1) {
        // No complete line yet; leave offset untouched so we re-
        // read the partial next tick.
        return
      }
      const completeBlock = buf.subarray(0, lastNl).toString('utf8')
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
    } finally {
      this.pollInFlight = false
    }
  }
}

export async function createProxyServer(
  options?: string | CreateProxyServerOptions,
): Promise<ProxyServer> {
  const opts = typeof options === 'string' ? { baseDir: options } : (options ?? {})
  const workDir = await createWorkDir(opts)
  try {
    const confDir = await resolveConfDir(opts, workDir)
    await mkdir(confDir, { recursive: true })
    const mitmDumpPath = await resolveMitmDumpPath(opts)
    const addonPath = await resolveAddonPath(opts)
    const proxyPort = await getFreePort()
    const eventsFile = opts.eventsFile ? resolve(opts.eventsFile) : join(workDir, 'proxy-events.jsonl')
    await mkdir(dirname(eventsFile), { recursive: true })
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
  } catch (error) {
    // Same durability rationale as ProxyServer.writeStartupError: failures in
    // path discovery happen before a ProxyServer object exists, but they are
    // exactly the packaged-app failures users cannot inspect from stdout.
    await writeFile(
      join(workDir, 'startup-error.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
      'utf8',
    ).catch(() => {
      // Preserve the original error.
    })
    throw error
  }
}

async function resolveConfDir(
  options: CreateProxyServerOptions,
  workDir: string,
): Promise<string> {
  if (options.confDir) {
    return resolve(options.confDir)
  }
  if (options.baseDir) {
    return join(workDir, 'mitmproxy-conf')
  }
  if (options.storageRoot) {
    return join(resolve(options.storageRoot), '_shared-conf')
  }
  if (options.runDir || options.eventsFile) {
    return join(workDir, 'mitmproxy-conf')
  }
  // App sessions should share one stable mitmproxy CA/config.
  //
  // A fresh per-session confdir forces mitmproxy down the CA creation
  // path on every resume. That makes continuing sessions feel slow and
  // also turns any mitmdump startup hiccup into a "proxy startup
  // failed" timeout. Keep per-run logs in `workDir`, but reuse one
  // shared confdir for the CA material itself.
  // WHY tmpdir and not a branded app path:
  //   A library default must not claim a host application's storage namespace.
  //   Production embedders should pass `storageRoot`/`confDir`; this fallback
  //   keeps standalone tests usable without coupling the package to a host app.
  return join(defaultStorageRoot(), '_shared-conf')
}

async function resolveAddonPath(options: CreateProxyServerOptions): Promise<string> {
  if (options.addonPath) {
    return resolve(options.addonPath)
  }
  // WHY fileURLToPath and not `new URL(...).pathname`:
  //
  // Packaged Electron apps routinely live in paths with spaces, for example
  // `/Applications/Agent Code.app/...`. URL.pathname keeps those bytes escaped
  // as `%20`, so the old resolver looked for
  // `/Applications/Agent%20Code.app/.../mitmAddon.py` and failed even though
  // electron-builder had correctly unpacked the addon beside app.asar. This is
  // exactly the kind of packaged-only failure that makes dev mode look healthy
  // while Finder-launched builds cannot start Claude proxy. fileURLToPath is
  // Node's canonical conversion from module URL to real filesystem path.
  const here = dirname(fileURLToPath(import.meta.url))
  // mitmAddon.py is shipped beside this file (src/proxy/ in source,
  // dist/proxy/ after build — the package `build` script copies it
  // there). Candidate 1 is the path that fires in dev and in the
  // packaged app; the rest are defensive fallbacks for callers running
  // from an unexpected cwd.
  const candidates = [
    join(here, 'mitmAddon.py'),
    resolve(here, '../../src/proxy/mitmAddon.py'),
    resolve(here, '../../../../packages/claude-code-headless/src/proxy/mitmAddon.py'),
    resolve(process.cwd(), 'packages/claude-code-headless/src/proxy/mitmAddon.py'),
    resolve(process.cwd(), 'packages/claude-code-headless/dist/proxy/mitmAddon.py'),
    resolve(process.cwd(), 'claude-code-headless/src/proxy/mitmAddon.py'),
  ]
  for (const candidate of candidates) {
    const filesystemPath = unpackAsarPath(candidate)
    try {
      await access(filesystemPath, fsConstants.R_OK)
      return filesystemPath
    } catch {
      // try next
    }
  }
  throw new Error('Unable to locate mitmAddon.py')
}

function unpackAsarPath(path: string): string {
  return path.includes('.asar/')
    ? path.replace('.asar/', '.asar.unpacked/')
    : path
}

function sanitizeSegment(value: string): string {
  const sanitized = sanitizePath(value).replace(/-+/g, '-').replace(/^-|-$/g, '')
  return sanitized.length > 0 ? sanitized : 'unknown'
}

async function createWorkDir(options: CreateProxyServerOptions): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let root: string
  let dir: string

  if (options.runDir) {
    dir = resolve(options.runDir)
  } else if (options.eventsFile) {
    dir = dirname(resolve(options.eventsFile))
  } else if (options.baseDir) {
    root = resolve(options.baseDir)
    dir = join(root, timestamp)
  } else {
    // WHY default to hidden app state instead of cwd / tmp:
    //
    // The proxy runtime writes CA material, decrypted event logs, and other
    // debugging artifacts that are operationally useful but absolutely not
    // project files. Letting the caller's cwd become the storage root made
    // normal app usage spray timestamped folders into the user's repo. The
    // app-facing shape is therefore "caller passes a storage root"; the
    // package fallback is temp state so standalone harnesses work without
    // accidentally imposing one app's filesystem convention on every embedder:
    //   <storageRoot>/<sanitized-cwd>/<session-key>/<timestamp>/
    //
    // This mirrors the broader "session artifacts live in hidden state dirs"
    // convention used by Claude/Codex transcript storage, while keeping the
    // path readable enough to map back to the originating workspace +
    // session/conversation.
    root = resolve(options.storageRoot ?? defaultStorageRoot())
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

function defaultStorageRoot(): string {
  return join(tmpdir(), 'claude-code-headless', 'proxy')
}

async function resolveMitmDumpPath(options: CreateProxyServerOptions): Promise<string> {
  if (options.mitmDumpPath) {
    return resolve(options.mitmDumpPath)
  }
  const envPath = process.env.CLAUDE_HEADLESS_MITMDUMP ?? process.env.CC_PROXY_TEST_MITMDUMP
  if (envPath) return envPath

  // Candidate lookup order:
  //   1. explicit storage root/baseDir passed by the caller.
  //   2. `./.proxy-testing/venv/bin/mitmdump` under cwd — covers the
  //      case where this package is the process root (running the
  //      proxy harness directly via `npm run proxy-test-bootstrap`).
  //   3. `./packages/claude-code-headless/.proxy-testing/...` under
  //      cwd — monorepos that keep this package under packages/.
  //   4. `./claude-code-headless/.proxy-testing/...` under cwd — the
  //      older sibling checkout layout.
  //   5+. homebrew / /usr/local fallback.
  const callerRoot = options.baseDir ?? options.storageRoot
  const candidates = [
    join(callerRoot ?? process.cwd(), '.proxy-testing', 'venv', 'bin', 'mitmdump'),
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
    'Unable to find mitmdump. Run `npm run proxy-test-bootstrap` first or set CLAUDE_HEADLESS_MITMDUMP.',
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
