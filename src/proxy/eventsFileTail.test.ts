import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// A hook into the tail's path-level fs calls, so a test can rotate the file at
// EXACTLY one await point of a poll (review of #64, steering q53). Handle-level
// calls (fh.stat / fh.read) are untouched: they are what must not care.
const fsHook = vi.hoisted(() => ({
  before: null as null | ((call: string, path: string) => void),
  /** When set, every FileHandle.read returns at most this many bytes (legal per the API). */
  maxReadBytes: null as null | number,
}))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const wrap = <F extends (...args: never[]) => unknown>(name: string, fn: F) =>
    ((...args: Parameters<F>) => {
      fsHook.before?.(name, String(args[0]))
      return fn(...args)
    }) as F
  const open = (async (...args: Parameters<typeof actual.open>) => {
    fsHook.before?.('open', String(args[0]))
    const handle = await actual.open(...args)
    const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => ReturnType<typeof handle.read>
    return Object.assign(Object.create(handle) as typeof handle, {
      read: (buffer: Buffer, offset: number, length: number, position: number) =>
        read(buffer, offset, fsHook.maxReadBytes === null ? length : Math.min(length, fsHook.maxReadBytes), position),
      stat: handle.stat.bind(handle),
      close: handle.close.bind(handle),
    })
  }) as typeof actual.open
  return { ...actual, open, stat: wrap('stat', actual.stat), readFile: wrap('readFile', actual.readFile) }
})

import { EventsFileTail, rotatedEventsPath } from './eventsFileTail.js'
import { ProxyServer, type ProxyServerInfo } from './proxyServer.js'

