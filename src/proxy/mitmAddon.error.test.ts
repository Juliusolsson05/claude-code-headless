import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// The addon's `error` hook, exercised as PYTHON (review of this change: the
// TypeScript tests covered the adapter and nothing covered the hook itself).
//
// What must hold, and why it is worth running a subprocess for: this hook is
// the one that fires for flows which never reached `request()`, so it is the
// only place the addon can write about a host it does not proxy for. A probe
// captured `http://localhost:12345/upload?token=…` that way. Ignoring the
// line downstream cannot unwrite it, so the gate has to be here.

const ADDON = resolve(__dirname, 'mitmAddon.py')

/** A stub `mitmproxy` package, so the addon imports without the real one. */
function stubMitmproxy(root: string): void {
  const pkg = join(root, 'mitmproxy')
  execFileSync('mkdir', ['-p', pkg])
  writeFileSync(join(pkg, '__init__.py'), '')
  writeFileSync(join(pkg, 'http.py'), 'class HTTPFlow:\n    pass\n')
}

function runHook(host: string, port: number): Array<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'mitm-addon-'))
  stubMitmproxy(root)
  const out = join(root, 'events.jsonl')
  const script = `
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location("addon", ${JSON.stringify(ADDON)})
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

class Request:
    method = "POST"
    host = ${JSON.stringify(host)}
    port = ${port}
    path = "/upload?token=SYNTHETIC"
    pretty_url = "https://%s:%s/upload?token=SYNTHETIC" % (${JSON.stringify(host)}, ${port})

class Flow:
    request = Request()
    error = "Client disconnected."

addon.error(Flow())
`
  execFileSync('python3', ['-c', script], {
    env: { ...process.env, PYTHONPATH: root, PROXY_EVENTS_FILE: out },
  })
  if (!existsSync(out)) return []
  return readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('mitmAddon.error', () => {
  it('reports an allowed-host flow with its id and mitmproxy\'s message, and nothing else', () => {
    const [event, ...rest] = runHook('api.anthropic.com', 443)
    expect(rest).toHaveLength(0)
    expect(event).toMatchObject({ kind: 'response-error', error: 'Client disconnected.' })
    expect(typeof event?.flow_id).toBe('number')
    // The URL, path and host are deliberately absent: this hook fires for
    // flows that never reached `request()`, so anything it writes is capture
    // the addon has never recorded before.
    expect(Object.keys(event ?? {}).sort()).toEqual(['error', 'flow_id', 'kind'])
  })

  it('writes nothing at all for a host it does not proxy for', () => {
    expect(runHook('localhost', 12_345)).toEqual([])
  })
})
