import { EventEmitter } from 'events'
import { access, mkdir, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { spawn, type ChildProcess } from 'child_process'

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
        const text = await import('fs/promises').then(fs =>
          fs.readFile(this.info.eventsFile, 'utf8').catch(() => ''),
        )
        if (!text) return
        const unread = text.slice(this.lastEventOffset)
        if (!unread) return
        this.lastEventOffset = text.length
        for (const line of unread.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            this.emit('event', JSON.parse(trimmed) as ProxyCapturedEvent)
          } catch {
            // ignore malformed partial lines
          }
        }
      } catch {
        // best-effort
      }
    }, 200)
  }
}

export async function createProxyServer(baseDir?: string): Promise<ProxyServer> {
  const workDir = await createWorkDir(baseDir)
  const confDir = join(workDir, 'mitmproxy-conf')
  await mkdir(confDir, { recursive: true })
  const mitmDumpPath = await resolveMitmDumpPath(baseDir)
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

async function createWorkDir(baseDir?: string): Promise<string> {
  const root = baseDir ?? join(tmpdir(), 'claude-code-headless-proxy-testing')
  const dir = join(root, new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(dir, { recursive: true })
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
