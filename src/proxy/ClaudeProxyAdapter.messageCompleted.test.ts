import { describe, expect, it } from 'vitest'

import { ClaudeProxyAdapter } from './ClaudeProxyAdapter.js'

// RED-TEST CONTRACT (implementation comes after; these tests define it).
//
// The audit found that no complete-assistant-message event exists: the only
// turn-terminal payload is `turn_completed.fullText`, which aggregates
// text_delta ONLY. Tool-only turns produce an empty aggregate, thinking is
// aggregated away, and block state is deleted at content_block_stop. A
// consumer cannot reconstruct "what the assistant actually said" from the
// semantic channel.
//
// The new contract: at `message_stop` the adapter calls
// `channel.publishMessageCompleted(...)` once per assistant message with the
// ASSEMBLED content blocks:
//
//   publishMessageCompleted({
//     turnId: string,
//     role: 'assistant',
//     model?: string,
//     stopReason?: string,
//     blocks: Array<
//       | { kind: 'text', text: string, index: number }
//       | { kind: 'thinking', text: string, signature?: string, index: number }
//       | { kind: 'redacted_thinking', data: string, index: number }
//       | { kind: 'tool_use', toolName: string, toolInput: unknown, index: number }
//     >,
//     usage?: Record<string, unknown>,
//     source, confidence?
//   })
//
// Structural note (from real wire recordings, see
// ~/.config/agent-code/proxy/**/proxy-events.jsonl): block indexes arrive
// contiguously per message (0,1,2…) and every content_block_start is paired
// with exactly one content_block_stop, so assembling in index order is exact.

type Call = { method: string; arg: Record<string, unknown> }

function makeChannel(calls: Call[]) {
  // WHY record-any-method instead of stubbing the exact adapter surface:
  // the contract under test is WHICH semantic publications happen; an
  // unrelated new diagnostic method must not break this fixture.
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

// SSE frame builders. Structure mirrors REAL recorded wire sequences
// (thinking → signature → text → tool_use with input_json_delta) but all
// content is synthetic placeholder text — real session content never gets
// copied into test fixtures.
type Frame = Record<string, unknown>

function messageStart(): Frame {
  return { type: 'message_start', message: { id: 'msg_x', model: 'claude-opus-4-8', usage: { input_tokens: 10 } } }
}

function thinkingBlock(index: number, deltas: string[]): Frame[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
    ...deltas.map(text => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } })),
    { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'synthetic-sig' } },
    { type: 'content_block_stop', index },
  ]
}

function textBlock(index: number, deltas: string[]): Frame[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ...deltas.map(text => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index },
  ]
}

function toolUseBlock(index: number, name: string, partialJson: string): Frame[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } },
    { type: 'content_block_stop', index },
  ]
}

function messageEnd(stopReason: string, outputTokens = 42): Frame[] {
  return [
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
    { type: 'message_stop' },
  ]
}

