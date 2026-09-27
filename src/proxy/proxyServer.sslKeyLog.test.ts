import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// agent-code#1380: mitmdump was always started with
// MITMPROXY_SSLKEYLOGFILE=<run dir>/sslkeylog.log. mitmproxy appends every TLS
// handshake's session secrets there (a recorded run: 48,777 bytes, 52
// handshakes), nothing rotated it, and debug retention skips a live run dir,
// so it grew for the life of every session, as plaintext secrets on disk.
// Nothing reads it. It is now written only on an explicit opt-in.

const spawned = vi.hoisted(() => ({ env: [] as Array<NodeJS.ProcessEnv | undefined> }))
vi.mock('child_process', async importOriginal => {
  const original = await importOriginal<typeof import('child_process')>()
  return {
    ...original,
    // Capture the env handed to mitmdump. The fake stays alive like a real
    // mitmdump (the test pre-creates the CA file start() waits for) and
    // exits when stop() kills it.
    spawn: (_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      spawned.env.push(options?.env)
      const child = new EventEmitter()
      Object.assign(child, {
        stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1, exitCode: null, signalCode: null,
        kill: () => { queueMicrotask(() => child.emit('exit', 0, null)); return true },
      })
      return child
    },
  }
})

const { buildMitmdumpEnv, createProxyServer } = await import('./proxyServer.js')

afterEach(() => {
  spawned.env.length = 0
  delete process.env.MITMPROXY_SSLKEYLOGFILE
})

describe('mitmdump TLS key log (agent-code#1380)', () => {
  it('writes no key log by default, and drops one inherited from the parent environment', () => {
    const env = buildMitmdumpEnv({ PATH: '/bin', MITMPROXY_SSLKEYLOGFILE: '/home/user/keys.log' }, { workDir: '/run', sslKeyLog: false })
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('writes the key log into the run directory only when asked', () => {
    const env = buildMitmdumpEnv({ PATH: '/bin', MITMPROXY_SSLKEYLOGFILE: '/home/user/keys.log' }, { workDir: '/run', sslKeyLog: true })
    expect(env).toEqual({ PATH: '/bin', MITMPROXY_SSLKEYLOGFILE: join('/run', 'sslkeylog.log') })
  })

  // The call site, not just the builder: what the spawned mitmdump actually got.
  it.each([
    ['default', undefined, undefined],
    ['opt-in', true, 'sslkeylog.log'],
  ] as const)('hands mitmdump the right environment (%s)', async (_name, sslKeyLog, expected) => {
    process.env.MITMPROXY_SSLKEYLOGFILE = '/home/user/keys.log'
    const runDir = mkdtempSync(join(tmpdir(), 'proxy-keylog-'))
    mkdirSync(join(runDir, 'conf'), { recursive: true })
    writeFileSync(join(runDir, 'conf', 'mitmproxy-ca-cert.pem'), 'test CA')
    const server = await createProxyServer({
      runDir, confDir: join(runDir, 'conf'), mitmDumpPath: '/bin/false', addonPath: '/tmp/addon.py',
      ...(sslKeyLog ? { sslKeyLog } : {}),
    })
    await server.start()
    await server.stop()
    expect(spawned.env.length).toBeGreaterThan(0)
    const keyLog = spawned.env[0]?.MITMPROXY_SSLKEYLOGFILE
    if (expected) expect(keyLog).toBe(join(server.info.workDir, expected))
    else expect(keyLog).toBeUndefined()
  })
})
