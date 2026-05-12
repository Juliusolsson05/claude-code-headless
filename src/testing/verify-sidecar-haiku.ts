#!/usr/bin/env tsx
/**
 * Regression test — sidecar Haiku flows must not leak as visible turns.
 *
 * Why this exists:
 *
 *   Claude Code v2.1.119+ makes a small extra Haiku API call at the
 *   start of (some) sessions to generate a session title (see vendor
 *   utils/sessionTitle.ts). The model emits text shaped like
 *   `{"title": "..."}` and the call uses the same `/v1/messages`
 *   endpoint as the visible conversation turn. Without filtering, the
 *   ClaudeProxyAdapter happily promotes the title flow to `'active'`,
 *   publishes `turn_started` + `text_delta` + `block_completed` to
 *   the SemanticChannel, and the renderer mints a ghost entry for it
 *   that never gets superseded by an upstream JSONL entry (Claude
 *   Code only writes real conversation turns to the rollout). The
 *   ghost orphans after its TTL and is rendered as a phantom
 *   "{"title": "..."}" message at the bottom of the transcript.
 *
 *   The fix lives in ClaudeProxyAdapter: when `message_start.model`
 *   matches the configured sidecar pattern AND the caller-provided
 *   session model differs from it, the flow is demoted to
 *   `'secondary'`, no `startTurn` is emitted, and the renderer never
 *   sees the sidecar exist as a turn.
 *
 *   This test drives the adapter with two synthesised flows: a Haiku
 *   "title generation" flow and a Sonnet conversation flow. It
 *   asserts that the Haiku flow produces ZERO `turn_started` /
 *   `text_delta` semantic events while the Sonnet flow produces
 *   normal events. Constructed against the real adapter + real
 *   SemanticChannel (no mocks) — the only synthesised input is the
 *   transport event byte stream.
 *
 * Run with:
 *   npx tsx src/testing/verify-sidecar-haiku.ts
 */

import { SemanticChannel } from '../channels/SemanticChannel.js'
import {
  ClaudeProxyAdapter,
  type ProxyTransportEvent,
} from '../proxy/ClaudeProxyAdapter.js'

let passed = 0
let failed = 0

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// SSE record encoder. Anthropic's stream framing: `event: <type>\n`
// followed by `data: <json>\n\n`. The adapter's IncrementalSseParser
// splits on the empty line, so every record must end with \n\n.
function sseRecord(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function chunkEvent(flowId: string, sse: string, url: string): ProxyTransportEvent {
  return {
    kind: 'response-chunk',
    flow_id: flowId,
    method: 'POST',
    url,
    host: 'api.anthropic.com',
    path: '/v1/messages',
    chunk_b64: Buffer.from(sse, 'utf8').toString('base64'),
  }
}

function requestEvent(flowId: string, url: string): ProxyTransportEvent {
  return {
    kind: 'request',
    flow_id: flowId,
    method: 'POST',
    url,
    host: 'api.anthropic.com',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
  }
}

function endEvent(flowId: string, url: string): ProxyTransportEvent {
  return {
    kind: 'response-end',
    flow_id: flowId,
    method: 'POST',
    url,
    host: 'api.anthropic.com',
    path: '/v1/messages',
  }
}

// Build a minimal but realistic Anthropic SSE byte stream for one
// turn. Matches the event order and field shapes captured in the
// 2026-04-26 debug bundle's proxy-semantic.json.
function buildTurnSse(opts: {
  messageId: string
  model: string
  text: string
}): string {
  return [
    sseRecord('message_start', {
      type: 'message_start',
      message: {
        id: opts.messageId,
        type: 'message',
        role: 'assistant',
        model: opts.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 341, output_tokens: 6 },
      },
    }),
    sseRecord('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseRecord('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: opts.text },
    }),
    sseRecord('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
    sseRecord('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 14 },
    }),
    sseRecord('message_stop', { type: 'message_stop' }),
  ].join('')
}

type Capture = {
  turnStartedTurnIds: string[]
  textDeltas: Array<{ turnId: string; text: string }>
  flowSelected: Array<{ flowId: string; reason: string }>
  flowIgnored: Array<{ flowId: string; reason: string }>
  blockCompletedTexts: string[]
}

function attachCapture(channel: SemanticChannel): Capture {
  const cap: Capture = {
    turnStartedTurnIds: [],
    textDeltas: [],
    flowSelected: [],
    flowIgnored: [],
    blockCompletedTexts: [],
  }
  channel.on('turn_started', ev => cap.turnStartedTurnIds.push(ev.turnId))
  channel.on('text_delta', ev =>
    cap.textDeltas.push({ turnId: ev.turnId, text: ev.textDelta }),
  )
  channel.on('flow_selected', ev =>
    cap.flowSelected.push({ flowId: ev.flowId, reason: ev.reason }),
  )
  channel.on('flow_ignored', ev =>
    cap.flowIgnored.push({ flowId: ev.flowId, reason: ev.reason }),
  )
  channel.on('block_completed', ev => {
    if (ev.kind === 'text' && ev.text) cap.blockCompletedTexts.push(ev.text)
  })
  return cap
}