// agent-code #1273 (residual after #62): a live Claude session's
// proxy-events.jsonl kept growing for the life of the session, and a live run
// is never pruned. The addon now rotates the file; because the file is the
// TRANSPORT from mitmdump to the adapter, the tail must follow each rotation:
// every event exactly once and in order, or an explicit, counted gap.
//
// Most tests drive the REAL addon (mitmAddon.py, through its real `request`,
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
function streamTurn(ws: { root: string; events: string }, seqs: number[], rotateBytes: number | null, prelude = ''): void {
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

${prelude}
flow = Flow()
addon.request(flow)
addon.responseheaders(flow)
for seq in ${JSON.stringify(seqs)}:
    flow.response.stream(('data: {"seq": %d}\\n\\n' % seq).encode("utf-8"))
flow.response.stream(b"")
addon.response(flow)
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

// Measured (review of #64): one turn is ~1.44 KB (request 643 B, chunks ~210 B,
// end 167 B). 4 KB therefore rotates about every third turn.
const ROTATE = 4096

/** The generation a file's header line names (0 for a headerless first file). */
function generationOf(path: string): number {
  const first = readFileSync(path, 'utf8').split('\n')[0] ?? ''
  try {
    const parsed = JSON.parse(first) as { kind?: string; generation?: number }
    return parsed.kind === 'generation' && typeof parsed.generation === 'number' ? parsed.generation : 0
  } catch {
    return 0
  }
}

/** Rotate the way the addon does: rename, then create the next generation WITH its header. */
function rotateLikeAddon(events: string, newContent = ''): void {
  const next = generationOf(events) + 1
  renameSync(events, rotatedEventsPath(events))
  writeFileSync(events, `{"kind":"generation","generation":${next}}\n${newContent}`)
}

async function drain(tail: EventsFileTail): Promise<{ lines: string[]; lost: number }> {
  const lines: string[] = []
  let lost = 0
  for (let i = 0; i < 4; i += 1) {
    const poll = await tail.poll()
    lines.push(...poll.lines)
    lost += poll.lostGenerations
  }
  return { lines, lost }
}

describe('rotating events file (#1273)', () => {
  afterEach(() => { fsHook.before = null; fsHook.maxReadBytes = null })

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
    // The live file names its generation; several rotations happened.
    expect(generationOf(ws.events)).toBeGreaterThan(1)
    expect(generationOf(rotatedEventsPath(ws.events))).toBe(generationOf(ws.events) - 1)
  })

  it('rotates at 512 MiB when nothing overrides it', () => {
    const ws = workspace()
    const out = execFileSync('python3', ['-c', `
import importlib.util
spec = importlib.util.spec_from_file_location("addon", ${JSON.stringify(ADDON)})
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
print(addon._ROTATE_BYTES)
`], { env: { ...process.env, PYTHONPATH: ws.root, PROXY_EVENTS_FILE: ws.events, PROXY_EVENTS_ROTATE_BYTES: '' } }).toString().trim()
    expect(Number(out)).toBe(512 * 1024 * 1024)
  })

  it('leaves a live file holding only its generation header right after a rotation, so an idle run stays discoverable', () => {
    const ws = workspace()
    // A threshold below every line's size: each write rotates, including the
    // turn's last one (response-end), and nothing follows it.
    streamTurn(ws, [0], 100)
    expect(existsSync(rotatedEventsPath(ws.events))).toBe(true)
    const content = readFileSync(ws.events, 'utf8')
    expect(content.trim().split('\n')).toHaveLength(1)
    expect(generationOf(ws.events)).toBeGreaterThan(0)
  })

  it('delivers every event exactly once, in order, across rotations', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    const seen: string[] = []
    for (let turn = 0; turn < 12; turn += 1) {
      streamTurn(ws, [turn * 3, turn * 3 + 1, turn * 3 + 2], ROTATE)
      const poll = await tail.poll()
      expect(poll.lostGenerations).toBe(0)
      seen.push(...poll.lines)
    }
    seen.push(...(await drain(tail)).lines)
    expect(chunkSeqs(seen)).toEqual(Array.from({ length: 36 }, (_, index) => index))
    const kinds = seen.map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds.filter(kind => kind === 'request')).toHaveLength(12)
    expect(kinds.filter(kind => kind === 'response-end')).toHaveLength(12)
    // The completion hook's record (status + headers) arrives too.
    expect(kinds.filter(kind => kind === 'response')).toHaveLength(12)
    await tail.close()
  })

  // Steering q53: the first tail stat()ed the path and later open()ed it by
  // name; a rotation between the two read the new file with the old offset
  // (reviewers saw b,c,d arrive as d,c,d). Here one rotation lands before the
  // poll's first path-level fs call, and a SECOND one lands before each later
  // call in turn — every await point of the rotation-handling branch (counter
  // read, opening `.1`, reopening the live file). Every position must deliver
  // each line exactly once, in order, with no reported loss.
  it.each(Array.from({ length: 10 }, (_, k) => k + 2))('survives a second rotation just before path-level fs call %i', async k => {
    const ws = workspace()
    writeFileSync(ws.events, '{"kind":"a"}\n')
    const tail = new EventsFileTail(ws.events)
    expect((await tail.poll()).lines).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, '{"kind":"b"}\n')
    let calls = 0
    fsHook.before = (_call, path) => {
      if (!path.startsWith(ws.root)) return
      calls += 1
      if (calls === 1) rotateLikeAddon(ws.events, '{"kind":"c"}\n{"kind":"d"}\n')
      if (calls === k) rotateLikeAddon(ws.events, '{"kind":"e"}\n')
    }
    const { lines, lost } = await drain(tail)
    fsHook.before = null
    const all = ['b', 'c', 'd', 'e'].map(kind => `{"kind":"${kind}"}`)
    expect(lines).toEqual(calls >= k ? all : all.slice(0, 3))
    expect(lost).toBe(0)
    // Coverage guard: this path makes 5 path-level calls, so positions 2..5 each rotate mid-poll.
    expect(calls).toBeGreaterThanOrEqual(Math.min(k, 5))
    await tail.close()
  })

  it('drains lines written between the last poll and the rename', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"a"}\n')
    expect((await tail.poll()).lines).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, '{"kind":"b"}\n')
    rotateLikeAddon(ws.events)
    appendFileSync(ws.events, '{"kind":"c"}\n')
    expect((await drain(tail)).lines).toEqual(['{"kind":"b"}', '{"kind":"c"}'])
    await tail.close()
  })

  it('completes a line that was partial at the previous poll before moving on', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"a"}\n{"kind":"partial"')
    expect((await tail.poll()).lines).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, '}\n')
    rotateLikeAddon(ws.events, '{"kind":"c"}\n{"kind":"d"}\n')
    expect((await drain(tail)).lines).toEqual(['{"kind":"partial"}', '{"kind":"c"}', '{"kind":"d"}'])
    await tail.close()
  })

  // Two rotations while the poller was stalled: the generation the tail held is
  // deleted by the second rename, and the middle one was never opened. The held
  // handle keeps the first readable; the middle one is read from `.1`.
  it('loses nothing across two rotations between polls', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"first"}\n')
    expect((await tail.poll()).lines).toEqual(['{"kind":"first"}'])
    appendFileSync(ws.events, '{"kind":"first-unread"}\n')
    rotateLikeAddon(ws.events, '{"kind":"second"}\n')
    rotateLikeAddon(ws.events, '{"kind":"third"}\n')
    const { lines, lost } = await drain(tail)
    expect(lines).toEqual(['{"kind":"first-unread"}', '{"kind":"second"}', '{"kind":"third"}'])
    expect(lost).toBe(0)
    await tail.close()
  })

  // Beyond that, generations are deleted before anyone can read them. That is
  // reported, never passed off as exactly-once.
  it('reports generations deleted unread when the poller stalls through several rotations', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"held"}\n')
    expect((await tail.poll()).lines).toEqual(['{"kind":"held"}'])
    for (const name of ['g2', 'g3', 'g4', 'g5']) rotateLikeAddon(ws.events, `{"kind":"${name}"}\n`)
    const { lines, lost } = await drain(tail)
    // held (drained), g4 at .1, g5 live; g2 and g3 are gone.
    expect(lines).toEqual(['{"kind":"g4"}', '{"kind":"g5"}'])
    expect(lost).toBe(2)
    await tail.close()
  })

  it('reports the gap through the real addon too', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    streamTurn(ws, [0], null)
    expect(chunkSeqs((await tail.poll()).lines)).toEqual([0])
    // Every write now rotates after it lands: the request goes into the held
    // generation 0 (then rotates), the chunk into 1, the end into 2, the
    // response into 3; 4 is live (header only). 0 is finished from the held
    // handle and 3 is read from `.1`; 1 and 2 were deleted unread.
    streamTurn(ws, [1], 100)
    const { lines, lost } = await drain(tail)
    expect(lost).toBe(2)
    expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['request', 'response'])
    await tail.close()
  })

  it('keeps an incomplete trailing line for the next poll', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"a"}\n{"ki')
    expect((await tail.poll()).lines).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, 'nd":"b"}\n')
    expect((await tail.poll()).lines).toEqual(['{"kind":"b"}'])
    await tail.close()
  })

  it('restarts from 0 when the same file is truncated in place', async () => {
    const ws = workspace()
    const tail = new EventsFileTail(ws.events)
    appendFileSync(ws.events, '{"kind":"a-long-line-before-truncation"}\n')
    expect((await tail.poll()).lines).toHaveLength(1)
    truncateSync(ws.events, 0)
    appendFileSync(ws.events, '{"kind":"b"}\n')
    expect((await tail.poll()).lines).toEqual(['{"kind":"b"}'])
    await tail.close()
  })

  // Review of #64: a crashed addon left `{"kind":"crashed"` with no newline; the
  // restarted addon glued its next event onto it and both failed to parse.
  it('a restarted addon does not glue its first event onto a crashed partial line', async () => {
    const ws = workspace()
    writeFileSync(ws.events, '{"kind":"crashed"')
    const tail = new EventsFileTail(ws.events)
    streamTurn(ws, [7], null)
    const lines = (await drain(tail)).lines
    expect(chunkSeqs(lines.filter(line => line !== '{"kind":"crashed"'))).toEqual([7])
    await tail.close()
  })

  // The stream tap writes from inside mitmproxy's streaming callback; an
  // exception there breaks the user's live response, not just the log.
  it('keeps streaming when the rename fails', async () => {
    const ws = workspace()
    mkdirSync(rotatedEventsPath(ws.events))
    writeFileSync(join(rotatedEventsPath(ws.events), 'occupied'), '')
    const tail = new EventsFileTail(ws.events)
    const seen: string[] = []
    for (let turn = 0; turn < 4; turn += 1) {
      streamTurn(ws, [turn * 3, turn * 3 + 1, turn * 3 + 2], ROTATE)
      seen.push(...(await tail.poll()).lines)
    }
    expect(chunkSeqs(seen)).toEqual(Array.from({ length: 12 }, (_, index) => index))
    expect(statSync(ws.events).size).toBeGreaterThanOrEqual(ROTATE)
    await tail.close()
  })

  // If creating the next generation's live file fails right after the rename,
  // the next write must create it WITH its header, or the tail would read a
  // headerless file as generation 0 and miscount the chain.
  it('retries the next generation header when creating it failed after the rename', () => {
    const ws = workspace()
    streamTurn(ws, [0, 1], 100, `
_real_start = addon._start_next_generation
_fail_once = [True]
def _flaky_start(previous):
    if _fail_once[0]:
        _fail_once[0] = False
        raise OSError("injected")
    return _real_start(previous)
addon._start_next_generation = _flaky_start
`)
    // Every one of the turn's 5 writes (request, 2 chunks, end, response)
    // rotates, so the numbering must reach 5 unbroken. Without the retry the
    // next write creates a headerless file, numbering restarts at 0, and the
    // live file ends one generation short.
    expect(generationOf(ws.events)).toBe(5)
    expect(generationOf(rotatedEventsPath(ws.events))).toBe(4)
  })

  it('never raises out of a hook when the events file cannot be written at all', () => {
    const ws = workspace()
    // The parent directory does not exist, so every append fails.
    expect(() => streamTurn({ root: ws.root, events: join(ws.root, 'missing', 'proxy-events.jsonl') }, [0], ROTATE)).not.toThrow()
  })

  it('names the previous generation the way the addon does', () => {
    expect(rotatedEventsPath('/run/proxy-events.jsonl')).toBe('/run/proxy-events.1.jsonl')
  })

  // Round 2 of the #64 review: the counter file could be read between its bump
  // and the rename, pairing a count with the wrong file. Headers make the
  // reviewer's exact sequence — A read, then A->B->C->D before the next poll —
  // report exactly one lost generation (B).
  it('counts exactly one lost generation when A is read and then three rotations pass', async () => {
    const ws = workspace()
    writeFileSync(ws.events, '{"kind":"a"}\n')
    const tail = new EventsFileTail(ws.events)
    expect((await tail.poll()).lines).toEqual(['{"kind":"a"}'])
    rotateLikeAddon(ws.events, '{"kind":"b"}\n')
    rotateLikeAddon(ws.events, '{"kind":"c"}\n')
    rotateLikeAddon(ws.events, '{"kind":"d"}\n')
    const { lines, lost } = await drain(tail)
    expect(lines).toEqual(['{"kind":"c"}', '{"kind":"d"}'])
    expect(lost).toBe(1)
    await tail.close()
  })

  // Round 2 of the #64 review: a rotation before the tail's FIRST poll left the
  // old events at `.1`, never read and never reported.
  it('reads the previous generation when the first poll already finds a rotated file', async () => {
    const ws = workspace()
    writeFileSync(ws.events, '{"kind":"old"}\n')
    rotateLikeAddon(ws.events)
    const tail = new EventsFileTail(ws.events)
    const { lines, lost } = await drain(tail)
    expect(lines).toEqual(['{"kind":"old"}'])
    expect(lost).toBe(0)
    await tail.close()
  })

  // Round 2 of the #64 review: FileHandle.read may return fewer bytes than asked;
  // a short read of a finished generation silently dropped its unread line.
  it('reads a finished generation to its end even when every read is short', async () => {
    const ws = workspace()
    writeFileSync(ws.events, '{"kind":"a"}\n')
    const tail = new EventsFileTail(ws.events)
    expect((await tail.poll()).lines).toEqual(['{"kind":"a"}'])
    appendFileSync(ws.events, '{"kind":"unread"}\n')
    rotateLikeAddon(ws.events, '{"kind":"next"}\n')
    fsHook.maxReadBytes = 5
    try {
      const { lines, lost } = await drain(tail)
      expect(lines).toEqual(['{"kind":"unread"}', '{"kind":"next"}'])
      expect(lost).toBe(0)
    } finally {
      fsHook.maxReadBytes = null
    }
    await tail.close()
  })

  // Round 2 of the #64 review: nothing pinned the second read of the held
  // generation after a rotation is detected — a line written between the first
  // read and the path stat.
  it('finishes a line written to the held generation just before the rotation was noticed', async () => {
    const ws = workspace()
    writeFileSync(ws.events, '{"kind":"a"}\n')
    const tail = new EventsFileTail(ws.events)
    expect((await tail.poll()).lines).toEqual(['{"kind":"a"}'])
    fsHook.before = (call, path) => {
      if (call !== 'stat' || path !== ws.events) return
      fsHook.before = null
      appendFileSync(ws.events, '{"kind":"late"}\n')
      rotateLikeAddon(ws.events, '{"kind":"next"}\n')
    }
    const { lines, lost } = await drain(tail)
    expect(lines).toEqual(['{"kind":"late"}', '{"kind":"next"}'])
    expect(lost).toBe(0)
    await tail.close()
  })
})

