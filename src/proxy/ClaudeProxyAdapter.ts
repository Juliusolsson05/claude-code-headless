// ClaudeProxyAdapter — consumes mitmproxy-captured transport events and
// drives the `SemanticChannel` with structured per-block events.
//
// This is the seam that makes proxy-based rendering possible. Upstream
// of this class: a proxy runtime (production or the experimental
// harness in src/testing/proxy-testing/) that surfaces transport-level
// events in the shape mitmAddon.py emits:
//
//   { kind: 'request',        flow_id, method, url, host, path, headers }
//   { kind: 'response-chunk', flow_id, chunk_b64, … }
//   { kind: 'response-end',   flow_id, … }
//   { kind: 'response',       flow_id, status_code, headers, body? }
//
// Downstream: SemanticChannel publish calls. The adapter never touches
// screen parsing, JSONL, or UI. It is the single place where SSE
// framing + Anthropic event semantics + turn attribution policy meet.
//
// WHY this is its own file instead of being folded into
// ClaudeCodeHeadless:
//
//   - It is the natural subsystem seam for proxy streaming. The top-
//     level class should stay provider-agnostic at this layer; the
//     adapter is where Anthropic-specific logic lives.
//   - Attribution policy is pluggable. Different deployments may want
//     different rules for "which /v1/messages flow is the visible
//     turn" (task #11). Keeping the adapter separate means we can
//     swap the policy without touching the channel surface.
//   - It is testable without a PTY. Feed it transport events, assert
//     on SemanticChannel emissions. Production wiring is incidental.

import { TextDecoder } from 'node:util'

import type { SemanticChannel } from '../channels/SemanticChannel.js'
import type {
  SemanticBlockKind,
  SemanticConfidence,
  StreamPhase,
} from '../channels/types.js'
import {
  parseAnthropicEventsFromSse,
  type AnthropicStreamEvent,
  type AnthropicUsage,
} from './anthropicEvents.js'
import { IncrementalSseParser } from './sseFraming.js'

// ---------------------------------------------------------------------------
// Transport event shape (matches mitmAddon.py JSONL output).
// ---------------------------------------------------------------------------