function driveFlow(adapter: ClaudeProxyAdapter, opts: {
  flowId: string
  messageId: string
  model: string
  text: string
}): void {
  const url = 'https://api.anthropic.com/v1/messages'
  adapter.handleTransportEvent(requestEvent(opts.flowId, url))
  adapter.handleTransportEvent(
    chunkEvent(opts.flowId, buildTurnSse({
      messageId: opts.messageId,
      model: opts.model,
      text: opts.text,
    }), url),
  )
  adapter.handleTransportEvent(endEvent(opts.flowId, url))
}

// -----------------------------------------------------------------------------
// Case 1: title-gen Haiku flow with Sonnet session — Haiku must be filtered.
// -----------------------------------------------------------------------------
//
// This is the production scenario from the 2026-04-26 debug bundle:
// the user is on Opus/Sonnet, Claude Code makes a one-shot Haiku
// title-generation call, and the title text leaks into the live
// transcript as an orphan ghost.

function caseSidecarHaikuFiltered(): void {
  console.log('\n── case: Haiku title-gen flow filtered when session model is Sonnet ──')

  const channel = new SemanticChannel()
  const cap = attachCapture(channel)
  const adapter = new ClaudeProxyAdapter({
    channel,
    // Caller commits to "this session is Sonnet"; the adapter uses
    // this to know that any Haiku call is necessarily a sidecar.
    getSessionModel: () => 'claude-sonnet-4-6',
  })

  driveFlow(adapter, {
    flowId: 'haiku-title-flow',
    messageId: 'msg_haiku_title_001',
    model: 'claude-haiku-4-5-20251001',
    text: '{"title": "Identify project purpose and scope"}',
  })

  assert(
    'no turn_started for the Haiku flow',
    !cap.turnStartedTurnIds.includes('msg_haiku_title_001'),
    `got turn_started ids: ${JSON.stringify(cap.turnStartedTurnIds)}`,
  )
  assert(
    'no text_delta for the Haiku flow',
    !cap.textDeltas.some(d => d.turnId === 'msg_haiku_title_001'),
    `got text_deltas: ${JSON.stringify(cap.textDeltas)}`,
  )
  assert(
    'no block_completed text leaked from the Haiku flow',
    !cap.blockCompletedTexts.some(t => t.includes('"title"')),
    `got block texts: ${JSON.stringify(cap.blockCompletedTexts)}`,
  )
  assert(
    'flow_ignored diagnostic emitted for the Haiku flow',
    cap.flowIgnored.some(f => f.flowId === 'haiku-title-flow'),
    `got flow_ignored: ${JSON.stringify(cap.flowIgnored)}`,
  )
}

// -----------------------------------------------------------------------------
// Case 2: real Sonnet flow on a Sonnet session — must NOT be filtered.
// -----------------------------------------------------------------------------
//
// Guards against an over-broad filter that suppresses everything.

function caseRealSonnetPasses(): void {
  console.log('\n── case: real Sonnet flow on Sonnet session is published normally ──')

  const channel = new SemanticChannel()
  const cap = attachCapture(channel)
  const adapter = new ClaudeProxyAdapter({
    channel,
    getSessionModel: () => 'claude-sonnet-4-6',
  })

  driveFlow(adapter, {
    flowId: 'sonnet-conv-flow',
    messageId: 'msg_sonnet_conv_001',
    model: 'claude-sonnet-4-6',
    text: 'Agent Code is an Electron app.',
  })

  assert(
    'turn_started fired for the real Sonnet flow',
    cap.turnStartedTurnIds.includes('msg_sonnet_conv_001'),
    `got turn_started ids: ${JSON.stringify(cap.turnStartedTurnIds)}`,
  )
  assert(
    'text_delta fired for the real Sonnet flow',
    cap.textDeltas.some(d => d.turnId === 'msg_sonnet_conv_001'),
    `got text_deltas: ${JSON.stringify(cap.textDeltas)}`,
  )
  assert(
    'block_completed text matches what the model produced',
    cap.blockCompletedTexts.includes('Agent Code is an Electron app.'),
    `got block texts: ${JSON.stringify(cap.blockCompletedTexts)}`,
  )
}

