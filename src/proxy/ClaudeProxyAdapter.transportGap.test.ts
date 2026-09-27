import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { SemanticChannel } from '../channels/SemanticChannel.js'
import { ClaudeProxyAdapter } from './ClaudeProxyAdapter.js'

// agent-code#1381: the events transport LOST a span (claude-code-headless#64
// reports generations rotated away unread as `transport-gap`). Whatever was
// streaming across that span is missing frames — a text delta, a
// content_block_stop, the message_stop — so continuing to assemble it would
// present a stitched answer as whole. The host calls
// `sealFlowsForTransportGap()` at the gap's place in the event order
// (ProxyServer emits it there), and the adapter closes what it was tracking.
//
// Frames are synthetic in the recorded shape: real Claude mitm recordings
// (~/.config/agent-code/proxy) are private conversation content, and the
// frame sequence here is the one they show (message_start,
// content_block_start, text_delta...). Same convention as the
// client-disconnect test this harness is copied from.

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
  // The shape mitmAddon.py's `error` hook writes: the flow id and
  // mitmproxy's own message, and deliberately nothing else.
  const severed = (flowId: number, error = 'Client disconnected.'): void => {
    adapter.handleTransportEvent({ kind: 'response-error', flow_id: flowId, error })
  }
  return { adapter, events, request, chunk, severed }
}

