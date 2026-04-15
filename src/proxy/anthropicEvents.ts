// Anthropic SSE → typed event objects.
//
// Source-of-truth for the shapes below is the switch at
// claude-code-src/full/services/api/claude.ts:1980-2297. Every branch
// that Claude's own handler cares about is represented here; anything
// it throws `tengu_streaming_error` for is surfaced as a typed
// diagnostic. Unknown events become `{ type: 'other' }` so the stream
// keeps flowing even if Anthropic adds a new event type before we
// update this parser.
//
// Pure: no Node, no DOM, no IO.

import type { SseEvent } from './sseFraming.js'

// ---------------------------------------------------------------------------
// Content block shapes inside the stream.
// ---------------------------------------------------------------------------

/** Minimal shape of a content_block_start.content_block payload. We
 *  only type the fields we actually use downstream; everything else
 *  passes through as `unknown` so forward-compat surprises don't crash
 *  the parser. */
export type ParsedContentBlockStart = {
  /** Text, thinking, tool_use, server_tool_use, mcp_tool_use,
   *  connector_text, image, document, redacted_thinking, and any
   *  future/internal variants. We emit the raw string rather than
   *  narrowing, so forward additions flow through as `'other'` on
   *  the semantic channel. */
  type: string
  /** Present on tool_use / server_tool_use / mcp_tool_use. */
  id?: string
  /** Present on tool_use / server_tool_use / mcp_tool_use. */
  name?: string
  /** Any other fields the upstream carried. Intentionally untyped. */
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Typed event union.
// ---------------------------------------------------------------------------

export type AnthropicStreamEvent =
  | AnthropicMessageStart
  | AnthropicContentBlockStart
  | AnthropicTextDelta
  | AnthropicInputJsonDelta
  | AnthropicThinkingDelta
  | AnthropicSignatureDelta
  | AnthropicConnectorTextDelta
  | AnthropicCitationsDelta
  | AnthropicUnknownDelta
  | AnthropicContentBlockStop
  | AnthropicMessageDelta
  | AnthropicMessageStop
  | AnthropicPing
  | AnthropicErrorEvent
  | AnthropicOther

/** `message_start` — carries initial BetaMessage with id, model, and
 *  initial usage. Usage here is authoritative for input/cache tokens
 *  (see updateUsage guard at claude.ts:2932-2944 — output_tokens starts
 *  at 0 and is filled in by message_delta). */
export type AnthropicMessageStart = {
  type: 'message_start'
  messageId: string | null
  model: string | null
  /** Echo of upstream `message.usage`. Shape matches what
   *  `updateUsage` expects. All fields optional because the SDK is
   *  loose on what's populated initially. */
  usage?: AnthropicUsage
  raw: Record<string, unknown>
}

export type AnthropicContentBlockStart = {
  type: 'content_block_start'
  index: number
  block: ParsedContentBlockStart
  raw: Record<string, unknown>
}

export type AnthropicTextDelta = {
  type: 'text_delta'
  index: number
  text: string
  raw: Record<string, unknown>
}

export type AnthropicInputJsonDelta = {
  type: 'input_json_delta'
  index: number
  /** Raw JSON fragment — NOT necessarily valid JSON on its own.
   *  Consumers must accumulate across deltas and parse at block
   *  stop. Mirrors claude.ts:2111. */
  partialJson: string
  raw: Record<string, unknown>
}

export type AnthropicThinkingDelta = {
  type: 'thinking_delta'
  index: number
  thinking: string
  raw: Record<string, unknown>
}

export type AnthropicSignatureDelta = {
  type: 'signature_delta'
  index: number
  signature: string
  raw: Record<string, unknown>
}

/** Feature-gated in Claude Code (claude.ts:2066-2081). We surface it
 *  unconditionally — if the upstream emits it, we describe it. The
 *  adapter can choose to hide it from the screen channel. */
export type AnthropicConnectorTextDelta = {
  type: 'connector_text_delta'
  index: number
  connectorText: string
  raw: Record<string, unknown>
}

/** Recognized but not handled by Claude today (claude.ts:2084-2086 has
 *  a `// TODO: handle citations`). We forward them so a future
 *  renderer can implement them without touching this parser. */
export type AnthropicCitationsDelta = {
  type: 'citations_delta'
  index: number
  citation: unknown
  raw: Record<string, unknown>
}

/** A `content_block_delta` whose `delta.type` we don't recognise.
 *  Distinct from `other` so consumers can detect "new delta shape"
 *  specifically and alert on it. */
export type AnthropicUnknownDelta = {
  type: 'unknown_delta'
  index: number
  deltaType: string
  raw: Record<string, unknown>
}

export type AnthropicContentBlockStop = {
  type: 'content_block_stop'
  index: number
  raw: Record<string, unknown>
}

/** `message_delta` — carries final stop_reason and settled usage for
 *  the message. Arrives after the last `content_block_stop`. */
export type AnthropicMessageDelta = {
  type: 'message_delta'
  stopReason: string | null
  stopSequence: string | null
  usage?: AnthropicUsage
  raw: Record<string, unknown>
}

export type AnthropicMessageStop = {
  type: 'message_stop'
  raw: Record<string, unknown>
}

/** SSE keepalive. Consumers should ignore but we surface it so
 *  diagnostics can show "connection alive, nothing new". */
export type AnthropicPing = {
  type: 'ping'
  raw: Record<string, unknown>
}

/** `{"type":"error","error":{"type":"overloaded_error","message":"..."}}`
 *  — what the Anthropic server sends on stream-level error. The SDK
 *  re-throws as APIError; we surface it here for transparency. */
export type AnthropicErrorEvent = {
  type: 'error'
  errorType: string
  message: string
  raw: Record<string, unknown>
}

/** Anything that didn't match a known event. The stream keeps
 *  flowing; consumers can log and move on. */
export type AnthropicOther = {
  type: 'other'
  eventType: string
  raw: Record<string, unknown>
}

/** Permissive usage shape — every field optional because upstream
 *  variants populate different subsets depending on whether we're
 *  looking at `message_start.message.usage` (initial, full shape) or
 *  `message_delta.usage` (partial, only the things that changed). */
export type AnthropicUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation?: {
    ephemeral_1h_input_tokens?: number | null
    ephemeral_5m_input_tokens?: number | null
  } | null
  cache_deleted_input_tokens?: number | null
  service_tier?: string | null
  inference_geo?: string | null
  speed?: string | null
  iterations?: unknown
  server_tool_use?: {
    web_search_requests?: number | null
    web_fetch_requests?: number | null
  } | null
}

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

