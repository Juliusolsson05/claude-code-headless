import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EventsFileTail, rotatedEventsPath } from './eventsFileTail.js'

// agent-code #1273 (residual after #62): a live Claude session's
// proxy-events.jsonl kept growing for the life of the session, and a live run
// is never pruned. The addon now rotates the file; because the file is the
// TRANSPORT from mitmdump to the adapter, the tail must follow each rotation
// without losing or repeating an event.
//
// These tests drive the REAL addon (mitmAddon.py, through its real `request`,
// `responseheaders` and stream-tap hooks) and the REAL tail against a temp
// file. Only mitmproxy's import is stubbed; nothing about the file protocol is.

const ADDON = resolve(__dirname, 'mitmAddon.py')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): { root: string; events: string } {
  const root = mkdtempSync(join(tmpdir(), 'mitm-rotate-'))
  roots.push(root)
  const pkg = join(root, 'mitmproxy')
  mkdirSync(pkg)
  writeFileSync(join(pkg, '__init__.py'), '')
  writeFileSync(join(pkg, 'http.py'), 'class HTTPFlow:\n    pass\n')
  return { root, events: join(root, 'proxy-events.jsonl') }
}

/**
 * One streamed /v1/messages turn through the real hooks: a request line, then
 * one `response-chunk` per sequence number, then `response-end`. Each chunk
 * carries its sequence number so the test can prove exactly-once, in-order.
 */
function streamTurn(ws: { root: string; events: string }, seqs: number[], rotateBytes: number | null): void {
  const script = `
import importlib.util, json
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
    content = json.dumps({"model": "claude-test", "system": "synthetic", "messages": [{"role": "user", "content": "hi"}], "tools": []}).encode("utf-8")
    def __init__(self):
        self.headers = Headers()

class Response:
    status_code = 200
    stream = None
    def __init__(self):
        self.headers = Headers({"content-type": "text/event-stream"})

class Flow:
    def __init__(self):
        self.request = Request()
        self.response = Response()

flow = Flow()
addon.request(flow)
addon.responseheaders(flow)
for seq in ${JSON.stringify(seqs)}:
    flow.response.stream(('data: {"seq": %d}\\n\\n' % seq).encode("utf-8"))
flow.response.stream(b"")
`
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: ws.root, PROXY_EVENTS_FILE: ws.events }
  delete env.PROXY_EVENTS_ROTATE_BYTES
  if (rotateBytes !== null) env.PROXY_EVENTS_ROTATE_BYTES = String(rotateBytes)
  execFileSync('python3', ['-c', script], { env })
}

function chunkSeqs(lines: string[]): number[] {
  return lines
    .map(line => JSON.parse(line) as { kind: string; chunk_b64?: string })
    .filter(event => event.kind === 'response-chunk')
    .map(event => (JSON.parse(Buffer.from(event.chunk_b64!, 'base64').toString('utf8').replace(/^data: /, '')) as { seq: number }).seq)
}

// A request line is ~1.2 KB (its body is under the per-file budget) and a chunk
// line ~250 B. 4 KB therefore rotates roughly every other turn, and never twice
// within one turn — the tail's documented limit is one rotation per poll.
const ROTATE = 4096