export type ProxyTransportEvent = {
  kind: 'request' | 'response' | 'response-chunk' | 'response-end'
  flow_id: number | string
  method?: string
  url?: string
  host?: string
  path?: string
  status_code?: number
  headers?: Record<string, string>
  /** Base64-encoded transport bytes on `response-chunk`. */
  chunk_b64?: string
  /** Final buffered body on `response`. Not consumed by this adapter —
   *  chunks are the single source of truth for streaming. Kept as
   *  input so callers can pass through a generic proxy stream without
   *  pre-filtering. */
  body?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Attribution policy.
// ---------------------------------------------------------------------------
//
// A single Claude turn can produce multiple /v1/messages flows (one
// per tool-use iteration), plus incidental flows (title generation,
// internal retries). This policy decides what to do with each flow.
//
//   'active'    — this flow is part of the visible assistant turn.
//                 Publish its events to the semantic channel.
//   'secondary' — recognised as a Claude flow but not the visible one
//                 (e.g. title generation). We still consume it so we
//                 can emit diagnostics, but no semantic events.
//   'ignore'    — not a /v1/messages flow at all. Drop entirely.
//
// Default policy (see `defaultAttributionPolicy` below) is the
// pragmatic "any /v1/messages flow is active" — correct for the MVP
// case where we're talking to one Claude process that isn't running
// title-generation concurrently. Task #11 replaces this with
// session-header + request-ordering correlation.

/** Four-state attribution lifecycle. A flow moves through these as
 *  we learn more about it:
 *
 *    request arrives  → 'candidate' (eligible, not yet streaming)
 *    first SSE chunk  → 'active' (promote — we know it's a live
 *                       stream, and no other flow held the slot)
 *                    OR 'secondary' (demote — another flow was
 *                       already streaming when our chunks arrived).
 *    response-end     → release the 'active' slot for the next flow.
 *
 *  Locking on first-chunk-arrival instead of at request time is what
 *  protects against Claude Code's auth/warmup preflight `POST
 *  /v1/messages` (non-streaming, tiny body, response Content-Type
 *  `application/json` not `text/event-stream`) stealing the slot
 *  from the real turn. The warmup never emits a `response-chunk`
 *  because the mitmproxy addon only streams-tap SSE responses, so
 *  its `candidate` status simply expires when the flow ends. */
export type FlowAttribution =
  | 'candidate'
  | 'active'
  | 'secondary'
  | 'ignore'

export type AttributionContext = {
  flowId: string
  method: string | undefined
  url: string | undefined
  host: string | undefined
  path: string | undefined
  headers: Record<string, string> | undefined
}

/** Attribution policy — decides whether a given `/v1/messages`
 *  request is even a CANDIDATE for the visible assistant turn. The
 *  policy is narrow by design: it only answers the yes/no question
 *  "could this be a real turn?" at request time. The adapter itself
 *  owns the "at most one active flow at a time" locking, keyed on
 *  first-chunk arrival — because that's the only reliable signal we
 *  have that a flow is genuinely SSE streaming and not a warmup /
 *  auth ping (which also POSTs /v1/messages but returns
 *  `application/json`, never streams, and whose mitmproxy addon
 *  consequently never emits `response-chunk` events for it).
 *
 *  Smarter policies (session-header correlation, prompt-ordering,
 *  subagent disambiguation) live inside a custom `classify`. The
 *  adapter's lock mechanism does not need to change for any of
 *  those. */
export type AttributionPolicy = {
  classify: (ctx: AttributionContext) => 'candidate' | 'ignore'
}

/** Default: accept any anthropic.com `/v1/messages` request as a
 *  candidate. The adapter will reject non-streaming ones automatically
 *  by virtue of never seeing a `response-chunk` for them. */
export function createDefaultAttributionPolicy(): AttributionPolicy {
  return {
    classify: ({ url, path, host }) => {
      const target = url ?? path ?? ''
      if (!target.includes('/v1/messages')) return 'ignore'
      // Strict host match so stray flows that mention /v1/messages
      // in a body or URL can't hijack the semantic channel.
      if (host && !host.endsWith('anthropic.com')) return 'ignore'
      return 'candidate'
    },
  }
}

/** Back-compat export. */
export const defaultAttributionPolicy: AttributionPolicy =
  createDefaultAttributionPolicy()

// ---------------------------------------------------------------------------
// Per-flow state.
// ---------------------------------------------------------------------------
//
// Each flow maintains its own decoder, SSE buffer, and per-block
// accumulators. That isolation matters: concurrent flows (title gen +
// main turn, or interleaved tool-use rounds) must not clobber one
// another's state. The adapter keeps a Map<flowId, FlowState> and
// drops entries on `response-end`.

// `text` blocks technically never carry signature or citations, but
// `content_block_stop` fires a single `publishBlockCompleted` call
// that unions text+connector_text, and `citations_delta` fires before
// we know which sub-kind the block is. Widening `text` with the
// optional fields keeps those call sites typechecking without branching
// on `kind` every time. The fields stay undefined on actual text blocks.
type BlockState =
  | {
      kind: 'text'
      index: number
      text: string
      signature?: string
      citations?: unknown[]
    }
  | {
      kind: 'connector_text'
      index: number
      text: string
      signature: string
      citations?: unknown[]
    }
  | { kind: 'thinking'; index: number; thinking: string; signature: string }
  | {
      kind: 'tool_use' | 'server_tool_use' | 'mcp_tool_use'
      index: number
      toolName: string
      toolUseId: string
      inputJson: string
    }
  | { kind: 'other'; index: number; rawType: string; citations?: unknown[] }

type FlowState = {
  flowId: string
  attribution: FlowAttribution
  url: string
  /** Anthropic message id from `message_start`. Becomes the
   *  `turnId` on the semantic channel. Present only after the first
   *  chunk has been parsed — transport-level events before that don't
   *  have a stable id yet. */
  turnId: string | null
  decoder: TextDecoder
  sseParser: IncrementalSseParser
  /** Per-block state keyed by upstream `index`. */
  blocks: Map<number, BlockState>
  /** Running text aggregate across ALL text blocks for `turn_delta`
   *  backward compat. */
  fullText: string
  /** Merged usage accumulated across message_start + message_delta,
   *  following claude.ts:2924 rules: `>0` guard for input/cache
   *  tokens, `??` merge for output/server/cache_creation. */
  usage: AnthropicUsage
  /** Set to true once we've emitted `turn_started` for this flow, so
   *  repeated message_start events (shouldn't happen, but defensive)
   *  don't fire a second start. */
  turnStarted: boolean
  /** Whether `turn_stopped` has been emitted. Guards against
   *  duplicate emission when response-end fires after an explicit
   *  message_delta. */
  turnStopped: boolean
  /** Tool-use blocks that finalised input during this flow, in the
   *  order their `content_block_stop` fired. Populated from the
   *  tool_use/server_tool_use/mcp_tool_use branch in
   *  applyAnthropicEvent so that at `message_stop` we can transition
   *  the phase to `awaiting-tool` with the earliest unresolved tool
   *  name/id. Intentionally separate from `blocks` (which is cleared
   *  on content_block_stop) because we need the info AFTER the block
   *  has finalised and been deleted from `blocks`. */
  pendingToolUses: Array<{ toolUseId: string; toolName: string }>
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export type ClaudeProxyAdapterOptions = {
  channel: SemanticChannel
  /** Custom attribution policy. Defaults to accepting any
   *  anthropic.com /v1/messages flow. */
  attributionPolicy?: AttributionPolicy
  /** Called with a short free-form string for every diagnostic-worthy
   *  adapter decision. Hook for logging; default is no-op. */
  onDiagnostic?: (message: string) => void
}

export class ClaudeProxyAdapter {
  private readonly channel: SemanticChannel
  private readonly policy: AttributionPolicy
  private readonly onDiagnostic: (message: string) => void
  private readonly flows = new Map<string, FlowState>()
  /** The id of the flow currently holding the "active streaming"
   *  lock. Null when no flow is streaming. A new candidate flow's
   *  first chunk promotes it to 'active' iff this is null; otherwise
   *  the new flow is demoted to 'secondary'. Released on
   *  response-end of whichever flow was holding it. */
  private activeStreamingFlowId: string | null = null

  constructor(options: ClaudeProxyAdapterOptions) {
    this.channel = options.channel
    // Each adapter gets its own policy instance by default so its
    // "one active flow at a time" state is not shared across
    // adapters in the same process. Callers that want shared state
    // across adapters can pass their own policy.
    this.policy = options.attributionPolicy ?? createDefaultAttributionPolicy()
    this.onDiagnostic = options.onDiagnostic ?? (() => {})
  }

  /** Entry point. Wire this to whichever proxy runtime emits
   *  transport events. */
  handleTransportEvent(event: ProxyTransportEvent): void {
    const flowId = String(event.flow_id ?? '')
    if (!flowId) return

    switch (event.kind) {
      case 'request':
        this.onRequest(flowId, event)
        return
      case 'response-chunk':
        this.onChunk(flowId, event)
        return
      case 'response-end':
        this.onEnd(flowId)
        return
      case 'response':
        // Buffered body is not consumed — chunks are the single
        // source of truth for streaming. We stay silent here instead
        // of logging a diagnostic for every flow: the proxy observes
        // dozens of non-/v1/messages flows per session (auth,
        // bootstrap, OAuth, MCP registry, telemetry) and logging
        // every one would drown any signal in noise.
        return
    }
  }

  /** Tear down all flow state. Call when the session ends. Clears
   *  the active-streaming lock so a stop→start cycle on the same
   *  process inherits a clean slate. */
  dispose(): void {
    this.flows.clear()
    this.activeStreamingFlowId = null
  }

  // -----------------------------------------------------------------------
  // Flow lifecycle.
  // -----------------------------------------------------------------------

  private onRequest(flowId: string, event: ProxyTransportEvent): void {
    const decision = this.policy.classify({
      flowId,
      method: event.method,
      url: event.url,
      host: event.host,
      path: event.path,
      headers: event.headers,
    })

    if (decision === 'ignore') {
      // Don't even record — not a Claude flow.
      return
    }

    // Every accepted request starts as 'candidate'. The promotion to
    // 'active' or demotion to 'secondary' happens at first-chunk
    // arrival, not here — see `onChunk`. This is what prevents
    // Claude Code's non-streaming auth/warmup POST /v1/messages
    // (which never produces chunks) from stealing the active slot
    // from the real turn.
    const state: FlowState = {
      flowId,
      attribution: 'candidate',
      url: event.url ?? '',
      turnId: null,
      decoder: new TextDecoder('utf-8'),
      sseParser: new IncrementalSseParser(),
      blocks: new Map(),
      fullText: '',
      usage: {},
      turnStarted: false,
      turnStopped: false,
      pendingToolUses: [],
    }
    this.flows.set(flowId, state)
    this.onDiagnostic(`flow ${flowId} accepted as candidate`)
  }

  private onChunk(flowId: string, event: ProxyTransportEvent): void {
    const state = this.flows.get(flowId)
    if (!state) return
    const b64 = event.chunk_b64
    if (typeof b64 !== 'string' || !b64) return

    // First-chunk promotion. Only SSE responses produce chunk events
    // (the mitmproxy addon gates its stream tap on response
    // Content-Type: text/event-stream), so arrival here is a
    // reliable "this is live streaming" signal — unlike the request
    // headers, which don't distinguish warmup from real turns.
    if (state.attribution === 'candidate') {
      if (this.activeStreamingFlowId === null) {
        this.activeStreamingFlowId = flowId
        state.attribution = 'active'
        this.channel.publishFlowSelected({
          turnId: null,
          flowId,
          reason: 'first-chunk (no competing active flow)',
          source: 'proxy',
          confidence: 'high',
        })
        // First-chunk promotion → emit 'requesting' with a null turnId.
        // We don't have the Anthropic `message_id` yet (it arrives on
        // the first `message_start` frame); the renderer treats a null
        // turnId phase as "attached to the current session, not a
        // specific turn" and upgrades it when the next phase event
        // arrives with a real turnId.
        this.publishPhase(state, 'requesting')
      } else {
        state.attribution = 'secondary'
        this.channel.publishFlowIgnored({
          flowId,
          reason: `concurrent with active flow ${this.activeStreamingFlowId}`,
          source: 'proxy',
          confidence: 'medium',
        })
      }
    }

    // Decode via streaming TextDecoder so multi-byte UTF-8 codepoints
    // that span transport chunks aren't corrupted. This is why the
    // proxy addon ships bytes as base64 rather than pre-decoded text —
    // you cannot safely split a UTF-8 stream on transport boundaries.
    const bytes = base64ToBytes(b64)
    const text = state.decoder.decode(bytes, { stream: true })
    const records = state.sseParser.append(text)
    if (records.length === 0) return

    const events = parseAnthropicEventsFromSse(records)
    for (const ev of events) {
      this.applyAnthropicEvent(state, ev)
    }
  }

  private onEnd(flowId: string): void {
    const state = this.flows.get(flowId)
    if (!state) return

    // Drain the streaming decoder (captures any trailing bytes that
    // were buffered waiting for a codepoint completion) then flush
    // the SSE framer for a possible final record.
    const tailText = state.decoder.decode()
    const tailRecords = [
      ...state.sseParser.append(tailText),
      ...state.sseParser.flush(),
    ]
    if (tailRecords.length > 0) {
      const events = parseAnthropicEventsFromSse(tailRecords)
      for (const ev of events) {
        this.applyAnthropicEvent(state, ev)
      }
    }

    // If the stream ended without an explicit message_delta, synthesise
    // a turn_stopped so the renderer can close out the live turn
    // instead of hanging on a never-terminating state. This is a soft
    // failure — mark it as medium confidence so consumers can tell.
    if (state.attribution === 'active' && state.turnStarted && !state.turnStopped) {
      this.channel.publishTurnStopped({
        turnId: state.turnId ?? flowId,
        stopReason: null,
        source: 'proxy',
        confidence: 'medium',
      })
      state.turnStopped = true
      // Turn-level completion (backward-compat aggregate).
      this.channel.finishTurn({
        turnId: state.turnId ?? flowId,
        fullText: state.fullText || undefined,
        source: 'proxy',
        confidence: 'medium',
      })
      // Stream died without a clean `message_delta`. Drop phase back to
      // idle — there's no recovery path on this flow. We do NOT
      // transition to `awaiting-tool` even if there are pending tool
      // uses, because the pending-tool tracker was populated from
      // content_block_stop; the runtime-side tool executor may never
      // have received the tool_use (we died mid-stream), so promising
      // the user "waiting for the tool" would be incorrect.
      if (state.attribution === 'active') {
        this.publishPhase(state, 'idle')
      }
    }

    this.flows.delete(flowId)
    // Release the active-streaming lock so the next candidate flow
    // (typically a tool-use iteration) can be promoted. Guarded on
    // identity: flows that ended without ever chunking (warmups)
    // won't have taken the lock in the first place.
    if (this.activeStreamingFlowId === flowId) {
      this.activeStreamingFlowId = null
    }
  }

  // -----------------------------------------------------------------------
  // Anthropic event routing.
  // -----------------------------------------------------------------------

  private applyAnthropicEvent(
    state: FlowState,
    ev: AnthropicStreamEvent,
  ): void {
    // We consume events from secondary flows silently — just enough to
    // drain the buffer. Only active flows drive the channel.
    const isActive = state.attribution === 'active'
    const source = 'proxy' as const
    const confidence: SemanticConfidence = 'high'

    switch (ev.type) {
      case 'ping':
        return

      case 'error': {
        if (!isActive) return
        this.channel.publishApiError({
          turnId: state.turnId,
          errorType: ev.errorType,
          message: ev.message,
          isOverloaded: ev.errorType === 'overloaded_error',
          source,
          confidence,
        })
        // API error terminates the active turn from the adapter's
        // point of view. We don't attempt to preserve awaiting-tool
        // state because the failure happened BEFORE we got whatever
        // tool results would have arrived.
        this.publishPhase(state, 'idle')
        return
      }

      case 'message_start': {
        // Use Anthropic's message id as the canonical turnId. It
        // outlasts the transport flow and aligns with what JSONL will
        // later confirm (JSONL uses its own uuids; the reconciler
        // downstream maps between them).
        if (!ev.messageId) return
        state.turnId = ev.messageId
        if (ev.usage) state.usage = mergeUsage(state.usage, ev.usage)

        if (isActive && !state.turnStarted) {
          this.channel.startTurn({
            turnId: ev.messageId,
            role: 'assistant',
            source,
            confidence,
          })
          state.turnStarted = true

          // Re-emit `requesting` now that we have a real turnId. The
          // channel's phase dedupe would swallow a no-op `requesting`
          // repeat, but the turnId has changed from null → ev.messageId
          // so this event carries new information.
          this.publishPhase(state, 'requesting')

          // Initial usage snapshot. Always publish even when empty —
          // consumers can show "0 tokens input so far" before the
          // first delta lands.
          this.channel.publishUsageUpdated({
            turnId: ev.messageId,
            usage: coerceUsageForPublish(state.usage),
            source,
            confidence,
          })
        }
        return
      }

      case 'content_block_start': {
        if (state.turnId === null) {
          this.softError(state, 'content_block_start before message_start')
          return
        }
        const kind = classifyBlockKind(ev.block.type)
        // Initialise per-block accumulator matching
        // claude.ts:1995-2052 semantics.
        switch (kind) {
          case 'text':
            state.blocks.set(ev.index, {
              kind: 'text',
              index: ev.index,
              // Upstream quirk (claude.ts:2022-2027): content_block_start
              // may carry initial text that is duplicated in the first
              // text_delta. Claude strips it; we mirror.
              text: '',
            })
            break
          case 'connector_text':
            state.blocks.set(ev.index, {
              kind: 'connector_text',
              index: ev.index,
              text: '',
              signature: '',
              citations: [],
            })
            break
          case 'thinking':
            state.blocks.set(ev.index, {
              kind: 'thinking',
              index: ev.index,
              thinking: '',
              signature: '',
            })
            break
          case 'tool_use':
          case 'server_tool_use':
          case 'mcp_tool_use':
            state.blocks.set(ev.index, {
              kind,
              index: ev.index,
              toolName: typeof ev.block.name === 'string' ? ev.block.name : '',
              toolUseId: typeof ev.block.id === 'string' ? ev.block.id : '',
              inputJson: '',
            })
            break
          default:
            state.blocks.set(ev.index, {
              kind: 'other',
              index: ev.index,
              rawType: ev.block.type,
            })
            break
        }

        if (isActive) {
          const block = state.blocks.get(ev.index)
          this.channel.publishBlockStarted({
            turnId: state.turnId,
            blockIndex: ev.index,
            kind,
            toolName:
              block && 'toolName' in block ? block.toolName : undefined,
            toolUseId:
              block && 'toolUseId' in block ? block.toolUseId : undefined,
            source,
            confidence,
          })

          // Phase transition — mirrors upstream handleMessageFromStream
          // switch (utils/messages.ts:2929). content_block_start is the
          // only place a phase can enter `thinking` / `responding` /
          // `tool-input`; later deltas don't change the phase.
          switch (kind) {
            case 'text':
            case 'connector_text':
              this.publishPhase(state, 'responding')
              break
            case 'thinking':
            case 'redacted_thinking':
              this.publishPhase(state, 'thinking')
              break
            case 'tool_use':
            case 'server_tool_use':
            case 'mcp_tool_use': {
              const toolName =
                block && 'toolName' in block ? block.toolName : undefined
              const toolUseId =
                block && 'toolUseId' in block ? block.toolUseId : undefined
              this.publishPhase(state, 'tool-input', { toolName, toolUseId })
              break
            }
            // 'other' (unknown block kinds), 'image', 'document',
            // 'tool_result', etc. don't map to a user-visible phase —
            // leave the current phase in place.
          }
        }
        return
      }

      case 'text_delta': {
        const block = state.blocks.get(ev.index)
        if (!block || block.kind !== 'text') {
          this.softError(
            state,
            `text_delta for non-text block at index ${ev.index}`,
          )
          return
        }
        block.text += ev.text
        state.fullText += ev.text
        if (isActive && state.turnId) {
          this.channel.publishTextDelta({
            turnId: state.turnId,
            blockIndex: ev.index,
            textDelta: ev.text,
            textSoFar: block.text,
            source,
            confidence,
          })
          // Keep the turn-level aggregate flowing so consumers that
          // only care about text (screen fallback callers, simple
          // cards) keep working without subscribing to block events.
          this.channel.applyDelta({
            turnId: state.turnId,
            fullText: state.fullText,
            textDelta: ev.text,
            source,
            confidence,
          })
        }
        return
      }

      case 'thinking_delta': {
        const block = state.blocks.get(ev.index)
        if (!block || block.kind !== 'thinking') {
          this.softError(
            state,
            `thinking_delta for non-thinking block at index ${ev.index}`,
          )
          return
        }
        block.thinking += ev.thinking
        if (isActive && state.turnId) {
          this.channel.publishThinkingDelta({
            turnId: state.turnId,
            blockIndex: ev.index,
            thinkingDelta: ev.thinking,
            thinkingSoFar: block.thinking,
            source,
            confidence,
          })
        }
        return
      }

      case 'signature_delta': {
        const block = state.blocks.get(ev.index)
        if (!block || block.kind !== 'thinking') {
          // Signature can also apply to feature-gated connector_text
          // blocks which we classify as 'other'. Not an error; just
          // skip.
          return
        }
        block.signature = ev.signature
        if (isActive && state.turnId) {
          this.channel.publishSignature({
            turnId: state.turnId,
            blockIndex: ev.index,
            signature: ev.signature,
            source,
            confidence,
          })
        }
        return
      }

      case 'connector_text_delta': {
        const block = state.blocks.get(ev.index)
        if (!block || block.kind !== 'connector_text') {
          this.softError(
            state,
            `connector_text_delta for non-connector block at index ${ev.index}`,
          )
          return
        }
        block.text += ev.connectorText
        if (isActive && state.turnId) {
          this.channel.publishConnectorTextDelta({
            turnId: state.turnId,
            blockIndex: ev.index,
            connectorTextDelta: ev.connectorText,
            connectorTextSoFar: block.text,
            source,
            confidence,
          })
        }
        return
      }

      case 'input_json_delta': {
        const block = state.blocks.get(ev.index)
        if (
          !block ||
          (block.kind !== 'tool_use' &&
            block.kind !== 'server_tool_use' &&
            block.kind !== 'mcp_tool_use')
        ) {
          this.softError(
            state,
            `input_json_delta for non-tool block at index ${ev.index}`,
          )
          return
        }
        block.inputJson += ev.partialJson
        if (isActive && state.turnId) {
          this.channel.publishToolInputDelta({
            turnId: state.turnId,
            blockIndex: ev.index,
            toolName: block.toolName,
            toolUseId: block.toolUseId,
            partialJson: ev.partialJson,
            inputJsonSoFar: block.inputJson,
            source,
            confidence,
          })
        }
        return
      }

      case 'citations_delta': {
        const block = state.blocks.get(ev.index)
        if (!block) {
          this.softError(
            state,
            `citations_delta for unknown block at index ${ev.index}`,
          )
          return
        }
        // Citations only apply to text / connector_text / other. Thinking
        // and tool_use blocks never receive citations per Anthropic's
        // stream schema, so narrow before writing. Hitting the default
        // branch with a thinking/tool_use block is a protocol violation
        // upstream; soft-error rather than silently corrupting state.
        if (
          block.kind !== 'text' &&
          block.kind !== 'connector_text' &&
          block.kind !== 'other'
        ) {
          this.softError(
            state,
            `citations_delta on ${block.kind} block at index ${ev.index}`,
          )
          return
        }
        block.citations = [...(block.citations ?? []), ev.citation]
        if (isActive && state.turnId) {
          this.channel.publishCitationsDelta({
            turnId: state.turnId,
            blockIndex: ev.index,
            citationsDelta: ev.citation,
            citationsSoFar: [...block.citations],
            source,
            confidence,
          })
        }
        return
      }

      case 'unknown_delta':
        // Forward-compat path. We know the delta happened but don't
        // yet have a richer channel-level representation for it.
        return

      case 'content_block_stop': {
        const block = state.blocks.get(ev.index)
        if (!block) {
          this.softError(state, `content_block_stop for unknown index ${ev.index}`)
          return
        }
        if (!isActive || !state.turnId) {
          state.blocks.delete(ev.index)
          return
        }

        switch (block.kind) {
          case 'text':
          case 'connector_text':
            this.channel.publishBlockCompleted({
              turnId: state.turnId,
              blockIndex: ev.index,
              kind: block.kind,
              text: block.text,
              signature: block.signature,
              raw:
                block.kind === 'connector_text' && block.citations?.length
                  ? { citations: block.citations }
                  : undefined,
              source,
              confidence,
            })
            break
          case 'thinking':
            this.channel.publishBlockCompleted({
              turnId: state.turnId,
              blockIndex: ev.index,
              kind: 'thinking',
              text: block.thinking,
              signature: block.signature,
              source,
              confidence,
            })
            break
          case 'tool_use':
          case 'server_tool_use':
          case 'mcp_tool_use': {
            // Mirrors normalizeContentFromAPI at claude.ts:2195 — the
            // accumulated string is parsed. Failures are non-fatal:
            // we still emit `tool_input_finalized` with parsed=undef
            // and a parseError so the renderer can show an error
            // state instead of a silent partial.
            const { parsed, parseError } = tryParseJson(block.inputJson)
            this.channel.publishToolInputFinalized({
              turnId: state.turnId,
              blockIndex: ev.index,
              toolName: block.toolName,
              toolUseId: block.toolUseId,
              inputJson: block.inputJson,
              parsed,
              parseError,
              source,
              confidence,
            })
            this.channel.publishBlockCompleted({
              turnId: state.turnId,
              blockIndex: ev.index,
              kind: block.kind,
              toolName: block.toolName,
              toolUseId: block.toolUseId,
              inputJson: block.inputJson,
              parsed,
              source,
              confidence,
            })
            // Record the pending tool-use so message_delta / onEnd can
            // transition to `awaiting-tool` with a concrete id.
            if (block.toolUseId) {
              state.pendingToolUses.push({
                toolUseId: block.toolUseId,
                toolName: block.toolName,
              })
            }
            break
          }
          case 'other':
            this.channel.publishBlockCompleted({
              turnId: state.turnId,
              blockIndex: ev.index,
              kind: 'other',
              raw: { type: block.rawType },
              source,
              confidence,
            })
            break
        }
        state.blocks.delete(ev.index)
        return
      }

      case 'message_delta': {
        if (ev.usage) state.usage = mergeUsage(state.usage, ev.usage)
        if (!isActive || !state.turnId) return

        // Usage published before stop_reason so a consumer that treats
        // turn_stopped as a terminal signal has the final usage on
        // hand when it fires.
        this.channel.publishUsageUpdated({
          turnId: state.turnId,
          usage: coerceUsageForPublish(state.usage),
          source,
          confidence,
        })

        const stopReason = normaliseStopReason(ev.stopReason)
        const synthetic = syntheticErrorForStopReason(stopReason)
        this.channel.publishTurnStopped({
          turnId: state.turnId,
          stopReason,
          syntheticErrorText: synthetic,
          source,
          confidence,
        })
        state.turnStopped = true

        // Turn-level completion aggregate. Content is whatever text
        // we've accumulated across all text blocks. Tool-only turns
        // (no text blocks) complete with undefined fullText, which is
        // correct — there's nothing to render for a pure tool turn on
        // the legacy turn_delta channel.
        this.channel.finishTurn({
          turnId: state.turnId,
          fullText: state.fullText || undefined,
          source,
          confidence,
        })

        // Phase terminal transition.
        //   - If tool_use blocks were produced this turn, they have no
        //     tool_result yet (results land on the committed / JSONL
        //     channel, not this flow). Transition to `awaiting-tool`
        //     with the earliest pending tool — that's the one the
        //     runtime is working on first. The renderer clears this
        //     when the matching `tool_result` event arrives.
        //   - Otherwise the turn is done and the session is idle.
        if (state.pendingToolUses.length > 0) {
          const first = state.pendingToolUses[0]!
          this.publishPhase(state, 'awaiting-tool', {
            toolName: first.toolName,
            toolUseId: first.toolUseId,
          })
        } else {
          this.publishPhase(state, 'idle')
        }
        return
      }

      case 'message_stop':
        // Terminal marker. We've already fired `turn_stopped` on
        // `message_delta`; nothing to do here.
        return

      case 'other':
        // Unknown top-level event. Ignore — don't spam diagnostics for
        // things we don't understand; the consumer can hook raw
        // transport if they care.
        return
    }
  }

  private softError(state: FlowState, message: string): void {
    this.channel.publishStreamError({
      turnId: state.turnId,
      errorType: 'adapter_defensive',
      message,
      source: 'proxy',
      confidence: 'medium',
    })
    this.onDiagnostic(message)
  }

  /** Emit a stream-phase event on behalf of this flow, but ONLY if the
   *  flow is the active producer. Secondary flows must stay silent so
   *  a concurrent warmup or retry can't flip the renderer's phase
   *  mid-turn. Channel-level dedupe (see `SemanticChannel.publishStreamPhase`)
   *  swallows no-op transitions, so we don't bother guarding here. */
  private publishPhase(
    state: FlowState,
    phase: StreamPhase,
    extras: { toolName?: string; toolUseId?: string } = {},
  ): void {
    if (state.attribution !== 'active') return
    this.channel.publishStreamPhase({
      turnId: state.turnId,
      phase,
      toolName: extras.toolName,
      toolUseId: extras.toolUseId,
      source: 'proxy',
      confidence: 'high',
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function classifyBlockKind(raw: string): SemanticBlockKind {
  switch (raw) {
    case 'text':
    case 'thinking':
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
    case 'connector_text':
    case 'redacted_thinking':
    case 'image':
    case 'document':
    case 'tool_result':
    case 'web_search_tool_result':
    case 'code_execution_tool_result':
    case 'container_upload':
      return raw
    default:
      return 'other'
  }
}

function normaliseStopReason(
  raw: string | null,
): SemanticTurnStopReason {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'pause_turn':
    case 'refusal':
    case 'stop_sequence':
      return raw
    default:
      return null
  }
}

type SemanticTurnStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'model_context_window_exceeded'
  | 'pause_turn'
  | 'refusal'
  | 'stop_sequence'
  | null

function syntheticErrorForStopReason(
  reason: SemanticTurnStopReason,
): string | undefined {
  // Text mirrors what Claude itself yields (claude.ts:2270-2291 and
  // errors.ts:1184-1206). We surface it here so the renderer doesn't
  // have to branch on stop_reason to produce an error card —
  // consumers that want the text get it for free; consumers that
  // want to render their own branching can ignore this field.
  switch (reason) {
    case 'max_tokens':
      return (
        "API Error: Claude's response exceeded the output token " +
        'maximum. To configure this behavior, set the ' +
        'CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.'
      )
    case 'model_context_window_exceeded':
      return 'API Error: The model has reached its context window limit.'
    case 'refusal':
      return (
        'API Error: Claude Code is unable to respond to this request, ' +
        'which appears to violate our Usage Policy ' +
        '(https://www.anthropic.com/legal/aup).'
      )
    default:
      return undefined
  }
}

function mergeUsage(prev: AnthropicUsage, next: AnthropicUsage): AnthropicUsage {
  // Mirrors the `updateUsage` rules in claude.ts:2924. `>0` guard for
  // input/cache tokens so message_delta's explicit 0 doesn't clobber
  // the real value from message_start. `??` merge for output/server
  // fields because message_delta is authoritative there.
  const guard = (
    newVal: number | null | undefined,
    oldVal: number | null | undefined,
  ): number | undefined =>
    newVal != null && newVal > 0 ? newVal : oldVal ?? undefined

  return {
    input_tokens: guard(next.input_tokens, prev.input_tokens),
    output_tokens: next.output_tokens ?? prev.output_tokens,
    cache_creation_input_tokens: guard(
      next.cache_creation_input_tokens,
      prev.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: guard(
      next.cache_read_input_tokens,
      prev.cache_read_input_tokens,
    ),
    cache_creation: {
      ephemeral_1h_input_tokens:
        next.cache_creation?.ephemeral_1h_input_tokens ??
        prev.cache_creation?.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        next.cache_creation?.ephemeral_5m_input_tokens ??
        prev.cache_creation?.ephemeral_5m_input_tokens,
    },
    cache_deleted_input_tokens: guard(
      next.cache_deleted_input_tokens,
      prev.cache_deleted_input_tokens,
    ),
    service_tier: next.service_tier ?? prev.service_tier,
    inference_geo: next.inference_geo ?? prev.inference_geo,
    speed: next.speed ?? prev.speed,
    iterations: next.iterations ?? prev.iterations,
    server_tool_use: {
      web_search_requests:
        next.server_tool_use?.web_search_requests ??
        prev.server_tool_use?.web_search_requests,
      web_fetch_requests:
        next.server_tool_use?.web_fetch_requests ??
        prev.server_tool_use?.web_fetch_requests,
    },
  }
}

/** Flatten the permissive AnthropicUsage into the shape
 *  SemanticUsageEvent declares (null → undefined). */
function coerceUsageForPublish(u: AnthropicUsage) {
  const denull = <T>(v: T | null | undefined): T | undefined =>
    v == null ? undefined : v
  return {
    input_tokens: denull(u.input_tokens),
    output_tokens: denull(u.output_tokens),
    cache_creation_input_tokens: denull(u.cache_creation_input_tokens),
    cache_read_input_tokens: denull(u.cache_read_input_tokens),
    cache_creation: u.cache_creation
      ? {
          ephemeral_1h_input_tokens: denull(
            u.cache_creation.ephemeral_1h_input_tokens,
          ),
          ephemeral_5m_input_tokens: denull(
            u.cache_creation.ephemeral_5m_input_tokens,
          ),
        }
      : undefined,
    cache_deleted_input_tokens: denull(u.cache_deleted_input_tokens),
    service_tier: denull(u.service_tier),
    inference_geo: denull(u.inference_geo),
    speed: denull(u.speed),
    server_tool_use: u.server_tool_use
      ? {
          web_search_requests: denull(u.server_tool_use.web_search_requests),
          web_fetch_requests: denull(u.server_tool_use.web_fetch_requests),
        }
      : undefined,
  }
}

function tryParseJson(raw: string): {
  parsed: Record<string, unknown> | undefined
  parseError?: string
} {
  if (!raw) return { parsed: {} }
  try {
    const v = JSON.parse(raw)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return { parsed: v as Record<string, unknown> }
    }
    return { parsed: undefined, parseError: 'tool input is not a JSON object' }
  } catch (err) {
    return {
      parsed: undefined,
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Base64 → Uint8Array. Using Buffer when available so Node's
 *  native implementation wins; falling back to atob for browser/
 *  worker contexts. */
function base64ToBytes(b64: string): Uint8Array {
  if (
    typeof globalThis !== 'undefined' &&
    (globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } })
      .Buffer
  ) {
    const Buf = (globalThis as unknown as {
      Buffer: { from(s: string, enc: string): Uint8Array }
    }).Buffer
    return Buf.from(b64, 'base64')
  }
  // Browser path — atob yields a binary string; convert to Uint8Array.
  const atobFn = (globalThis as unknown as { atob?: (s: string) => string })
    .atob
  if (!atobFn) throw new Error('no base64 decoder available')
  const binary = atobFn(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
