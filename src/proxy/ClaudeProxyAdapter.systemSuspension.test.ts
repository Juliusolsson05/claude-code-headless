import { Buffer } from 'node:buffer'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SemanticChannel } from '../channels/SemanticChannel.js'
import { ClaudeProxyAdapter } from './ClaudeProxyAdapter.js'

// `sealFlowsSilentSince` — closing a stream the machine's sleep severed.
//
// The failure it fixes (agent-code#963): when a laptop sleeps mid-turn, the
// stream's TCP connection dies and the proxy never forwards `response-end`. The
// only existing reap runs inside the NEXT flow's first chunk, so if Claude Code
// does not retry after wake the turn stays open and a host UI shows the turn as
// still thinking indefinitely. The host now tells the adapter when the machine
// was suspended.
//
// Times are from a real recording in the agent-code decomposition
// (docs/decomposition/agent-working-time.md, case A): prompt 2026-08-31 20:57:09
// PDT, last stream activity 22:45:08, clamshell sleep 23:43:59 → wake 08:01:40.
// Frame content is synthetic placeholder text.

const PDT = (local: string): number => Date.parse(`${local}-07:00`)
const PROMPT_AT = PDT('2026-08-31T20:57:09')
const LAST_STREAM_AT = PDT('2026-08-31T22:45:08')
const SLEEP_AT = PDT('2026-08-31T23:43:59')
const WAKE_AT = PDT('2026-09-01T08:01:40')
const MODEL = 'claude-opus-4-8'

type Frame = Record<string, unknown>

function sse(frames: Frame[]): string {
  return frames.map(frame => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
}

function mount() {
  const channel = new SemanticChannel()
  const adapter = new ClaudeProxyAdapter({ channel, getSessionModel: () => MODEL })
  const events: Array<Record<string, unknown>> = []
  channel.on('event', (ev: Record<string, unknown>) => events.push(ev))
  const request = (flowId: number): void => {
    const body = {
      model: MODEL,
      max_tokens: 64_000,
      tools: new Array(10).fill({ name: 'Bash' }),
      system: [{ type: 'text', text: 'You are Claude Code' }],
      messages: [{ role: 'user', content: 'synthetic prompt' }],
    }
    adapter.handleTransportEvent({
      kind: 'request',
      flow_id: flowId,
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      host: 'api.anthropic.com',
      path: '/v1/messages',
      body_b64: Buffer.from(JSON.stringify(body)).toString('base64'),
    })
  }
  const chunk = (flowId: number, frames: Frame[]): void => {
    adapter.handleTransportEvent({
      kind: 'response-chunk',
      flow_id: flowId,
      path: '/v1/messages',
      chunk_b64: Buffer.from(sse(frames)).toString('base64'),
    })
  }
  const end = (flowId: number): void => {
    adapter.handleTransportEvent({ kind: 'response-end', flow_id: flowId, path: '/v1/messages' })
  }
  return { adapter, events, request, chunk, end }
}

const thinkingOpen = (id: string): Frame[] => [
  { type: 'message_start', message: { id, model: MODEL, usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'synthetic' } },
]

const phases = (events: Array<Record<string, unknown>>): unknown[] =>
  events.filter(ev => ev.type === 'stream_phase').map(ev => ev.phase)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClaudeProxyAdapter.sealFlowsSilentSince', () => {
  it('stops a turn whose stream went silent before the sleep, with the interruption cause, and returns the phase to idle', () => {
    const pane = mount()
    vi.setSystemTime(PROMPT_AT)
    pane.request(1)
    pane.chunk(1, thinkingOpen('msg_severed'))
    vi.setSystemTime(LAST_STREAM_AT)
    pane.chunk(1, [{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'more' } }])
    expect(phases(pane.events).at(-1)).toBe('thinking')

    vi.setSystemTime(WAKE_AT + 60_000)
    pane.adapter.sealFlowsSilentSince(SLEEP_AT, 'system-suspended')

    expect(pane.events.filter(ev => ev.type === 'turn_stopped')).toEqual([
      expect.objectContaining({ turnId: 'msg_severed', interruption: 'system-suspended', stopReason: null }),
    ])
    expect(pane.events.some(ev => ev.type === 'turn_completed')).toBe(true)
    expect(phases(pane.events).at(-1)).toBe('idle')

    // Sealed flows are gone: a second call finds nothing to stop.
    const before = pane.events.length
    pane.adapter.sealFlowsSilentSince(SLEEP_AT, 'system-suspended')
    expect(pane.events).toHaveLength(before)
  })

  it('leaves a stream that delivered a chunk after the sleep began untouched', () => {
    const pane = mount()
    vi.setSystemTime(PROMPT_AT)
    pane.request(1)
    pane.chunk(1, thinkingOpen('msg_survived'))
    vi.setSystemTime(WAKE_AT)
    pane.chunk(1, [{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'after wake' } }])

    pane.adapter.sealFlowsSilentSince(SLEEP_AT, 'system-suspended')

    expect(pane.events.some(ev => ev.type === 'turn_stopped')).toBe(false)
    expect(phases(pane.events).at(-1)).toBe('thinking')
  })

  it('idles a flow that streamed its first chunk but died before message_start', () => {
    // First-chunk promotion publishes `requesting`; with no turn to stop, the
    // phase it owns must still be cleared or it stays on screen after the flow.
    const pane = mount()
    vi.setSystemTime(PROMPT_AT)
    pane.request(1)
    pane.chunk(1, [{ type: 'ping' }])
    expect(phases(pane.events).at(-1)).toBe('requesting')

    vi.setSystemTime(WAKE_AT)
    pane.adapter.sealFlowsSilentSince(SLEEP_AT, 'system-suspended')

    expect(pane.events.some(ev => ev.type === 'turn_stopped')).toBe(false)
    expect(phases(pane.events).at(-1)).toBe('idle')
  })

  it('never puts an interruption key on a turn upstream stopped', () => {
    const pane = mount()
    vi.setSystemTime(PROMPT_AT)
    pane.request(1)
    pane.chunk(1, [
      ...thinkingOpen('msg_clean'),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])
    pane.end(1)

    const stopped = pane.events.filter(ev => ev.type === 'turn_stopped')
    expect(stopped.length).toBeGreaterThan(0)
    expect(stopped.every(ev => !('interruption' in ev))).toBe(true)
  })
})