const streaming = (id: string): Frame[] => [
  { type: 'message_start', message: { id, model: MODEL, usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an answ' } },
]

const phases = (events: Array<Record<string, unknown>>): unknown[] =>
  events.filter(ev => ev.type === 'stream_phase').map(ev => ev.phase)

describe('a transport gap across a live stream (agent-code#1381)', () => {
  it('seals the streaming turn as cut off by the gap and goes idle', () => {
    const { adapter, events, request, chunk } = mount()
    request(1)
    chunk(1, streaming('msg_gap'))
    expect(phases(events).at(-1)).toBe('responding')

    adapter.sealFlowsForTransportGap()

    expect(phases(events).at(-1)).toBe('idle')
    const stopped = events.filter(ev => ev.type === 'turn_stopped')
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatchObject({ interruption: 'transport-gap', stopReason: null })
    // The partial text still reaches the consumer (it was real); a
    // message_completed would claim the truncated message is whole.
    expect(events.some(ev => ev.type === 'turn_completed')).toBe(true)
    expect(events.some(ev => ev.type === 'message_completed')).toBe(false)
  })

  it('ignores the rest of a sealed flow instead of stitching it onto the answer', () => {
    const { adapter, events, request, chunk } = mount()
    request(1)
    chunk(1, streaming('msg_gap'))
    adapter.sealFlowsForTransportGap()
    const before = events.length
    // Post-gap frames of the same HTTP response: their block starts were lost.
    chunk(1, [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'rest of it' } }])
    adapter.handleTransportEvent({ kind: 'response-end', flow_id: 1 })
    expect(events.slice(before)).toEqual([])
  })

  it('keeps a request-only flow whose response provably starts after the gap', () => {
    // cch#69 review b: a request seen, no chunk yet. If its first post-gap
    // chunk opens with message_start, the response began after the loss and
    // is whole; dropping it lost an intact live turn.
    const { adapter, events, request, chunk } = mount()
    request(1)
    adapter.sealFlowsForTransportGap()
    chunk(1, streaming('msg_after'))
    expect(events.filter(ev => ev.type === 'turn_started')).toHaveLength(1)
  })

  it('forgets a request-only flow whose first post-gap chunk begins mid-SSE', () => {
    // Its opening frames were in the lost span: a decoder started here
    // would assemble a message without its start.
    const { adapter, events, request, chunk } = mount()
    request(1)
    adapter.sealFlowsForTransportGap()
    chunk(1, streaming('msg_cut').slice(1))
    adapter.handleTransportEvent({ kind: 'response-end', flow_id: 1 })
    expect(events.filter(ev => ev.type === 'turn_started')).toHaveLength(0)
    // A NEW request after the gap streams normally.
    request(2)
    chunk(2, streaming('msg_next'))
    expect(events.filter(ev => ev.type === 'turn_started')).toHaveLength(1)
  })

  it('accepts a message_start split across the first post-gap chunks', () => {
    // The transport cuts chunks anywhere; a first chunk that is a prefix of
    // the opening frame is still the response's start.
    const { adapter, events, request } = mount()
    request(1)
    adapter.sealFlowsForTransportGap()
    // Cut mid-frame, and the second cut inside a multi-byte character, so a
    // string round trip of the held prefix would corrupt the text.
    const bytes = Buffer.from(sse([...streaming('msg_split').slice(0, 2), { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'café' } }]))
    const cut = bytes.indexOf(Buffer.from('é')) + 1
    for (const part of [bytes.subarray(0, 9), bytes.subarray(9, cut), bytes.subarray(cut)]) {
      adapter.handleTransportEvent({ kind: 'response-chunk', flow_id: 1, path: '/v1/messages', chunk_b64: part.toString('base64') })
    }
    expect(events.filter(ev => ev.type === 'turn_started')).toHaveLength(1)
    expect(events.filter(ev => ev.type === 'turn_delta').at(-1)?.fullText).toBe('café')
  })

  it('leaves a completed turn waiting for its tool instead of calling it idle', () => {
    // The tool message ended cleanly before the gap; the gap says nothing
    // about the tool now running locally. Same rule as a severed socket.
    const { adapter, events, request, chunk } = mount()
    request(1)
    chunk(1, [
      { type: 'message_start', message: { id: 'msg_tool', model: MODEL, usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    expect(phases(events).at(-1)).toBe('awaiting-tool')
    adapter.sealFlowsForTransportGap()
    expect(phases(events).at(-1)).toBe('awaiting-tool')
    expect(events.filter(ev => ev.type === 'turn_stopped')).toHaveLength(1)
  })

  it('keeps a stopped turn\'s awaiting-tool phase when a concurrent flow is sealed with it', () => {
    // cch#69 review b: sealing the awaiting-tool flow first handed phase
    // ownership to the still-streaming flow, whose seal then published idle
    // while the tool was still running locally.
    const { adapter, events, request, chunk } = mount()
    request(1)
    chunk(1, [
      { type: 'message_start', message: { id: 'msg_tool', model: MODEL, usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    request(2)
    chunk(2, streaming('msg_parallel'))
    expect(phases(events).at(-1)).toBe('awaiting-tool')

    adapter.sealFlowsForTransportGap()

    expect(phases(events).at(-1)).toBe('awaiting-tool')
    const stopped = events.filter(ev => ev.type === 'turn_stopped')
    expect(stopped.at(-1)).toMatchObject({ interruption: 'transport-gap' })
  })

  it('seals every concurrent streaming turn, not only the first', () => {
    const { adapter, events, request, chunk } = mount()
    request(1)
    chunk(1, streaming('msg_one'))
    request(2)
    chunk(2, streaming('msg_two'))
    adapter.sealFlowsForTransportGap()
    expect(events.filter(ev => ev.type === 'turn_stopped' && ev.interruption === 'transport-gap')).toHaveLength(2)
  })

  it('gives back the spinner of a flow that streamed its first chunk but has no turn yet', () => {
    const { adapter, events, request, chunk } = mount()
    request(1)
    // A first chunk with no complete frame: requesting, no message_start yet.
    adapter.handleTransportEvent({ kind: 'response-chunk', flow_id: 1, path: '/v1/messages', chunk_b64: Buffer.from('event: message_st').toString('base64') })
    expect(phases(events).at(-1)).toBe('requesting')
    adapter.sealFlowsForTransportGap()
    expect(phases(events).at(-1)).toBe('idle')
  })

  it('is a no-op when nothing is being tracked', () => {
    const { adapter, events } = mount()
    adapter.sealFlowsForTransportGap()
    expect(events).toEqual([])
  })
})