export function parseAnthropicEventsFromSse(
  records: SseEvent[],
): AnthropicStreamEvent[] {
  const out: AnthropicStreamEvent[] = []
  for (const rec of records) {
    const ev = parseOne(rec)
    if (ev) out.push(ev)
  }
  return out
}

function parseOne(rec: SseEvent): AnthropicStreamEvent | null {
  // `event:` is a hint; the real discriminant is `data.type` because
  // Anthropic sometimes sends a bare `event: message` with the type
  // inside. We parse data first, then fall back to the event name.
  if (rec.data === '' || rec.data === '[DONE]') return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rec.data) as Record<string, unknown>
  } catch {
    // Non-JSON data (shouldn't happen with Anthropic, but we're
    // defensive). Surface as `other` so callers can see the anomaly
    // without the parser crashing.
    return {
      type: 'other',
      eventType: rec.event,
      raw: { data: rec.data },
    }
  }

  const type = typeof parsed.type === 'string' ? parsed.type : rec.event

  switch (type) {
    case 'ping':
      return { type: 'ping', raw: parsed }

    case 'error': {
      const err = parsed.error as Record<string, unknown> | undefined
      return {
        type: 'error',
        errorType: typeof err?.type === 'string' ? err.type : 'unknown',
        message:
          typeof err?.message === 'string' ? err.message : 'Unknown error',
        raw: parsed,
      }
    }

    case 'message_start': {
      const msg = parsed.message as Record<string, unknown> | undefined
      return {
        type: 'message_start',
        messageId: typeof msg?.id === 'string' ? msg.id : null,
        model: typeof msg?.model === 'string' ? msg.model : null,
        usage: (msg?.usage as AnthropicUsage) ?? undefined,
        raw: parsed,
      }
    }

    case 'content_block_start': {
      const index =
        typeof parsed.index === 'number' ? parsed.index : -1
      const block =
        (parsed.content_block as ParsedContentBlockStart) ?? { type: 'other' }
      return {
        type: 'content_block_start',
        index,
        block,
        raw: parsed,
      }
    }

    case 'content_block_delta': {
      const index =
        typeof parsed.index === 'number' ? parsed.index : -1
      const delta = parsed.delta as Record<string, unknown> | undefined
      const deltaType = typeof delta?.type === 'string' ? delta.type : ''

      switch (deltaType) {
        case 'text_delta':
          return {
            type: 'text_delta',
            index,
            text: typeof delta?.text === 'string' ? delta.text : '',
            raw: parsed,
          }
        case 'input_json_delta':
          return {
            type: 'input_json_delta',
            index,
            partialJson:
              typeof delta?.partial_json === 'string' ? delta.partial_json : '',
            raw: parsed,
          }
        case 'thinking_delta':
          return {
            type: 'thinking_delta',
            index,
            thinking:
              typeof delta?.thinking === 'string' ? delta.thinking : '',
            raw: parsed,
          }
        case 'signature_delta':
          return {
            type: 'signature_delta',
            index,
            signature:
              typeof delta?.signature === 'string' ? delta.signature : '',
            raw: parsed,
          }
        case 'connector_text_delta':
          return {
            type: 'connector_text_delta',
            index,
            connectorText:
              typeof delta?.connector_text === 'string'
                ? delta.connector_text
                : '',
            raw: parsed,
          }
        case 'citations_delta':
          return {
            type: 'citations_delta',
            index,
            citation: delta?.citation,
            raw: parsed,
          }
        default:
          return {
            type: 'unknown_delta',
            index,
            deltaType,
            raw: parsed,
          }
      }
    }

    case 'content_block_stop': {
      const index =
        typeof parsed.index === 'number' ? parsed.index : -1
      return {
        type: 'content_block_stop',
        index,
        raw: parsed,
      }
    }

    case 'message_delta': {
      const delta = parsed.delta as Record<string, unknown> | undefined
      return {
        type: 'message_delta',
        stopReason:
          typeof delta?.stop_reason === 'string' ? delta.stop_reason : null,
        stopSequence:
          typeof delta?.stop_sequence === 'string' ? delta.stop_sequence : null,
        usage: (parsed.usage as AnthropicUsage) ?? undefined,
        raw: parsed,
      }
    }

    case 'message_stop':
      return { type: 'message_stop', raw: parsed }

    default:
      return {
        type: 'other',
        eventType: type,
        raw: parsed,
      }
  }
}