// Review of #64 (b): replacing the poll result with [] in ProxyServer dropped
// every live event while all tests passed. Drive the real wiring.
describe('ProxyServer events wiring (#1273)', () => {
  it('emits every tailed line as an event, and a lost generation as a transport gap', async () => {
    const ws = workspace()
    const server = new ProxyServer({ eventsFile: ws.events } as ProxyServerInfo)
    const events: unknown[] = []
    const gaps: unknown[] = []
    server.on('event', event => events.push(event))
    server.on('transport-gap', gap => gaps.push(gap))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const poll = () => (server as unknown as { pollEventsOnce(): Promise<void> }).pollEventsOnce()
    try {
      // A malformed line BEFORE a valid one: one bad line must not drop the rest
      // of its batch (round 2 of the #64 review).
      appendFileSync(ws.events, 'not json\n{"kind":"response-end","flow_id":1}\n')
      await poll()
      expect(events).toEqual([{ kind: 'response-end', flow_id: 1 }])
      for (const n of [2, 3, 4]) rotateLikeAddon(ws.events, `{"kind":"response-end","flow_id":${n}}\n`)
      await poll()
      expect(events).toEqual([{ kind: 'response-end', flow_id: 1 }, { kind: 'response-end', flow_id: 3 }, { kind: 'response-end', flow_id: 4 }])
      expect(gaps).toEqual([{ lostGenerations: 1 }])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      await server.stop()
    }
  })
})
