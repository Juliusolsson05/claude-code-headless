// Three-channel truth model for claude-code-headless.
//
// WHY this exists:
//
// Historically every observation surfaced from this package — screen
// snapshots, JSONL transcript entries, activity state, trust overlays —
// arrived as one flat event stream. Consumers were forced to interpret
// that stream themselves: "is this live assistant text? is this a
// confirmed commit? is this just visual chrome I should mirror?"
//
// That worked when the ONLY source of live assistant truth was screen
// parsing. Once proxy streaming becomes viable (see PROXY_STREAMING.md
// in this package), there are suddenly MULTIPLE sources of live
// semantic truth (proxy stream deltas vs. screen scrapes), plus durable
// truth (JSONL) that should reconcile against both. A single flat event
// surface makes that impossible to model cleanly.
//
// So we split the surface into three distinct channels with different
// purposes:
//
//   semantic  — provider meaning (what the model is producing)
//   screen    — visual terminal truth (what the user sees)
//   committed — durable history (what persistence confirmed)
//
// The channels DO NOT replace each other. They are kept separate on
// purpose so downstream consumers can decide which source to render
// from and never accidentally blur "I saw it on the terminal" with
// "the provider said it happened". See README / PROXY_STREAMING.md for
// the full rationale.
//
// Pure types only — no runtime, no Node, no DOM.

import type { Entry } from '../transcript/TranscriptTypes.js'
import type { CompactionState } from '../parsers/CompactionParser.js'
import type { ResumePromptState } from '../parsers/ResumePromptParser.js'
import type { SlashPickerState } from '../parsers/SlashPickerParser.js'
import type { TrustDialogState } from '../parsers/TrustDialogParser.js'

// ---------------------------------------------------------------------------
// Provenance tags shared across events.
// ---------------------------------------------------------------------------

/** Which raw source produced a semantic event. Every semantic event
 *  MUST carry this so the consumer knows how much to trust the payload
 *  (proxy > jsonl > screen) and can choose its rendering strategy —
 *  aggressive markdown reflow on proxy deltas, conservative on screen
 *  fallback scrapes. Not carrying this field was the original sin that
 *  made live vs. committed impossible to separate downstream. */
export type SemanticSource = 'proxy' | 'jsonl' | 'screen'

/** Trust tag layered on top of source.
 *
 *  high     — source is authoritative (proxy delta, committed JSONL).
 *  medium   — source is correct but indirect (e.g. JSONL partial).
 *  fallback — semantic meaning was INFERRED from a visual surface.
 *             Correct most of the time, wrong enough of the time that
 *             the consumer should be defensive (no destructive writes
 *             keyed on the content, no markdown escapes the fallback
 *             can get wrong). */
export type SemanticConfidence = 'high' | 'medium' | 'fallback'

// ---------------------------------------------------------------------------
// Semantic channel — "what is the model doing right now".
// ---------------------------------------------------------------------------
//
// This channel is intentionally stream-shaped. Events are strictly
// ordered per `turnId` and describe a lifecycle the consumer can
// rebuild by folding deltas. Consumers that want JIT markdown rendering
// should subscribe to `turn_delta` only and ignore the rest.
//
// Design rule: this channel MUST NOT emit trust dialogs, picker state,
// compaction UI, or any other visual-only surface. Those belong on the
// screen channel. If a UI element is not part of "the model produced
// this", it does not belong here.

