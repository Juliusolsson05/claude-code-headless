import { describe, expect, it } from 'vitest'

import { ClaudeProxyAdapter } from './ClaudeProxyAdapter.js'

type Call = { method: string; arg: Record<string, unknown> }

function makeChannel(calls: Call[]) {
  // WHY this records any channel method instead of stubbing today's exact
  // adapter surface: the contract under test is which semantic publications
  // happen. Adding an unrelated diagnostic method must not force this fixture
  // to duplicate the whole SemanticChannel interface.
  return new Proxy(
    {},
    {
      get: (_target, property) => (arg: Record<string, unknown>) => {
        calls.push({ method: String(property), arg: arg ?? {} })
      },
    },
  ) as never
}

function encodeBody(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

function sse(text: string): string {
  const frames = [
    { type: 'message_start', message: { id: 'msg_x', model: 'claude-opus-4-8', usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    { type: 'message_stop' },
  ]
  return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
}

function drive(
  adapter: ClaudeProxyAdapter,
  flowId: number,
  body: string,
  streamText: string,
): void {
  adapter.handleTransportEvent({
    kind: 'request',
    flow_id: flowId,
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    body_b64: body,
  } as never)
  adapter.handleTransportEvent({
    kind: 'response-chunk',
    flow_id: flowId,
    path: '/v1/messages',
    chunk_b64: Buffer.from(sse(streamText)).toString('base64'),
  } as never)
  adapter.handleTransportEvent({
    kind: 'response-end',
    flow_id: flowId,
    path: '/v1/messages',
  } as never)
}

const tools = new Array(10).fill({ name: 'Bash' })
const system = [{ type: 'text', text: 'You are Claude Code' }]

function requestBody(messages: unknown[]): string {
  return encodeBody({
    model: 'claude-opus-4-8',
    max_tokens: 64_000,
    tools,
    system,
    messages,
  })
}

describe('ClaudeProxyAdapter prompt-suggestion routing', () => {
  it('publishes and deduplicates provider session headers', () => {
    const calls: Call[] = []
    const adapter = new ClaudeProxyAdapter({
      channel: makeChannel(calls),
      getSessionModel: () => 'claude-opus-4-8',
    })
    const request = {
      kind: 'request',
      flow_id: 101,
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      host: 'api.anthropic.com',
      path: '/v1/messages',
      headers: { 'X-Claude-Code-Session-Id': 'claude-session-1' },
      body_b64: requestBody([{ role: 'user', content: 'fix the bug' }]),
    }

    adapter.handleTransportEvent(request as never)
    adapter.handleTransportEvent({ ...request, flow_id: 102 } as never)

    expect(calls.filter(call => call.method === 'publishProviderSessionObserved')).toEqual([
      expect.objectContaining({
        arg: expect.objectContaining({
          provider: 'claude',
          providerSessionId: 'claude-session-1',
          flowId: '101',
          confidence: 'high',
        }),
      }),
    ])
  })

  it('keeps suggestion output out of the visible turn and publishes it once', () => {
    const calls: Call[] = []
    const adapter = new ClaudeProxyAdapter({
      channel: makeChannel(calls),
      getSessionModel: () => 'claude-opus-4-8',
    })

    drive(adapter, 111, requestBody([
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might type next' },
    ]), 'run the tests')

    expect(calls.find(call => call.method === 'startTurn')).toBeUndefined()
    expect(calls.find(call => call.method === 'publishPromptSuggestion')?.arg).toMatchObject({
      text: 'run the tests',
    })
  })

  it('does not publish filtered suggestion noise', () => {
    const calls: Call[] = []
    const adapter = new ClaudeProxyAdapter({
      channel: makeChannel(calls),
      getSessionModel: () => 'claude-opus-4-8',
    })

    drive(adapter, 222, requestBody([
      { role: 'user', content: '[SUGGESTION MODE: Suggest the next input' },
    ]), 'silence')

    expect(calls.find(call => call.method === 'publishPromptSuggestion')).toBeUndefined()
    expect(calls.find(call => call.method === 'startTurn')).toBeUndefined()
  })

  it('continues to publish an ordinary request as a visible turn', () => {
    const calls: Call[] = []
    const adapter = new ClaudeProxyAdapter({
      channel: makeChannel(calls),
      getSessionModel: () => 'claude-opus-4-8',
    })

    drive(adapter, 333, requestBody([
      { role: 'user', content: 'fix the bug' },
    ]), 'Working on it')

    expect(calls.find(call => call.method === 'startTurn')).toBeDefined()
    expect(calls.find(call => call.method === 'publishPromptSuggestion')).toBeUndefined()
  })
})
