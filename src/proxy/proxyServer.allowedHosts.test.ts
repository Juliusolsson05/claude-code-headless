import { describe, expect, it } from 'vitest'

// RED-TEST CONTRACT for configurable proxy host gating.
//
// The audit found the mitm proxy hardcodes api.anthropic.com in its
// allow_hosts (proxyServer.ts), so non-first-party endpoints (LiteLLM
// shims, OpenRouter) are tunneled as raw TCP — zero SSE events, zero
// thinking, for anyone routing Claude Code through a custom provider.
//
// New contract:
//   createProxyServer options gain `allowedHosts?: string[]`
//   (mitm allow_hosts regex fragments). Default stays
//   ['^api\\.anthropic\\.com(:443)?$'] so existing callers are unchanged.
//   The argv construction is exposed as a pure exported builder:
//
//   export function buildMitmdumpArgs(options: {
//     addonPath: string
//     allowedHosts?: string[]
//   }): string[]
//
// The mitmAddon host gate reads the same hosts (wired via the mitmdump
// argv / addon env by the implementer); this file pins the argv side.

describe('mitmdump argv construction (allowedHosts)', () => {
  it('exposes a pure buildMitmdumpArgs builder', async () => {
    const mod = (await import('./proxyServer.js')) as Record<string, unknown>
    expect(typeof mod.buildMitmdumpArgs).toBe('function')
  })

  it('default argv keeps the first-party allowlist', async () => {
    const { buildMitmdumpArgs } = (await import('./proxyServer.js')) as {
      buildMitmdumpArgs: (o: { addonPath: string; allowedHosts?: string[] }) => string[]
    }
    const argv = buildMitmdumpArgs({ addonPath: '/tmp/addon.py' })
    const allowIndex = argv.findIndex(a => a.startsWith('allow_hosts='))
    expect(allowIndex).toBeGreaterThan(-1)
    expect(argv[allowIndex]).toBe(String.raw`allow_hosts=^api\.anthropic\.com(:443)?$`)
    expect(argv).toContain('/tmp/addon.py')
  })

  it('custom allowedHosts land in allow_hosts verbatim', async () => {
    const { buildMitmdumpArgs } = (await import('./proxyServer.js')) as {
      buildMitmdumpArgs: (o: { addonPath: string; allowedHosts?: string[] }) => string[]
    }
    const argv = buildMitmdumpArgs({
      addonPath: '/tmp/addon.py',
      allowedHosts: [String.raw`^api\.anthropic\.com(:443)?$`, String.raw`^localhost:4010$`],
    })
    const allowIndex = argv.findIndex(a => a.startsWith('allow_hosts='))
    expect(allowIndex).toBeGreaterThan(-1)
    // WHY comma-joined: mitmproxy's allow_hosts accepts a comma-separated
    // list in a single --set value. Both patterns must survive verbatim.
    expect(argv[allowIndex]).toBe(String.raw`allow_hosts=^api\.anthropic\.com(:443)?$,^localhost:4010$`)
  })
})
