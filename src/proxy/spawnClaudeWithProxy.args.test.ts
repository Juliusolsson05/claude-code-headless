import { describe, expect, it } from 'vitest'

// RED-TEST CONTRACT for spawn argument/env control.
//
// The audit found spawnClaudeWithProxy passes an EMPTY argv to the claude
// binary with no way to add CLI flags — so SDK-driven sessions always run
// the interactive TUI in default permission mode (every Write/Edit/Bash
// prompts, and the SDK could not pre-approve anything). Harness owners also
// need to inject flags like --permission-mode or --model.
//
// New contract: a pure exported builder so argv/env assembly is testable
// without spawning a PTY:
//
//   export function buildSpawnPlan(options: SpawnClaudeWithProxyOptions): {
//     file: string
//     args: string[]
//     env: Record<string, string>
//   }
//
//   SpawnClaudeWithProxyOptions gains:
//     args?: string[]          — appended verbatim after the binary
//     env?: Record<string,string> — merged over the inherited environment
//                                   BEFORE the proxy vars (proxy vars win)

describe('spawn plan builder (args + env passthrough)', () => {
  it('exposes a pure buildSpawnPlan builder', async () => {
    const mod = (await import('./spawnClaudeWithProxy.js')) as Record<string, unknown>
    expect(typeof mod.buildSpawnPlan).toBe('function')
  })

  it('appends consumer args after the binary and keeps proxy env intact', async () => {
    const { buildSpawnPlan } = (await import('./spawnClaudeWithProxy.js')) as {
      buildSpawnPlan: (o: Record<string, unknown>) => { file: string; args: string[]; env: Record<string, string> }
    }
    const plan = buildSpawnPlan({
      cwd: '/tmp/work',
      proxyUrl: 'http://127.0.0.1:8080',
      caCertPath: '/tmp/ca.pem',
      args: ['--permission-mode', 'acceptEdits', '--model', 'opus'],
    })
    expect(plan.file).toBe('claude')
    expect(plan.args).toEqual(['--permission-mode', 'acceptEdits', '--model', 'opus'])
    expect(plan.env.HTTPS_PROXY).toBe('http://127.0.0.1:8080')
    expect(plan.env.NODE_EXTRA_CA_CERTS).toBe('/tmp/ca.pem')
  })

  it('merges consumer env under the proxy vars (proxy config wins)', async () => {
    const { buildSpawnPlan } = (await import('./spawnClaudeWithProxy.js')) as {
      buildSpawnPlan: (o: Record<string, unknown>) => { file: string; args: string[]; env: Record<string, string> }
    }
    const plan = buildSpawnPlan({
      cwd: '/tmp/work',
      proxyUrl: 'http://127.0.0.1:8080',
      caCertPath: '/tmp/ca.pem',
      env: { MY_TOOL_FLAG: '1', HTTPS_PROXY: 'http://consumer-override:9999' },
    })
    expect(plan.env.MY_TOOL_FLAG).toBe('1')
    // The proxy env is load-bearing for observation; a consumer override
    // must never silently kill the mitm tap.
    expect(plan.env.HTTPS_PROXY).toBe('http://127.0.0.1:8080')
  })

  it('default plan spawns the bare binary with no extra args (back-compat)', async () => {
    const { buildSpawnPlan } = (await import('./spawnClaudeWithProxy.js')) as {
      buildSpawnPlan: (o: Record<string, unknown>) => { file: string; args: string[]; env: Record<string, string> }
    }
    const plan = buildSpawnPlan({
      cwd: '/tmp/work',
      proxyUrl: 'http://127.0.0.1:8080',
      caCertPath: '/tmp/ca.pem',
    })
    expect(plan.args).toEqual([])
  })
})
