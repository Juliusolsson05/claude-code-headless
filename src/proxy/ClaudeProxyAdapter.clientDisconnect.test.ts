import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { SemanticChannel } from '../channels/SemanticChannel.js'
import { ClaudeProxyAdapter } from './ClaudeProxyAdapter.js'

// An Esc mid-stream — the transport dies, and nothing else ever says so
// (agent-code#1040).
//
// Claude Code closes the HTTP connection when the user interrupts. mitmproxy
// reports that ONLY through its `error` hook: `_http1.py`'s `wait()` raises
// `RequestProtocolError("Client disconnected.")` into `handle_protocol_error`,
// while the stream tap's end-of-stream call — the `response-end` this adapter
// tears flows down on — runs only on a normal end of message
// (`http/__init__.py:460-462`).
//
// So before the addon grew an `error` hook, the adapter heard nothing at all:
// the flow stayed open holding the phase it last published, the pane kept
// saying `Thinking` until the next prompt, and a goal loop whose turn ended
// that way had no idle edge to resume from (pinned as a known limit in
// agent-code's GoalLoopService until this).

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
  // The shape mitmAddon.py's `error` hook writes.
  const severed = (flowId: number): void => {
    adapter.handleTransportEvent({
      kind: 'response-error',
      flow_id: flowId,
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      host: 'api.anthropic.com',
      path: '/v1/messages',
      error: 'Client disconnected.',
    })
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

describe('a stream the client severed', () => {
  it('goes idle and stops its turn, instead of holding the phase forever', () => {
    const { events, request, chunk, severed } = mount()
    request(1)
    chunk(1, streaming('msg_esc'))
    expect(phases(events).at(-1)).toBe('responding')

    severed(1)

    expect(phases(events).at(-1)).toBe('idle')
    const stopped = events.filter(ev => ev.type === 'turn_stopped')
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatchObject({ interruption: 'client-disconnected', stopReason: null })
    // The partial answer still reaches the consumer; what must NOT appear is a
    // synthesised message_completed claiming a truncated message is whole.
    expect(events.some(ev => ev.type === 'turn_completed')).toBe(true)
    expect(events.some(ev => ev.type === 'message_completed')).toBe(false)
  })

  it('releases the flow, so a retry on a new flow drives the UI again', () => {
    const { events, request, chunk, severed } = mount()
    request(1)
    chunk(1, streaming('msg_first'))
    severed(1)

    request(2)
    chunk(2, streaming('msg_retry'))
    expect(phases(events).at(-1)).toBe('responding')
    // One turn per flow: the severed one is closed, the retry is its own.
    expect(events.filter(ev => ev.type === 'turn_started')).toHaveLength(2)
  })

  it('ignores an error for a flow it never tracked', () => {
    const { events, severed } = mount()
    severed(999)
    expect(events).toHaveLength(0)
  })
})