// -----------------------------------------------------------------------------
// Case 3: user explicitly running Haiku as the primary model — must NOT filter.
// -----------------------------------------------------------------------------
//
// This is the false-positive case the "differs from session model"
// guard is designed to prevent. A Haiku-on-Haiku call is the user's
// real conversation; suppressing it would blank the transcript.

function caseHaikuAsPrimaryModelPasses(): void {
  console.log('\n── case: Haiku flow is published when session model IS Haiku ──')

  const channel = new SemanticChannel()
  const cap = attachCapture(channel)
  const adapter = new ClaudeProxyAdapter({
    channel,
    getSessionModel: () => 'claude-haiku-4-5-20251001',
  })

  driveFlow(adapter, {
    flowId: 'haiku-primary-flow',
    messageId: 'msg_haiku_primary_001',
    model: 'claude-haiku-4-5-20251001',
    text: 'short answer.',
  })

  assert(
    'turn_started fired for Haiku conversation when Haiku is primary',
    cap.turnStartedTurnIds.includes('msg_haiku_primary_001'),
    `got turn_started ids: ${JSON.stringify(cap.turnStartedTurnIds)}`,
  )
  assert(
    'text_delta fired for Haiku conversation when Haiku is primary',
    cap.textDeltas.some(d => d.turnId === 'msg_haiku_primary_001'),
    `got text_deltas: ${JSON.stringify(cap.textDeltas)}`,
  )
}

// -----------------------------------------------------------------------------
// Case 4: replay of the actual 2026-04-26 bundle pattern.
// -----------------------------------------------------------------------------
//
// Title flow first, then real conversation flow. Mirrors the bundle's
// ordering. Asserts the title flow is filtered AND the real flow that
// follows it claims the lock cleanly (i.e. the title flow's brief
// active-attribution didn't poison the lock state).

function caseSequentialBundleReplay(): void {
  console.log('\n── case: title flow then real flow (bundle replay) ──')

  const channel = new SemanticChannel()
  const cap = attachCapture(channel)
  const adapter = new ClaudeProxyAdapter({
    channel,
    getSessionModel: () => 'claude-opus-4-7',
  })

  driveFlow(adapter, {
    flowId: 'flow-title',
    messageId: 'msg_018tusvFkJ_title',
    model: 'claude-haiku-4-5-20251001',
    text: '{"title": "Identify project purpose and scope"}',
  })
  driveFlow(adapter, {
    flowId: 'flow-real',
    messageId: 'msg_013XgVGm_real',
    model: 'claude-opus-4-7',
    text: '**Agent Code** is an Electron-based agent-first editor.',
  })

  assert(
    'real Opus flow produced turn_started',
    cap.turnStartedTurnIds.includes('msg_013XgVGm_real'),
    `turn_started ids: ${JSON.stringify(cap.turnStartedTurnIds)}`,
  )
  assert(
    'title-gen Haiku flow did NOT produce turn_started',
    !cap.turnStartedTurnIds.includes('msg_018tusvFkJ_title'),
    `turn_started ids: ${JSON.stringify(cap.turnStartedTurnIds)}`,
  )
  assert(
    'no JSON-title text leaked into block_completed',
    !cap.blockCompletedTexts.some(t => t.startsWith('{"title"')),
    `block texts: ${JSON.stringify(cap.blockCompletedTexts)}`,
  )
}

// -----------------------------------------------------------------------------
// Case 5: defaulting behaviour — no `getSessionModel` callback at all.
// -----------------------------------------------------------------------------
//
// When no callback is configured, the filter must default to OFF
// (preserve existing behaviour for callers who haven't opted in).
// This protects against silently regressing other consumers when the
// new option ships.

function caseNoCallbackDefaultsOff(): void {
  console.log('\n── case: without getSessionModel callback the filter is inert ──')

  const channel = new SemanticChannel()
  const cap = attachCapture(channel)
  const adapter = new ClaudeProxyAdapter({ channel })

  driveFlow(adapter, {
    flowId: 'flow-haiku-no-config',
    messageId: 'msg_haiku_no_config',
    model: 'claude-haiku-4-5-20251001',
    text: '{"title": "Whatever"}',
  })

  assert(
    'turn_started still fires when no session model callback is configured',
    cap.turnStartedTurnIds.includes('msg_haiku_no_config'),
    `turn_started ids: ${JSON.stringify(cap.turnStartedTurnIds)}`,
  )
}

// -----------------------------------------------------------------------------
// Run.
// -----------------------------------------------------------------------------

caseSidecarHaikuFiltered()
caseRealSonnetPasses()
caseHaikuAsPrimaryModelPasses()
caseSequentialBundleReplay()
caseNoCallbackDefaultsOff()

console.log(`\n── ${passed} passed · ${failed} failed ──`)
if (failed > 0) process.exit(1)