function sse(frames: Frame[]): string {
  return frames
    .map(frame => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join('')
}

function chunk(adapter: ClaudeProxyAdapter, flowId: number, frames: Frame[]): void {
  adapter.handleTransportEvent({
    kind: 'response-chunk',
    flow_id: flowId,
    path: '/v1/messages',
    chunk_b64: Buffer.from(sse(frames)).toString('base64'),
  } as never)
}

function request(adapter: ClaudeProxyAdapter, flowId: number, messages: unknown[]): void {
  adapter.handleTransportEvent({
    kind: 'request',
    flow_id: flowId,
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    body_b64: requestBody(messages),
  } as never)
}

function responseEnd(adapter: ClaudeProxyAdapter, flowId: number): void {
  adapter.handleTransportEvent({
    kind: 'response-end',
    flow_id: flowId,
    path: '/v1/messages',
  } as never)
}

function makeAdapter(calls: Call[]): ClaudeProxyAdapter {
  return new ClaudeProxyAdapter({
    channel: makeChannel(calls),
    getSessionModel: () => 'claude-opus-4-8',
  })
}

function messageCompletedCalls(calls: Call[]): Call[] {
  return calls.filter(call => call.method === 'publishMessageCompleted')
}

describe('ClaudeProxyAdapter complete-message semantics', () => {
  it('streams thinking deltas AND includes the assembled thinking block in message_completed', () => {
    const calls: Call[] = []
    const adapter = makeAdapter(calls)

    request(adapter, 1, [{ role: 'user', content: 'summarize the file' }])
    chunk(adapter, 1, [
      messageStart(),
      ...thinkingBlock(0, ['synthetic thinking delta 1', 'synthetic thinking delta 2']),
      ...textBlock(1, ['synthetic final answer']),
      ...messageEnd('end_turn'),
    ])
    responseEnd(adapter, 1)

    // Existing behavior — must keep working (guard against regression while
    // adding the new event).
    const thinkingDeltas = calls.filter(call => call.method === 'publishThinkingDelta')
    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2)

    // New contract.
    const completed = messageCompletedCalls(calls)
    expect(completed).toHaveLength(1)
    expect(completed[0].arg.blocks).toEqual([
      { kind: 'thinking', text: 'synthetic thinking delta 1synthetic thinking delta 2', signature: 'synthetic-sig', index: 0 },
      { kind: 'text', text: 'synthetic final answer', index: 1 },
    ])
    expect(completed[0].arg.stopReason).toBe('end_turn')
  })

  it('emits message_completed with tool_use blocks for a TOOL-ONLY turn (the old empty-message bug)', () => {
    const calls: Call[] = []
    const adapter = makeAdapter(calls)

    request(adapter, 2, [{ role: 'user', content: 'run the checks' }])
    chunk(adapter, 2, [
      messageStart(),
      ...toolUseBlock(0, 'Bash', '{"command":"echo one"}'),
      ...toolUseBlock(1, 'Bash', '{"command":"echo two"}'),
      ...messageEnd('tool_use'),
    ])
    responseEnd(adapter, 2)

    const completed = messageCompletedCalls(calls)
    expect(completed).toHaveLength(1)
    expect(completed[0].arg.blocks).toEqual([
      { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'echo one' }, index: 0 },
      { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'echo two' }, index: 1 },
    ])
  })

  it('keeps emitting turn_completed alongside the new message_completed (non-breaking)', () => {
    const calls: Call[] = []
    const adapter = makeAdapter(calls)

    request(adapter, 3, [{ role: 'user', content: 'hi' }])
    chunk(adapter, 3, [
      messageStart(),
      ...textBlock(0, ['hello there']),
      ...messageEnd('end_turn'),
    ])
    responseEnd(adapter, 3)

    expect(calls.find(call => call.method === 'finishTurn')?.arg).toMatchObject({ fullText: 'hello there' })
    expect(messageCompletedCalls(calls)).toHaveLength(1)
  })

  it('does NOT silently drop a second real flow that starts while one is active', () => {
    // The single activeStreamingFlowId lock permanently demotes concurrent
    // real flows to 'secondary' (flow_ignored, whole message lost). Real
    // recordings show Claude Code firing overlapping /v1/messages flows
    // (e.g. a fast first turn whose response-end races the next request).
    // New contract: a NON-sidecar flow must never be silently discarded —
    // both flows produce their full semantic sequences.
    const calls: Call[] = []
    const adapter = makeAdapter(calls)

    request(adapter, 10, [{ role: 'user', content: 'first question' }])
    chunk(adapter, 10, [
      messageStart(),
      ...textBlock(0, ['first answer part 1']),
    ])

    // Flow 11 arrives while flow 10 is still streaming (no response-end yet).
    request(adapter, 11, [{ role: 'user', content: 'second question' }])
    chunk(adapter, 11, [
      messageStart(),
      ...textBlock(0, ['second answer']),
      ...messageEnd('end_turn'),
    ])
    responseEnd(adapter, 11)

    chunk(adapter, 10, [
      ...textBlock(0, [' part 2']),
      ...messageEnd('end_turn'),
    ])
    responseEnd(adapter, 10)

    const completed = messageCompletedCalls(calls)
    const texts = completed.map(call => JSON.stringify(call.arg.blocks))
    expect(completed).toHaveLength(2)
    expect(texts.some(t => t.includes('first answer part 1') && t.includes('part 2'))).toBe(true)
    expect(texts.some(t => t.includes('second answer'))).toBe(true)
  })

  it('still excludes subagent flows from the semantic channel (by design)', () => {
    const calls: Call[] = []
    const adapter = makeAdapter(calls)

    adapter.handleTransportEvent({
      kind: 'request',
      flow_id: 20,
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      host: 'api.anthropic.com',
      path: '/v1/messages',
      headers: { 'cc_is_subagent': 'true' },
      body_b64: requestBody([{ role: 'user', content: 'nested work' }]),
    } as never)
    chunk(adapter, 20, [
      messageStart(),
      ...textBlock(0, ['nested agent text']),
      ...messageEnd('end_turn'),
    ])
    responseEnd(adapter, 20)

    expect(calls.find(call => call.method === 'startTurn')).toBeUndefined()
    expect(messageCompletedCalls(calls)).toHaveLength(0)
    expect(calls.find(call => call.method === 'publishFlowIgnored')).toBeDefined()
  })
})