export type SemanticTurnStartedEvent = {
  type: 'turn_started'
  turnId: string
  /** Hints the renderer with the role even though only assistant turns
   *  emit deltas on this channel. User-turn starts are still useful
   *  so the consumer can clear a pending "live turn" view. */
  role: 'user' | 'assistant'
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticTurnDeltaEvent = {
  type: 'turn_delta'
  turnId: string
  /** Incremental piece that arrived with this event. May be empty if
   *  the source only publishes snapshots — consumers should prefer
   *  `fullText` when `textDelta` is absent. */
  textDelta?: string
  /** Full running text for the turn as known at this point. Always
   *  present so a late subscriber can catch up without replaying all
   *  deltas. Screen-sourced events populate this from the in-progress
   *  extractor; proxy-sourced events populate it by accumulating
   *  upstream text_delta blocks. */
  fullText: string
  /** Same text rendered with terminal attributes reconstructed as
   *  markdown (bold/italic cells turned into asterisks/underscores)
   *  when the source can provide it. Screen-source populates this
   *  from HeadlessTerminal's markdown snapshot; proxy-source can
   *  leave it unset because upstream bytes are already markdown. */
  markdownText?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticTurnCompletedEvent = {
  type: 'turn_completed'
  turnId: string
  /** Final settled text for the turn. For JSONL-sourced completions
   *  this is the committed assistant text; for screen-sourced
   *  completions this is the last in-progress snapshot before idle. */
  fullText?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Emitted when the authoritative source for the current live turn
 *  changes — e.g. we were falling back to screen and proxy started
 *  delivering authoritative deltas. Consumers can use this to reset
 *  any optimistic state that was based on the lower-trust source. */
export type SemanticSourceChangedEvent = {
  type: 'source_changed'
  turnId: string | null
  previousSource: SemanticSource | null
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Block-level semantic events.
// ---------------------------------------------------------------------------
//
// The Anthropic stream is block-structured: one message contains N
// content blocks (text, thinking, tool_use, …) in declared order. The
// turn-level aggregate above (`turn_delta.fullText`) is fine for a plain
// text card but destroys structure — it cannot represent "text, then a
// tool call, then more text, then another tool call" the way Claude
// Code's own TUI does. So we emit per-block events alongside the
// turn-level stream, and consumers pick the granularity they need:
//
//   - a markdown card listens to `turn_delta` and ignores blocks
//   - a full reader listens to `block_*` to render per-block UI
//
// Block indices match the upstream `index` field one-to-one so the
// renderer can place blocks in the order Claude produced them, even
// when deltas arrive interleaved.
//
// Source-of-truth for the shapes below: claude-code-src/full/services/
// api/claude.ts switch in `content_block_start` (line 1995) and
// `content_block_delta` (line 2053). Anything the upstream handler
// cares about we must be able to represent here.

/** Minimal block-identity payload carried on every block event. */
export type SemanticBlockRef = {
  turnId: string
  /** Upstream `index` field — stable within a turn, used to
   *  correlate `started` / `delta` / `completed` for the same block
   *  and to preserve ordering across interleaved deltas. */
  blockIndex: number
}

/** Block kinds the semantic channel knows how to describe. Mirrors the
 *  upstream content_block_start switch in claude.ts:1995-2052. Unknown
 *  types (future block variants) are surfaced as `'other'` so the
 *  channel keeps flowing instead of silently dropping them — the
 *  consumer can still see them happened and fall back to screen. */
export type SemanticBlockKind =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'server_tool_use'
  | 'mcp_tool_use'
  | 'connector_text'
  | 'redacted_thinking'
  | 'image'
  | 'document'
  | 'tool_result'
  | 'web_search_tool_result'
  | 'code_execution_tool_result'
  | 'container_upload'
  | 'other'

/** Emitted at `content_block_start` for every block in the turn. For
 *  tool_use/server_tool_use/mcp_tool_use blocks this is where the
 *  renderer learns the tool name + id before input streaming begins. */
export type SemanticBlockStartedEvent = SemanticBlockRef & {
  type: 'block_started'
  kind: SemanticBlockKind
  /** For tool_use / server_tool_use / mcp_tool_use: the declared
   *  tool name (e.g. "Bash", "Read", "mcp__server__tool"). */
  toolName?: string
  /** For tool_use / server_tool_use / mcp_tool_use: the upstream
   *  tool_use_id. Consumers pair this against later tool_result
   *  events from the committed channel. */
  toolUseId?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Text content deltas on a `text` block. */
export type SemanticTextDeltaEvent = SemanticBlockRef & {
  type: 'text_delta'
  textDelta: string
  /** Running accumulator for the block. Populated so a late subscriber
   *  can jump in without replaying. */
  textSoFar: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Thinking deltas on a `thinking` block. Hidden by default in Claude
 *  Code's own TUI unless verbose/transcript, but exposed here so the
 *  renderer can choose to show or collapse. */
export type SemanticThinkingDeltaEvent = SemanticBlockRef & {
  type: 'thinking_delta'
  thinkingDelta: string
  thinkingSoFar: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Signature arrival on a `thinking` (or feature-gated
 *  `connector_text`) block. Signatures replace — they do not append —
 *  so we only carry the latest value. */
export type SemanticSignatureEvent = SemanticBlockRef & {
  type: 'signature'
  signature: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Delta on a `connector_text` block. Upstream treats this as a
 *  sibling of `text_delta`, but Claude Code currently feature-gates
 *  the UI. We still surface it so consumers can preserve the shape. */
export type SemanticConnectorTextDeltaEvent = SemanticBlockRef & {
  type: 'connector_text_delta'
  connectorTextDelta: string
  connectorTextSoFar: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Citation metadata attached to a `connector_text` block. Anthropic
 *  emits these today; Claude Code recognises the delta family but
 *  leaves TODO handling upstream. We forward the raw payload so app
 *  code can retain it without guessing future shape details. */
export type SemanticCitationsDeltaEvent = SemanticBlockRef & {
  type: 'citations_delta'
  citationsDelta: unknown
  citationsSoFar: unknown[]
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Partial tool input as raw JSON fragment. Fires on every
 *  `input_json_delta`. `partialJson` is the raw string Claude
 *  accumulates (claude.ts:2111) and may be invalid JSON mid-stream —
 *  the renderer should treat it as preview-only until
 *  `tool_input_finalized` fires. */
export type SemanticToolInputDeltaEvent = SemanticBlockRef & {
  type: 'tool_input_delta'
  toolName: string
  toolUseId: string
  /** Raw partial JSON fragment from this delta. */
  partialJson: string
  /** Full accumulator so far. String — not parsed. */
  inputJsonSoFar: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Tool input is finalized at `content_block_stop`. The string
 *  accumulator is parsed into an object (mirrors
 *  `normalizeContentFromAPI` at claude.ts:2195). If parsing fails we
 *  still emit with `parsed: undefined` plus `parseError` so the
 *  consumer can render an error state instead of hanging on a
 *  partial. */
export type SemanticToolInputFinalizedEvent = SemanticBlockRef & {
  type: 'tool_input_finalized'
  toolName: string
  toolUseId: string
  inputJson: string
  parsed: Record<string, unknown> | undefined
  parseError?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Emitted at `content_block_stop` for any block. Carries the final
 *  shape of the block so a subscriber that missed earlier deltas can
 *  still render it from one event. */
export type SemanticBlockCompletedEvent = SemanticBlockRef & {
  type: 'block_completed'
  kind: SemanticBlockKind
  /** Final text / thinking / input / etc. Keyed by kind:
   *   - text  → `text`
   *   - thinking → `text` (thinking content) + `signature`
   *   - tool_use / server_tool_use / mcp_tool_use → `toolName`,
   *     `toolUseId`, `inputJson`, `parsed`
   *   - anything else → `raw` containing the full upstream block. */
  text?: string
  signature?: string
  toolName?: string
  toolUseId?: string
  inputJson?: string
  parsed?: Record<string, unknown>
  raw?: Record<string, unknown>
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Tool-result linkage.
// ---------------------------------------------------------------------------
//
// Tool results don't arrive on the Anthropic stream — they arrive in
// the NEXT user turn (committed channel). We re-surface them here so
// renderers that listen to the semantic channel can pair them to the
// tool_use block that produced them without having to also wire up
// the committed channel themselves.

export type SemanticToolResultEvent = {
  type: 'tool_result'
  /** The turn the tool_use belonged to — not the current user turn
   *  that carried the result. This is what the renderer uses to
   *  place the result under the originating tool_use. */
  turnId: string
  toolUseId: string
  content: string
  isError: boolean
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Turn-lifecycle events beyond start / delta / completed.
// ---------------------------------------------------------------------------

/** `message_delta` arrived with a final `stop_reason`. This is the
 *  authoritative end-of-generation signal from the model; consumers
 *  should trust it over any screen-idle heuristic. See
 *  claude.ts:2242-2293 for the Claude-internal handling we mirror. */
export type SemanticTurnStoppedEvent = {
  type: 'turn_stopped'
  turnId: string
  /** Upstream value exactly as delivered. Null means "stream ended
   *  without a message_delta", which is a soft error. */
  stopReason:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'model_context_window_exceeded'
    | 'pause_turn'
    | 'refusal'
    | 'stop_sequence'
    | null
  /** Convenience flag: `stop_reason === 'refusal'`. Surfaced so the
   *  renderer can branch without hard-coding the string. */
  isRefusal: boolean
  /** Synthetic error message Claude would normally inject into the
   *  transcript for `max_tokens`, `model_context_window_exceeded`, or
   *  `refusal`. Present when we know the text to show; absent
   *  otherwise. */
  syntheticErrorText?: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** Usage accounting accumulated across `message_start` +
 *  `message_delta`. Mirrors the merge in `updateUsage` at
 *  claude.ts:2924. Every field is optional because the upstream
 *  payload can omit them; consumers should treat missing values as
 *  "unchanged from previous", not zero. */
export type SemanticUsageEvent = {
  type: 'usage_updated'
  turnId: string
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation?: {
      ephemeral_1h_input_tokens?: number
      ephemeral_5m_input_tokens?: number
    }
    cache_deleted_input_tokens?: number
    service_tier?: string
    inference_geo?: string
    speed?: string
    server_tool_use?: {
      web_search_requests?: number
      web_fetch_requests?: number
    }
  }
  /** Optional cost estimate in USD if the consumer provided a
   *  calculator. Computed from usage + model; populated by the
   *  adapter when available. */
  costUSD?: number
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Error events.
// ---------------------------------------------------------------------------
//
// Two flavors: soft (streaming defensive) and hard (API error). Split
// because consumers often render them very differently — soft errors
// mean "the stream had a hiccup but continued", hard errors mean "the
// request failed, show the error card".

/** Streaming defensive error — matches Claude's own `tengu_streaming_error`
 *  logging path (claude.ts:2056-2189). The stream may continue after
 *  these; they're reported so consumers can show a diagnostic without
 *  tearing down the turn. */
export type SemanticStreamErrorEvent = {
  type: 'stream_error'
  turnId: string | null
  /** Error tag from upstream, e.g. `content_block_not_found_delta`,
   *  `content_block_type_mismatch_text`. */
  errorType: string
  message: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

/** API-level failure. Carries the bits Claude's retry layer cares
 *  about (services/api/errors.ts + withRetry.ts) so consumers can show
 *  meaningful messaging like "overloaded — retrying". */
export type SemanticApiErrorEvent = {
  type: 'api_error'
  turnId: string | null
  status?: number
  errorType?: string
  message: string
  /** Present when this is a 529 overloaded error. Makes branching
   *  simple even when status is lost to the SDK. */
  isOverloaded?: boolean
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------
// Attribution diagnostics.
// ---------------------------------------------------------------------------
//
// Proxy-based live streaming requires picking WHICH /v1/messages flow
// is the visible assistant turn. Title generation, retries, and other
// internal requests also hit /v1/messages and must be suppressed. We
// emit decisions on the semantic channel so the app can surface
// "which flow are we rendering from" without guessing.

export type SemanticFlowSelectedEvent = {
  type: 'flow_selected'
  turnId: string | null
  flowId: string
  /** Why this flow was chosen — session header match, prompt
   *  ordering, etc. Freeform; diagnostic only. */
  reason: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

export type SemanticFlowIgnoredEvent = {
  type: 'flow_ignored'
  flowId: string
  /** Why this flow was excluded — e.g. "no session header",
   *  "secondary /v1/messages call", "already had a selected flow". */
  reason: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}

// ---------------------------------------------------------------------------

export type SemanticEvent =
  | SemanticTurnStartedEvent
  | SemanticTurnDeltaEvent
  | SemanticTurnCompletedEvent
  | SemanticSourceChangedEvent
  | SemanticBlockStartedEvent
  | SemanticTextDeltaEvent
  | SemanticThinkingDeltaEvent
  | SemanticSignatureEvent
  | SemanticConnectorTextDeltaEvent
  | SemanticCitationsDeltaEvent
  | SemanticToolInputDeltaEvent
  | SemanticToolInputFinalizedEvent
  | SemanticBlockCompletedEvent
  | SemanticToolResultEvent
  | SemanticTurnStoppedEvent
  | SemanticUsageEvent
  | SemanticStreamErrorEvent
  | SemanticApiErrorEvent
  | SemanticFlowSelectedEvent
  | SemanticFlowIgnoredEvent

// ---------------------------------------------------------------------------
// Screen channel — "what is on the terminal".
// ---------------------------------------------------------------------------
//
// Every event here describes visible terminal state. The consumer
// should treat this channel as the source of truth for UI overlays
// (trust modal, picker, compaction banner) and for mirroring the raw
// PTY. It must NOT be used to drive semantic turn rendering — that is
// what the semantic channel is for. The whole point of the split is to
// stop conflating "visible on screen" with "produced by the model".

export type ScreenSnapshotEvent = {
  type: 'snapshot'
  plain: string
  markdown: string
  ts: number
}

export type ScreenActivityEvent = {
  type: 'activity'
  active: boolean
  /** Spinner verb when active ("Cogitating…"), null when idle. */
  status: string | null
  ts: number
}

export type ScreenTrustDialogEvent = {
  type: 'trust_dialog'
  state: TrustDialogState
  ts: number
}

export type ScreenResumePromptEvent = {
  type: 'resume_prompt'
  state: ResumePromptState
  ts: number
}

export type ScreenCompactionEvent = {
  type: 'compaction'
  state: CompactionState
  ts: number
}

export type ScreenSlashPickerEvent = {
  type: 'slash_picker'
  state: SlashPickerState
  ts: number
}

export type ScreenEvent =
  | ScreenSnapshotEvent
  | ScreenActivityEvent
  | ScreenTrustDialogEvent
  | ScreenResumePromptEvent
  | ScreenCompactionEvent
  | ScreenSlashPickerEvent

// ---------------------------------------------------------------------------
// Committed channel — "what has persisted".
// ---------------------------------------------------------------------------
//
// This channel describes durable, confirmed history as written to
// disk. Unlike semantic deltas (which can be corrected or reconciled),
// committed events represent settled truth that can safely back a feed
// or a history log. Use this channel to build the append-only
// transcript the app shows after a turn is over.

export type CommittedTurnEvent = {
  type: 'turn_committed'
  turnId: string
  role: 'user' | 'assistant'
  text: string
  /** The underlying transcript entry, in case the consumer needs to
   *  inspect tool_use/tool_result blocks or model metadata. */
  entry: Entry
  file: string
  ts: number
}

export type CommittedEntryEvent = {
  type: 'entry'
  entry: Entry
  file: string
  ts: number
}

export type CommittedCompactBoundaryEvent = {
  type: 'compact_boundary'
  entry: Entry
  file: string
  ts: number
}

export type CommittedEvent =
  | CommittedTurnEvent
  | CommittedEntryEvent
  | CommittedCompactBoundaryEvent
