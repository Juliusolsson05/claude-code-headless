import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// agent-code #1273: every Claude request re-sends the whole conversation, and
// the addon wrote each one's body (up to 2 MiB, base64) into
// proxy-events.jsonl. Measured on 2026-09-25: one live session's file reached
// 2.37 GB, with body_b64 at 92.9 % of the bytes of its last 300 MB, and the
// file cannot be pruned while the session is live. The body is forensic only
// (the adapter reads request_shape), so past a per-file budget it is omitted
// and the omission is marked.

const ADDON = resolve(__dirname, 'mitmAddon.py')

function stubMitmproxy(root: string): void {
  const pkg = join(root, 'mitmproxy')
  execFileSync('mkdir', ['-p', pkg])
  writeFileSync(join(pkg, '__init__.py'), '')
  writeFileSync(join(pkg, 'http.py'), 'class HTTPFlow:\n    pass\n')
}

/** Run the addon's `request` hook once, against an events file that already
 *  holds `existingBytes`, with an optional budget override. */
function runRequest(existingBytes: number | 'absent', budget?: number, content = 'hello'): Record<string, unknown> & { latest: Record<string, unknown> | null } {
  const root = mkdtempSync(join(tmpdir(), 'mitm-budget-'))
  stubMitmproxy(root)
  const out = join(root, 'events.jsonl')
  // Sparse: only the file's SIZE matters to the budget, so a 300 MB file
  // costs no disk and no time.
  const prefix = existingBytes === 'absent' ? 0 : existingBytes
  if (existingBytes !== 'absent') {
    writeFileSync(out, '')
    truncateSync(out, existingBytes)
  }
  // A minimal, synthetic /v1/messages body: no private content.
  const body = JSON.stringify({ model: 'claude-test', system: 'synthetic', messages: [{ role: 'user', content }], tools: [] })
  const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("addon", ${JSON.stringify(ADDON)})
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

class Headers(dict):
    pass

class Request:
    method = "POST"
    host = "api.anthropic.com"
    port = 443
    path = "/v1/messages"
    pretty_url = "https://api.anthropic.com/v1/messages"
    content = ${JSON.stringify(body)}.encode("utf-8")
    def __init__(self):
        self.headers = Headers()

class Flow:
    def __init__(self):
        self.request = Request()

addon.request(Flow())
`
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: root, PROXY_EVENTS_FILE: out }
  if (budget !== undefined) env.PROXY_REQUEST_BODY_BUDGET_BYTES = String(budget)
  execFileSync('python3', ['-c', script], { env })
  // Read only what the hook appended after the (sparse) prefix.
  const fd = openSync(out, 'r')
  try {
    const appended = Buffer.alloc(fstatSync(fd).size - prefix)
    readSync(fd, appended, 0, appended.length, prefix)
    const sidecar = join(root, 'latest-request-body.json')
    const latest = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown> : null
    return { ...(JSON.parse(appended.toString('utf8').trim()) as Record<string, unknown>), latest }
  } finally {
    closeSync(fd)
  }
}

describe('mitmAddon request body budget (#1273)', () => {
  it('keeps the body while the events file is under budget', () => {
    const event = runRequest(0)
    expect(typeof event.body_b64).toBe('string')
    expect(event.body_omitted).toBeUndefined()
    expect(event.request_shape).toBeDefined()
  })

  it('omits the body, and says so, once the events file is over budget', () => {
    const event = runRequest(4096, 1024)
    expect(event.body_b64).toBeUndefined()
    expect(event.body_omitted).toBe('file-budget')
    // The adapter's input and the flow's identity are still recorded.
    expect(event.request_shape).toBeDefined()
    expect(event.kind).toBe('request')
  })

  it('defaults to a budget that a normal session stays under and a runaway one does not', () => {
    expect(typeof runRequest(64 * 1024 * 1024).body_b64).toBe('string')
    expect(runRequest(300 * 1024 * 1024).body_omitted).toBe('file-budget')
  })

  // Review of #62 (B): with no events file yet, a budget of 0 still wrote the
  // first request's body.
  it('keeps no body at all under a zero budget, including the very first request', () => {
    const event = runRequest('absent', 0)
    expect(event.body_b64).toBeUndefined()
    expect(event.body_omitted).toBe('file-budget')
  })

  // Review of #62 (A, minor): pin the default and the exact boundary.
  it('omits from exactly 256 MiB, not before', () => {
    expect(typeof runRequest(256 * 1024 * 1024 - 1).body_b64).toBe('string')
    expect(runRequest(256 * 1024 * 1024).body_omitted).toBe('file-budget')
  })

  // Review of #62 (A, major): omitting bodies lost the RECENT prompts, the ones
  // a bug report is about. The newest body is kept alone in a sidecar; since a
  // Claude request carries the whole conversation, it recovers every prompt.
  it('keeps the newest omitted body, alone, in the sidecar', () => {
    const event = runRequest(4096, 1024, 'the latest prompt')
    expect(event.latest).toMatchObject({ kind: 'request-body-latest', flow_id: event.flow_id })
    const decoded = Buffer.from(String(event.latest?.body_b64), 'base64').toString('utf8')
    expect(decoded).toContain('the latest prompt')
    // Under budget nothing is written there: the body is in the log itself.
    expect(runRequest(0).latest).toBeNull()
  })
})