describe('rotating events file (#1273)', () => {
  it('bounds the live file and keeps exactly one previous generation', () => {
    const ws = workspace()
    let largest = 0
    for (let turn = 0; turn < 12; turn += 1) {
      streamTurn(ws, [turn * 3, turn * 3 + 1, turn * 3 + 2], ROTATE)
      if (existsSync(ws.events)) largest = Math.max(largest, statSync(ws.events).size)
    }
    // Rotation happens after the line that crosses the threshold, so the live
    // file never ends a write at or past it.
    expect(largest).toBeLessThan(ROTATE)
    expect(existsSync(rotatedEventsPath(ws.events))).toBe(true)
    expect(statSync(rotatedEventsPath(ws.events)).size).toBeGreaterThanOrEqual(ROTATE)
    expect(existsSync(ws.events.replace('.jsonl', '.2.jsonl'))).toBe(false)
  })

  it('delivers every event exactly once, in order, across rotations', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    const seen: string[] = []
    for (let turn = 0; turn < 12; turn += 1) {
      streamTurn(ws, [turn * 3, turn * 3 + 1, turn * 3 + 2], ROTATE)
      seen.push(...(await tail.poll()))
    }
    seen.push(...(await tail.poll()))
    expect(chunkSeqs(seen)).toEqual(Array.from({ length: 36 }, (_, index) => index))
    const kinds = seen.map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds.filter(kind => kind === 'request')).toHaveLength(12)
    expect(kinds.filter(kind => kind === 'response-end')).toHaveLength(12)
  })

  // The loss the tail exists to prevent: lines appended to the old file AFTER
  // the last poll but BEFORE the rename. Without draining the rotated
  // generation they are never read.
  it('drains lines written between the last poll and the rename', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"a"}\n')
    expect(await tail.poll()).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, '{"kind":"b"}\n')
    renameSync(ws.events, rotatedEventsPath(ws.events))
    // The rename is observed before the addon writes its next line.
    expect(await tail.poll()).toEqual([])
    appendFileSync(ws.events, '{"kind":"c"}\n')
    expect(await tail.poll()).toEqual(['{"kind":"b"}', '{"kind":"c"}'])
    expect(await tail.poll()).toEqual([])
  })

  it('drains the old generation when the rename and the next line land in one poll interval', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"a"}\n{"kind":"partial"')
    expect(await tail.poll()).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, '}\n')
    renameSync(ws.events, rotatedEventsPath(ws.events))
    appendFileSync(ws.events, '{"kind":"c"}\n{"kind":"d"}\n')
    // The partial that was mid-write at the previous poll is completed in the
    // old generation and delivered, before the new file's lines.
    expect(await tail.poll()).toEqual(['{"kind":"partial"}', '{"kind":"c"}', '{"kind":"d"}'])
  })

  // The documented limit: two rotations between polls. The tracked generation
  // is gone (deleted by the second rename), and the file now at `.1` is a
  // DIFFERENT generation that our saved offset does not describe. Reading it
  // from that offset would emit a mid-line fragment as an event; the tail must
  // skip it and restart cleanly on the live file. (The addon cannot rotate
  // twice in one 200 ms poll at 512 MiB; this pins the failure mode anyway.)
  it('never reads a different generation from a stale offset after two rotations', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"first-generation"}\n')
    expect(await tail.poll()).toEqual(['{"kind":"first-generation"}'])
    renameSync(ws.events, rotatedEventsPath(ws.events))
    appendFileSync(ws.events, '{"kind":"second","pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n')
    renameSync(ws.events, rotatedEventsPath(ws.events))
    appendFileSync(ws.events, '{"kind":"third"}\n')
    const lines = await tail.poll()
    expect(lines).toEqual(['{"kind":"third"}'])
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('keeps an incomplete trailing line for the next poll', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"a"}\n{"ki')
    expect(await tail.poll()).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, 'nd":"b"}\n')
    expect(await tail.poll()).toEqual(['{"kind":"b"}'])
  })

  // The stream tap writes from inside mitmproxy's streaming callback; an
  // exception there would break the live response, not just the log. A failed
  // rename (here: the rotated path is a non-empty directory) must leave every
  // event written and the turn intact.
  it('keeps streaming when the rename fails', async () => {
    const ws = workspace()
    mkdirSync(rotatedEventsPath(ws.events))
    writeFileSync(join(rotatedEventsPath(ws.events), 'occupied'), '')
    const tail = new EventsFileTail(ws.events)
    const seen: string[] = []
    for (let turn = 0; turn < 4; turn += 1) {
      streamTurn(ws, [turn * 3, turn * 3 + 1, turn * 3 + 2], ROTATE)
      seen.push(...(await tail.poll()))
    }
    expect(chunkSeqs(seen)).toEqual(Array.from({ length: 12 }, (_, index) => index))
    expect(statSync(ws.events).size).toBeGreaterThanOrEqual(ROTATE)
  })

  it('names the previous generation the way the addon does', () => {
    expect(rotatedEventsPath('/run/proxy-events.jsonl')).toBe('/run/proxy-events.1.jsonl')
  })
})
