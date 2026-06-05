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

import { Buffer } from 'node:buffer'
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
import { shouldFilterSuggestion } from './suggestionFilter.js'

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
  /** Base64-encoded REQUEST body, populated by the mitm addon for
   *  /v1/messages calls only and capped at 256 KiB. Used by the sidecar
   *  filter to detect title-gen / compaction / hook-agent calls that
   *  share the user's primary model and therefore can't be caught by
   *  the model-name heuristic. Optional because (a) older addons don't
   *  emit it, (b) non-/v1/messages requests omit it, and (c) oversized
   *  bodies are dropped silently. Consumers MUST tolerate absence. */
  body_b64?: string
  /** Pre-extracted shape of the REQUEST body, populated by the mitm
   *  addon for /v1/messages calls regardless of body size. This field
   *  was added because real Claude Code requests routinely run 700 KB
   *  to 1+ MB (full conversation history every turn), which silently
   *  dropped past `body_b64`'s 256 KiB cap. Result: the c8c2623 sidecar
   *  filter saw `requestShape = null` for ~99% of traffic in
   *  production debug bundles (e.g. 2026-05-07T08-26-35-212-5d948ab5)
   *  and never demoted any flow.
   *
   *  By parsing in the addon (which already has the body buffered in
   *  mitmproxy memory) we keep the IPC payload tiny — a few hundred
   *  bytes per request instead of multi-MB base64 — while still
   *  giving the adapter the three fields it needs (max_tokens,
   *  messageCount, systemPrefixes). Consumers MUST tolerate absence:
   *  older addons don't emit this and the adapter falls back to
   *  parsing `body_b64` inline. */
  request_shape?: {
    /** Predicate-relevant: max_tokens budget. Real Claude Code
     *  turns set 8192+; sidecars cap at 1024. */
    max_tokens?: number | null
    /** Predicate-relevant: count of `messages` array entries. */
    message_count?: number | null
    /** Predicate-relevant: leading 200 chars of every `system` text
     *  block. Each entry preserves block order. */
    system_prefixes?: string[]
    /** Diagnostic: count of entries in the `tools` array. Real
     *  Claude Code turns ALWAYS ship the tools array (Bash, Edit,
     *  Read, …); sidecars routed through sideQuery / queryHaiku
     *  ship `tools: []` or omit. Strongest single signal we don't
     *  yet wire into isSidecarFlow — landed here so future predicate
     *  work can pick it up. */
    tools_count?: number | null
    /** Diagnostic: number of system blocks. Real turns: many
     *  (attribution + CLI sysprompt + tools/workspace context).
     *  Sidecars: 2-3. */
    system_blocks_count?: number | null
    /** Diagnostic: total characters across all system blocks. Real
     *  turns measure in 10s of KB; sidecars in <5 KB. */
    system_total_chars?: number | null
    /** Diagnostic: total characters across all messages content
     *  text blocks. Defence-in-depth signal against a sidecar
     *  variant that ships the full conversation history. */
    messages_total_chars?: number | null
    /** Diagnostic: `cc_entrypoint` slug parsed from system[0].text's
     *  attribution header. One of: cli / sdk-cli / mcp /
     *  claude-code-github-action / local-agent. Doesn't discriminate
     *  call type but lets bundle tooling correlate traffic back to
     *  the parent process. */
    attribution_entrypoint?: string | null
    /** Renderer-relevant: true when the last user message matches
     *  Claude Code's fixed compaction prompt preamble (see
     *  `_detect_compaction_synthesis` in `mitmAddon.py`). Threaded
     *  through to `SemanticTurnStartedEvent.isCompactionSynthesis`
     *  so the renderer can swap raw <analysis>/<summary> streaming
     *  for a "Compacting…" placeholder. Distinct from the sidecar
     *  predicate — compaction turns are real user-initiated work
     *  that we WANT to surface, just with different UI. */
    compaction_synthesis?: boolean | null
    /** Renderer-relevant: true when ANY user message in the body starts
     *  with Claude Code's `[SUGGESTION MODE:` sentinel — i.e. this flow is
     *  the prompt-suggestion fork (see `_detect_prompt_suggestion` in
     *  mitmAddon.py). Unlike the sidecar signals this is model-/tools-
     *  independent because the fork reuses the parent's cache params; the
     *  seed user message is the only wire tell. Threaded to
     *  `ParsedRequestShape.isPromptSuggestion` and consumed at
     *  message_start to route the flow OUT of the visible turn stream. */
    prompt_suggestion?: boolean | null
  }
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

type ParsedRequestShape = {
  /** Caller-supplied generation cap. Title-gen requests typically set
   *  this to 32-512; real turns set it to 8192+. Stored verbatim — the
   *  filter compares against an explicit threshold rather than a ratio
   *  to remain robust to future Claude Code defaults.
   *
   *  CAVEAT: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` lets a user override the
   *  real-turn cap downwards with no lower bound (only `> 0`). A user
   *  who sets it to 1024 would have real turns demoted by a
   *  threshold-only check. That's why signal 2a in `isSidecarFlow`
   *  pairs `maxTokens` with `messageCount` — see the comment there. */
  maxTokens: number | null
  /** Length of the request's `messages` array. Real conversation
   *  turns carry the full history (tens of messages once a session
   *  warms up; even a first user turn typically has ≥1 with cache
   *  primers above it on retries). Auxiliary calls (title gen,
   *  branch-name gen, compaction summary, hook agent) post a tiny
   *  synthetic conversation — almost always 1, occasionally 2.
   *  Stored as a count, not the array, so a 200 KiB request body
   *  doesn't pin in memory after the request is parsed.
   *
   *  Used in conjunction with `maxTokens` so the predicate is robust
   *  to a user who sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024` for
   *  their primary model (real turns would have small max_tokens but
   *  still a long messages array). */
  messageCount: number | null
  /** Per-text-block prefixes from the request's `system` field. Each
   *  entry is the first 200 chars of one block's `text`, in source
   *  order. Stored as an ARRAY (not a single concatenation) because
   *  Claude Code's `sideQuery` constructs `system` as
   *  `[attributionHeader?, getCLISyspromptPrefix?, ...callerSystem]`
   *  — the auxiliary prompt is at index 2+, not 0. An earlier
   *  revision read only `system[0]` and the fingerprint check became
   *  effectively dead code; matching against every block keeps the
   *  signal usable regardless of how Claude Code orders its system
   *  prelude. Truncating each block to 200 chars bounds per-flow
   *  memory while still capturing the auxiliary prompt's identifying
   *  prefix (the longest known fingerprint is ~50 chars).
   *
   *  Empty array (not null) when the system field was absent or
   *  contained no text blocks; null only when the request body
   *  itself was missing. */
  systemPrefixes: string[] | null
  /** True when the request body's LAST user message starts with
   *  Claude Code's fixed compact-prompt preamble. Forwarded from
   *  the mitm addon's `request_shape.compaction_synthesis` flag,
   *  with the fallback `parseRequestBody` path computing the same
   *  bit inline for back-compat with addons that pre-date the
   *  pre-extracted field.
   *
   *  Read by the message_start handler to tag the resulting
   *  semantic turn so renderers can swap the raw
   *  `<analysis>/<summary>` stream for a "Compacting…" placeholder.
   *  Intentionally NOT consumed by `isSidecarFlow`: compaction is a
   *  real user-initiated turn (the resulting `compact_boundary` +
   *  `isCompactSummary` JSONL entries are user-facing artefacts),
   *  so demoting it would silently break the UI. Treated as a UI
   *  hint, not a routing decision. */
  isCompactionSynthesis: boolean
  /** True when the request body is Claude Code's prompt-suggestion fork.
   *  Forwarded from the addon's `request_shape.prompt_suggestion`, with the
   *  legacy `parseRequestBody` path computing the same bit inline. Read by
   *  the message_start handler to route the flow to a `prompt_suggestion`
   *  semantic event instead of `startTurn`. Distinct from the sidecar
   *  predicate: a suggestion fork runs on the user's PRIMARY model with the
   *  full tools array, so isSidecarFlow can never catch it. */
  isPromptSuggestion: boolean
}

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
  /** Parsed shape of the request body, populated at `onRequest` time
   *  when the addon supplied `body_b64`. Null when the addon did not
   *  emit a body, parsing failed, or the request was made by an older
   *  addon version. The sidecar filter must treat null as "no signal"
   *  and fall back to the existing model-name heuristic — never as
   *  evidence that a flow is real. */
  requestShape: ParsedRequestShape | null
  /** True once message_start confirmed this flow is the prompt-suggestion
   *  fork (requestShape.isPromptSuggestion). When set, the flow is kept OUT
   *  of the visible turn stream — no startTurn, no text deltas to the feed.
   *  We still accumulate its text into `promptSuggestionText` and emit a
   *  `prompt_suggestion` event at message_stop. */
  isPromptSuggestionFlow: boolean
  /** Accumulated assistant text for a suggestion flow. Empty for every
   *  normal flow. */
  promptSuggestionText: string
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
  /** Wall-clock ms of the most recent transport chunk we observed for
   *  this flow. Drives the active-flow watchdog (see
   *  STALE_ACTIVE_FLOW_MS): if the held active flow's lastChunkAt is
   *  older than the window when a NEW candidate's first chunk arrives,
   *  we force-release the lock so the new flow can promote. Without
   *  this, a single severed stream that never receives `response-end`
   *  pins activeStreamingFlowId forever and turns every later flow
   *  into a `flow_ignored` event. */
  lastChunkAt: number
}

/** System-prompt prefixes that identify Claude Code's auxiliary
 *  /v1/messages calls (title generation, branch-name gen, compaction
 *  summary, hook agents). Matched as a case-insensitive prefix
 *  against the request's `system` text — see `isSidecarFlow`.
 *
 *  We list literal English prefixes rather than a regex pattern so
 *  the failure mode of a prompt rename is "we miss this call until
 *  we add the new prefix" — not "we silently misclassify a real
 *  turn". The `max_tokens <= 1024` signal in `isSidecarFlow` is the
 *  real safety net when prompts drift; this list is the cheap
 *  positive-ID path that catches them before we even need to look
 *  at the budget.
 *
 *  Source of truth shared with `describeSidecarReason` so the human-
 *  readable demotion reason can never disagree with the predicate
 *  that triggered demotion. Earlier revisions kept a separate
 *  "non-empty systemPrefix" check inside `describeSidecarReason`,
 *  which over-reported `auxiliary system prompt` whenever a flow
 *  carrying ANY system text was demoted on `max_tokens` alone. By
 *  matching against this list in both places we guarantee the
 *  reason text reflects the actual signal.
 *
 *  Drawn from the Claude Code 2.1.x source as of 2026-05-06; extend
 *  as new sidecars are observed in debug bundles. */
const SIDECAR_SYSTEM_PROMPT_PREFIXES = [
  'You are a helpful AI assistant tasked with generating',
  'You will be given a conversation', // teleport branch+title
  'Generate a concise', // compaction summary, title gen
  'Summarize the following', // hook-agent variants
] as const

/** Real Claude Code turns set max_tokens to 8192+ by default; every
 *  known auxiliary call (title gen, branch-name gen, compaction
 *  summary, hook agent) caps at <= 1024. 1024 is the highest known
 *  auxiliary value (compaction summary), and `sideQuery` defaults to
 *  1024 when callers omit it.
 *
 *  CAVEAT: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` lets a user override the
 *  primary-model cap downwards (only `> 0` is enforced). A user who
 *  pinned that env to 1024 would have real turns demoted by a
 *  threshold-only check. That's why signal 2a in `isSidecarFlow`
 *  pairs this threshold with `AUXILIARY_MESSAGE_COUNT_THRESHOLD` —
 *  the compound predicate stays narrow (real turns carry the full
 *  messages array even when the user pinned a low budget) while
 *  still catching every observed auxiliary shape (sideQuery default
 *  1024 with a 1- or 2-message synthetic body).
 *
 *  Hoisted to module scope so `isSidecarFlow` and
 *  `describeSidecarReason` share a single source. */
const MAX_TOKENS_SIDECAR_THRESHOLD = 1024

/** Companion to `MAX_TOKENS_SIDECAR_THRESHOLD`. Auxiliary calls are
 *  invoked with synthetic conversations that contain 1 or 2
 *  messages — a single user-role description, occasionally preceded
 *  by an assistant-role priming message. Real Agent Code conversations
 *  reach this count only on the very first turn, but they also
 *  always include cache-priming or attachment messages above the
 *  raw user input, so the realistic floor for a real turn is ≥ 4.
 *
 *  We pick 3 (rather than 2) to absorb the unlikely case that
 *  Claude Code starts including one extra synthetic system-style
 *  message in a future auxiliary call. Picking 5 or higher would
 *  catch isolated test sessions; picking 1 would miss any auxiliary
 *  call that adds a single priming message.
 *
 *  Used ONLY in conjunction with `MAX_TOKENS_SIDECAR_THRESHOLD` —
 *  on its own this signal is too weak (a one-message real turn
 *  exists when a user starts a new pane). */
const AUXILIARY_MESSAGE_COUNT_THRESHOLD = 3

// Watchdog window for activeStreamingFlowId.
//
// activeStreamingFlowId is normally released only by an explicit
// response-end transport event (see onEnd). That contract breaks when
// the SSE stream is severed mid-response — the proxy doesn't always
// observe the disconnect, no `response-end` is published, and the lock
// stays held. Every later real turn hits the gate in onChunk and gets
// emitted as flow_ignored. See debug bundle
// 2026-05-01T10-07-21-3357bfc7 where a flow held the lock for 14+
// hours and blocked all subsequent semantic events.
//
// The window is intentionally generous. A live Claude turn chunks
// continuously while streaming and pauses for at most a few seconds
// between message frames, so 30s is far longer than any healthy turn
// would sit silent. Erring long means we never reap a flow that is
// merely slow; the cost of a false-positive reap is publishing a
// turn_stopped(stopReason=null) for a turn that was actually still
// streaming, which would corrupt the live feed for the user.
const STALE_ACTIVE_FLOW_MS = 30_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textFromUnknownBlock(value: unknown): string | null {
  const block = asRecord(value)
  const text = block?.text
  return typeof text === 'string' && text.length > 0 ? text : null
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

  // -----------------------------------------------------------------
  // Sidecar-flow filtering.
  // -----------------------------------------------------------------
  //
  // Claude Code makes auxiliary `/v1/messages` calls that are NOT part
  // of the visible conversation: session title generation
  // (vendor utils/sessionTitle.ts), compaction summaries, agent-tool
  // verification, hook agents, teleport title-and-branch, etc. These
  // all use a "small fast model" (Haiku) and emit JSON-shaped text
  // that the user never asked to see. Without filtering, the adapter
  // promotes the first such flow to `'active'` (the lock is keyed on
  // first-chunk arrival), publishes `turn_started` + text deltas, and
  // the renderer ghosts the JSON content into the transcript as a
  // phantom message that is never superseded by a JSONL entry
  // (Claude Code only writes real conversation turns to the rollout).
  //
  // The fix is to detect the sidecar at `message_start` (which carries
  // the model name) and demote the flow to `'secondary'` BEFORE
  // calling `channel.startTurn`. The check runs at message_start —
  // not at request time — because the Anthropic request body is not
  // surfaced by the proxy event stream and only the response carries
  // the model id.
  //
  // The rule is intentionally NOT "filter every Haiku flow": a user
  // who explicitly picks Haiku as their primary model would have
  // their real conversation suppressed. Instead, a flow is treated as
  // sidecar iff its model matches `sidecarModelPattern` AND
  // `getSessionModel()` returns a model that does NOT match the
  // pattern. Both conditions are required, so:
  //
  //   * Haiku title-gen on an Opus session → filtered ✓
  //   * Haiku title-gen on a Haiku session → not filtered (no false
  //     positive on Haiku users)
  //   * Sonnet conversation on a Sonnet session → not filtered ✓
  //   * Adapter constructed without `getSessionModel` → no filtering
  //     at all (preserves pre-fix behaviour for callers who haven't
  //     opted in).

  /** Returns the user-selected primary model for the current session,
   *  or null/undefined if unknown. Read fresh on every check rather
   *  than cached at construction so a `/model` mid-session takes
   *  effect on the very next sidecar evaluation. */
  getSessionModel?: () => string | null | undefined
  /** Pattern that identifies a sidecar model. Defaults to `/haiku/i`
   *  because every known auxiliary call in Claude Code v2.1.x uses
   *  Haiku via `getSmallFastModel()`. Pass `null` to disable sidecar
   *  filtering entirely even when a session model is provided. */
  sidecarModelPattern?: RegExp | null
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

  /** Sidecar-flow filter — see ClaudeProxyAdapterOptions for why this
   *  exists. A `null` callback means no opt-in and the filter is
   *  inert; a non-null callback combined with a non-null pattern (the
   *  default `/haiku/i`) enables the demotion path in the
   *  `message_start` branch of `applyAnthropicEvent`. */
  private readonly getSessionModel: (() => string | null | undefined) | null
  private readonly sidecarModelPattern: RegExp | null

  constructor(options: ClaudeProxyAdapterOptions) {
    this.channel = options.channel
    // Each adapter gets its own policy instance by default so its
    // "one active flow at a time" state is not shared across
    // adapters in the same process. Callers that want shared state
    // across adapters can pass their own policy.
    this.policy = options.attributionPolicy ?? createDefaultAttributionPolicy()
    this.onDiagnostic = options.onDiagnostic ?? (() => {})
    this.getSessionModel = options.getSessionModel ?? null
    // `undefined` → use the default pattern; explicit `null` → disable
    // filtering entirely. The distinction matters because this is the
    // only knob a Haiku-as-primary user has to opt out of filtering
    // without supplying their own session-model callback.
    this.sidecarModelPattern =
      options.sidecarModelPattern === undefined
        ? /haiku/i
        : options.sidecarModelPattern
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
      requestShape: null,
      isPromptSuggestionFlow: false,
      promptSuggestionText: '',
      turnStarted: false,
      turnStopped: false,
      pendingToolUses: [],
      // Seed lastChunkAt at request time so a flow that takes a while
      // to send its first SSE chunk (e.g. slow upstream) doesn't look
      // "stale" to the watchdog the very first time onChunk runs.
      lastChunkAt: Date.now(),
    }
    // Prefer the addon's pre-extracted request_shape over parsing
    // body_b64 inline. The addon path works for any body size (it
    // parses the buffered body inside the addon process and emits only
    // the fields we care about), while body_b64 is gated on a 256 KiB
    // cap that real Claude Code requests routinely exceed because they
    // include the full conversation history. Both paths populate the
    // same ParsedRequestShape so downstream isSidecarFlow logic doesn't
    // need to know which source produced the data.
    //
    // Order of precedence:
    //   1. event.request_shape  — new, post-2026-05-07 addon
    //   2. event.body_b64       — older addons, small-body fallback
    //   3. null                 — no signal; signal 1 (model name)
    //                             still runs in isSidecarFlow.
    state.requestShape =
      this.normalizeRequestShape(event.request_shape) ??
      this.parseRequestBody(
        typeof event.body_b64 === 'string' ? event.body_b64 : undefined,
      )
    this.flows.set(flowId, state)
    this.onDiagnostic(`flow ${flowId} accepted as candidate`)
  }

  private onChunk(flowId: string, event: ProxyTransportEvent): void {
    const state = this.flows.get(flowId)
    if (!state) return
    const b64 = event.chunk_b64
    if (typeof b64 !== 'string' || !b64) return

    // Bump lastChunkAt for the watchdog. We do this for every chunk on
    // every flow (active, candidate, secondary) so the timestamp
    // always reflects "when did transport last touch this stream",
    // not "when did the renderer get a useful event from this stream".
    state.lastChunkAt = Date.now()

    // First-chunk promotion. Only SSE responses produce chunk events
    // (the mitmproxy addon gates its stream tap on response
    // Content-Type: text/event-stream), so arrival here is a
    // reliable "this is live streaming" signal — unlike the request
    // headers, which don't distinguish warmup from real turns.
    if (state.attribution === 'candidate') {
      // Watchdog gate: if the held active flow has been silent past
      // the window, the SSE stream almost certainly died without a
      // clean response-end. Free the lock here so this candidate can
      // promote — otherwise we'd flow_ignored every later turn until
      // the session restarts. See the STALE_ACTIVE_FLOW_MS comment
      // for the full incident this prevents.
      if (this.activeStreamingFlowId !== null && this.activeStreamingFlowId !== flowId) {
        const stale = this.flows.get(this.activeStreamingFlowId)
        if (stale && Date.now() - stale.lastChunkAt > STALE_ACTIVE_FLOW_MS) {
          this.reapStaleActiveFlow(stale)
        }
      }

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

  /** Force-release a stale active flow whose response-end never
   *  arrived. Mirrors the cleanup branch in `onEnd` that synthesises a
   *  turn_stopped when the stream dies without an explicit
   *  message_delta — same confidence, same publishPhase('idle'). The
   *  only delta vs. onEnd is that we got here via the watchdog in
   *  onChunk rather than a real transport event, so we also emit a
   *  diagnostic carrying the silent duration so debug bundles can
   *  attribute the recovery (otherwise reviewers would see a
   *  flow_selected on a new flow with no obvious reason the previous
   *  active was let go). Caller is responsible for then promoting the
   *  new candidate normally. */
  private reapStaleActiveFlow(state: FlowState): void {
    if (state.attribution === 'active' && state.turnStarted && !state.turnStopped) {
      this.channel.publishTurnStopped({
        turnId: state.turnId ?? state.flowId,
        stopReason: null,
        source: 'proxy',
        confidence: 'medium',
      })
      state.turnStopped = true
      this.channel.finishTurn({
        turnId: state.turnId ?? state.flowId,
        fullText: state.fullText || undefined,
        source: 'proxy',
        confidence: 'medium',
      })
      this.publishPhase(state, 'idle')
    }
    const silentMs = Date.now() - state.lastChunkAt
    this.onDiagnostic(
      `flow ${state.flowId} reaped (no chunk for ${Math.round(silentMs / 1000)}s)`,
    )
    this.flows.delete(state.flowId)
    if (this.activeStreamingFlowId === state.flowId) {
      this.activeStreamingFlowId = null
    }
  }

  private closeTurnAfterTerminalApiError(
    state: FlowState,
    source: SemanticSource,
    confidence: SemanticConfidence,
  ): void {
    if (!state.turnStarted || state.turnStopped || !state.turnId) return

    // API `error` frames are terminal for the Anthropic SSE stream, but
    // they can arrive after `message_start` and partial deltas. Releasing
    // only the transport lock would let the next retry promote while the
    // SemanticChannel still believes the failed turn is active, causing a
    // `start_while_active` lifecycle violation and dropping the retry's
    // `turn_started`. Close the semantic turn here for the same reason
    // `onEnd` and the stale-flow watchdog synthesize a stop: once this
    // stream has failed, there is no valid future frame that can complete
    // the active turn for us.
    this.channel.publishTurnStopped({
      turnId: state.turnId,
      stopReason: null,
      source,
      confidence,
    })
    state.turnStopped = true
    this.channel.finishTurn({
      turnId: state.turnId,
      fullText: state.fullText || undefined,
      source,
      confidence,
    })
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
        this.closeTurnAfterTerminalApiError(state, source, confidence)
        // Release the stream lock immediately on provider-level SSE
        // errors. The normal happy path frees `activeStreamingFlowId`
        // in `onEnd`, but the overloaded-error incident that exposed
        // this bug did not produce a useful follow-up end event before
        // the user retried. That left the failed flow holding the
        // active slot, so every later real turn was emitted as
        // `flow_ignored: concurrent with active flow ...` even though
        // the network and proxy were healthy again. An Anthropic
        // `error` event is terminal for this stream by contract; after
        // we surface it and put the UI phase back to idle, keeping the
        // lock buys nothing and poisons the session.
        this.flows.delete(state.flowId)
        if (this.activeStreamingFlowId === state.flowId) {
          this.activeStreamingFlowId = null
        }
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

        // Sidecar demotion. message_start is the first SSE frame that
        // carries the model id, which is the only signal we have for
        // distinguishing a real conversation turn from an auxiliary
        // Haiku call (title generation, compaction summary, etc.).
        // The check has to live HERE — not in `classify()` — because
        // the proxy event stream surfaces request headers but not the
        // request body, and the model name lives in the body.
        //
        // Demotion sequence (note the ordering — it matters):
        //   1. Publish `phase: 'idle'` to clear the brief `requesting`
        //      state we ourselves emitted on first-chunk a few ms ago.
        //      MUST run while attribution is still 'active' because
        //      `publishPhase` early-returns on non-active flows (see
        //      its docstring) — secondary flows must not flap the
        //      spinner mid-turn.
        //   2. Flip attribution → 'secondary'. After this, every later
        //      event on this flow falls through the `isActive` gates
        //      in the rest of `applyAnthropicEvent` (text_delta,
        //      content_block_stop, message_stop all guard on
        //      `isActive`) and never reaches the channel.
        //   3. Publish `flow_ignored` so debug consumers can see the
        //      decision and the renderer can pair it with the earlier
        //      `flow_selected` we already published on first-chunk
        //      (at that point we didn't yet know the model — the
        //      model only ships in `message_start`).
        //
        // We do NOT release `activeStreamingFlowId` here. The lock is
        // released by `onEnd` when this flow's response-end arrives,
        // matching the lifetime of any other flow. Releasing earlier
        // would let a concurrent real-turn flow promote during the
        // sidecar's tail and produce two competing 'active'
        // attributions for the same wall-clock window.
        // Prompt-suggestion routing. The fork reuses the parent's cache
        // params (same model/tools/system/max_tokens), so isSidecarFlow
        // can't see it — the only tell is requestShape.isPromptSuggestion,
        // sniffed from the seed user message at request time. We keep the
        // flow OUT of the visible turn stream: clear the spinner we emitted
        // on first-chunk, flip to 'secondary' so every later text_delta /
        // message_stop falls through the isActive gates, and record the
        // flag. We do NOT call startTurn — that call is what ghosts the
        // suggestion into the transcript (#174), and Claude Code marks the
        // fork skipTranscript so the committed channel never supersedes it.
        // We still accumulate the streamed text (see the text-delta handler)
        // and emit a `prompt_suggestion` event at message_stop.
        //
        // KNOWN GAP — speculation. Claude Code can pre-execute the suggested
        // prompt (vendor .../PromptSuggestion/speculation.ts) via another
        // skipTranscript fork. That fork sends the suggestion TEXT itself as
        // the user message (speculation.ts:458) with a client-side
        // querySource:'speculation' that never reaches the wire — so its
        // request body is byte-indistinguishable from a real user turn and
        // we cannot detect it here. It is gated behind a separate
        // isSpeculationEnabled() flag. If a speculation fork streams while no
        // real turn holds the active lock, its output can still leak as a
        // phantom turn. Catching it would require a response-side or
        // lock-timing heuristic; tracked as follow-up, out of scope for #174.
        if (isActive && state.requestShape?.isPromptSuggestion === true) {
          state.isPromptSuggestionFlow = true
          this.publishPhase(state, 'idle')
          state.attribution = 'secondary'
          this.channel.publishFlowIgnored({
            flowId: state.flowId,
            reason: 'prompt_suggestion',
            source,
            confidence,
          })
          this.onDiagnostic(
            `flow ${state.flowId} routed as prompt_suggestion (model=${ev.model})`,
          )
          return
        }

        if (isActive && this.isSidecarFlow(state, ev.model)) {
          // Clear the spinner BEFORE flipping attribution. `publishPhase`
          // early-returns when attribution !== 'active' (so that
          // secondary flows can't flap the spinner mid-turn), so an
          // `idle` publish after demotion would be silently dropped.
          // This one-time clearing is a legitimate active-flow action
          // — we're undoing the `requesting` we ourselves emitted on
          // first-chunk a few ms ago.
          this.publishPhase(state, 'idle')
          state.attribution = 'secondary'
          this.channel.publishFlowIgnored({
            flowId: state.flowId,
            reason: this.describeSidecarReason(state, ev.model),
            source,
            confidence,
          })
          this.onDiagnostic(
            `flow ${state.flowId} demoted as sidecar (model=${ev.model}` +
            `, maxTokens=${state.requestShape?.maxTokens ?? '?'}` +
            `, messages=${state.requestShape?.messageCount ?? '?'}` +
            `, sysPrefix=${(state.requestShape?.systemPrefixes?.[0] ?? '').slice(0, 40)})`,
          )
          return
        }

        if (isActive && !state.turnStarted) {
          // Forward the compaction-synthesis flag from the request
          // shape (sniffed at /v1/messages request time by the mitm
          // addon's last-user-message regex; see ParsedRequestShape
          // .isCompactionSynthesis). The flag lets the renderer swap
          // the raw <analysis>/<summary> XML stream for a placeholder.
          // Only attach when truthy so non-compaction turns keep their
          // event payload byte-identical for the golden fixture tests.
          const isCompactionSynthesis = state.requestShape?.isCompactionSynthesis === true
          this.channel.startTurn({
            turnId: ev.messageId,
            role: 'assistant',
            source,
            confidence,
            ...(isCompactionSynthesis ? { isCompactionSynthesis: true } : {}),
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
        // Suggestion flows are 'secondary' (so they never publish to the
        // feed) and may not have tracked blocks. Accumulate their text
        // here, independent of the block bookkeeping and the isActive gate,
        // then short-circuit — the chip is built from the concatenated
        // deltas and emitted at message_stop.
        if (state.isPromptSuggestionFlow) {
          state.promptSuggestionText += ev.text
          return
        }
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
        if (state.isPromptSuggestionFlow) {
          // Emit the captured suggestion if it survives the same quality
          // filter Claude Code itself applies (shouldFilterSuggestion). We
          // do this at message_stop, not on each delta, so the chip only
          // appears once the suggestion is complete. No startTurn ran, so
          // there is nothing to finish here.
          const text = state.promptSuggestionText.trim()
          if (!shouldFilterSuggestion(text)) {
            this.channel.publishPromptSuggestion({
              flowId: state.flowId,
              turnId: state.turnId,
              text,
              source,
            })
          }
          return
        }
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

  /** Coerce the addon's pre-extracted `request_shape` payload into the
   *  internal `ParsedRequestShape` slot. The addon emits the same
   *  three fields (max_tokens, message_count, system_prefixes) that
   *  `parseRequestBody` would have computed from `body_b64`, but
   *  parsed inside the mitm process so size doesn't matter. Tolerance
   *  rules mirror parseRequestBody: any malformed field collapses to
   *  null, never to a real-turn-looking value. */
  private normalizeRequestShape(raw: unknown): ParsedRequestShape | null {
    const obj = asRecord(raw)
    if (!obj) return null

    const maxTokens = finiteNumberField(obj, 'max_tokens')
    const messageCount = finiteNumberField(obj, 'message_count')

    // We trust the addon to have already capped each prefix at the
    // ~200-char window described in parseRequestBody; we only filter
    // out non-string entries defensively. A missing/non-array value
    // becomes [] so the downstream `for...of` in isSidecarFlow runs
    // zero iterations rather than throwing on a non-iterable.
    const prefixes = obj.system_prefixes
    const systemPrefixes = Array.isArray(prefixes)
      ? prefixes.filter((value): value is string => typeof value === 'string')
      : []

    // If the addon emitted an empty object (shouldn't happen — the
    // addon emits `request_shape` only when it successfully parsed a
    // body) treat as no-signal so the body_b64 fallback can still try.
    if (maxTokens === null && messageCount === null && systemPrefixes.length === 0) {
      return null
    }

    // Older addons (pre-2026-05-11) don't emit `compaction_synthesis`,
    // so coerce a missing value to `false` rather than letting it
    // propagate as undefined. Conservative default — if we're wrong
    // and this WAS a compaction turn, the worst case is the legacy
    // behaviour where the raw <analysis>/<summary> XML leaks; an
    // incorrect `true` would hide a real turn behind the placeholder.
    const rawCompaction = obj.compaction_synthesis
    const isCompactionSynthesis = rawCompaction === true
    const isPromptSuggestion = obj.prompt_suggestion === true

    return { maxTokens, messageCount, systemPrefixes, isCompactionSynthesis, isPromptSuggestion }
  }

  /** Decode and minimally parse the addon-supplied request body so the
   *  sidecar filter can read max_tokens / system / messages.length
   *  without re-parsing on every chunk. We stay deliberately tolerant
   *  here: any failure produces null, and null means "fall through to
   *  the model-name heuristic" — never "this is a real turn". The
   *  threshold for fingerprint matching lives in isSidecarFlow,
   *  not here, because this method must remain free of policy.
   *
   *  Kept as a fallback for older addons that don't emit
   *  `request_shape` directly. New addons (post-2026-05-07) parse
   *  inside the addon and emit the shape via the dedicated field; this
   *  base64-decode path is dormant for them and runs only when an
   *  older addon binary is in use. */
  private parseRequestBody(b64: string | undefined): ParsedRequestShape | null {
    if (!b64 || typeof b64 !== 'string') return null
    let json: unknown
    try {
      const raw = Buffer.from(b64, 'base64').toString('utf-8')
      json = JSON.parse(raw)
    } catch {
      return null
    }
    const obj = asRecord(json)
    if (!obj) return null

    const maxTokens = finiteNumberField(obj, 'max_tokens')

    const messages = Array.isArray(obj.messages) ? obj.messages : null
    const messageCount = messages ? messages.length : null

    // Anthropic accepts `system` as either a single string or an array
    // of typed blocks (currently only `{ type: 'text', text }` is used
    // in the wild, but we tolerate other types by skipping them). We
    // collect the prefix of EVERY text block, not just the first,
    // because Claude Code's `sideQuery` (vendor/utils/sideQuery.ts) puts
    // the attribution header in slot 0 and `getCLISyspromptPrefix` in
    // slot 1; the auxiliary prompt the fingerprint cares about lives at
    // index 2+. An earlier revision read only `system[0]` and quietly
    // turned the fingerprint check into dead code. The cap of 200 chars
    // per block keeps memory bounded — the longest known fingerprint
    // prefix is ~50 chars, so 200 is generous headroom.
    const systemPrefixes: string[] = []
    const sys = obj.system
    if (typeof sys === 'string') {
      // Single-string form is the legacy shape — every text we'd want
      // to fingerprint is in this one string.
      systemPrefixes.push(sys.slice(0, 200))
    } else if (Array.isArray(sys)) {
      for (const block of sys) {
        const text = textFromUnknownBlock(block)
        if (text) systemPrefixes.push(text.slice(0, 200))
      }
    }

    // Compaction sniff for the legacy body_b64 path. Mirrors
    // `_detect_compaction_synthesis` in mitmAddon.py — kept in sync
    // by hand because this code path only runs against older addons
    // that don't pre-extract the flag. The fixed signature phrase is
    // the same one written into the addon's `_COMPACT_PROMPT_SIGNATURE_RE`;
    // see the comment there for the source-of-truth rationale.
    let isCompactionSynthesis = false
    if (messages && messages.length > 0) {
      const last = asRecord(messages[messages.length - 1])
      if (last?.role === 'user') {
        let probe: string | null = null
        if (typeof last.content === 'string') {
          probe = last.content.slice(0, 400)
        } else if (Array.isArray(last.content) && last.content.length > 0) {
          const firstText = textFromUnknownBlock(last.content[0])
          if (firstText) probe = firstText.slice(0, 400)
        }
        if (probe) {
          isCompactionSynthesis = probe.includes('Your task is to create a detailed summary')
        }
      }
    }

    // Prompt-suggestion sniff for the legacy body_b64 path. Mirrors
    // `_detect_prompt_suggestion` in mitmAddon.py. We scan EVERY user
    // message (not just the last like compaction) because the fork's
    // tool-denied retries push a tool_result to the last slot while the
    // SUGGESTION_PROMPT seed stays earlier in the array.
    let isPromptSuggestion = false
    if (messages) {
      for (const m of messages) {
        const rec = asRecord(m)
        if (rec?.role !== 'user') continue
        let text: string | null = null
        if (typeof rec.content === 'string') {
          text = rec.content
        } else if (Array.isArray(rec.content) && rec.content.length > 0) {
          text = textFromUnknownBlock(rec.content[0])
        }
        if (text && text.trimStart().startsWith('[SUGGESTION MODE:')) {
          isPromptSuggestion = true
          break
        }
      }
    }

    return { maxTokens, messageCount, systemPrefixes, isCompactionSynthesis, isPromptSuggestion }
  }

  /** Whether the given flow looks like a sidecar (auxiliary) call rather
   *  than the user's visible turn. Two independent signals; either one
   *  is sufficient:
   *
   *    1. Model heuristic (legacy, kept). The flow's response model
   *       matches `sidecarModelPattern` (default /haiku/i) AND the
   *       session model does not. This catches Claude Code versions
   *       that still route auxiliary calls to Haiku.
   *
   *    2. Request-shape heuristic (new). The request body — surfaced
   *       by the mitm addon at onRequest time — carries one of Claude
   *       Code's known title-gen / summary system-prompt prefixes
   *       (signal 2b) OR pairs a tiny max_tokens budget with a tiny
   *       messages array (signal 2a, compound). Recent Claude Code
   *       versions route these calls against the user's primary
   *       model, so the legacy model heuristic alone misses them.
   *
   *  Both signals are gated on the same opt-in/disable contract that
   *  controlled the original Haiku-only filter (see
   *  `ClaudeProxyAdapterOptions`). A caller that constructed the
   *  adapter without `getSessionModel`, or with `sidecarModelPattern`
   *  explicitly set to `null`, has opted OUT of sidecar filtering;
   *  honouring that contract for the body-shape heuristic too is
   *  required to preserve back-compat for adapter consumers that
   *  passed a non-Claude-Code workload through this code path.
   *
   *  Returning true causes the message_start branch in
   *  applyAnthropicEvent to demote the flow to 'secondary'. A false
   *  negative on either signal is recoverable (we just don't filter
   *  that one call); a false POSITIVE silently hides a real turn —
   *  so each signal is written conservatively.
   */
  private isSidecarFlow(state: FlowState, flowModel: string | null | undefined): boolean {
    // Opt-in / disable gate (Critical-2 fix). Both forms must short-
    // circuit ALL signals here — body-shape included — to honour the
    // documented contract:
    //   * `sidecarModelPattern: null` → "disable filtering entirely"
    //   * `getSessionModel: undefined` → "caller hasn't opted in"
    // Earlier revisions of the body-shape branch ran regardless of
    // these flags, which silently changed the meaning of the opt-out
    // for adapter consumers. The whole subsystem now lives behind one
    // gate so future signals don't have to remember to re-check.
    if (this.sidecarModelPattern === null) return false
    if (this.getSessionModel === null) return false

    // Signal 1: legacy model match.
    const sessionModel = this.getSessionModel()
    if (typeof flowModel === 'string' && typeof sessionModel === 'string') {
      if (
        this.sidecarModelPattern.test(flowModel) &&
        !this.sidecarModelPattern.test(sessionModel)
      ) {
        return true
      }
    }

    // Signal 2: request shape. Skipped when the addon did not supply a
    // body (older mitmAddon.py, oversized payload, parse failure) — in
    // those cases we degrade to signal 1 only and the user falls back
    // to the prior behaviour.
    const shape = state.requestShape
    if (shape) {
      // 2a. Compound budget signal. A small `max_tokens` ALONE used
      // to be enough; that risked false-positives for users who set
      // `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024` (or lower) for their
      // primary model — real turns would be silently demoted. Pair
      // it with `messageCount` because a real conversation always
      // carries a non-trivial history while every known auxiliary
      // call posts ≤ 3 synthetic messages. Both conditions firing is
      // a much narrower predicate while still catching every observed
      // sidecar shape (sideQuery default 1024 + 1-msg synthetic body).
      if (
        typeof shape.maxTokens === 'number' &&
        shape.maxTokens > 0 &&
        shape.maxTokens <= MAX_TOKENS_SIDECAR_THRESHOLD &&
        typeof shape.messageCount === 'number' &&
        shape.messageCount > 0 &&
        shape.messageCount <= AUXILIARY_MESSAGE_COUNT_THRESHOLD
      ) {
        return true
      }

      // 2b. System-prompt fingerprint. We match prefixes (case-
      // insensitive) against EVERY block in `systemPrefixes` rather
      // than the first because Claude Code's `sideQuery` prepends
      // attribution and CLI-sysprompt blocks before the auxiliary
      // prompt. List lives at module scope
      // (SIDECAR_SYSTEM_PROMPT_PREFIXES) so describeSidecarReason
      // can re-match against the same source of truth.
      if (shape.systemPrefixes && shape.systemPrefixes.length > 0) {
        for (const blockPrefix of shape.systemPrefixes) {
          const lc = blockPrefix.toLowerCase()
          if (lc.length === 0) continue
          for (const fp of SIDECAR_SYSTEM_PROMPT_PREFIXES) {
            if (lc.startsWith(fp.toLowerCase())) return true
          }
        }
      }
    }

    return false
  }

  /** Human-readable label for why a flow was demoted, derived after
   *  the fact from whichever signal(s) tripped. We re-evaluate each
   *  signal here rather than threading the trigger through the call
   *  chain — the cost is negligible (string comparisons on a 200-char
   *  prefix and a numeric compare) and it keeps the demotion site
   *  free of branching. The output goes straight to the debug panel
   *  and the proxy-semantic dump, so phrase it for a human reader. */
  private describeSidecarReason(state: FlowState, flowModel: string | null | undefined): string {
    // Mirror the opt-in / disable gate from isSidecarFlow so the two
    // never disagree. In practice describeSidecarReason is only ever
    // called after isSidecarFlow returned true (which already implies
    // the gate passed), so this is defence-in-depth — but cheap.
    if (this.sidecarModelPattern === null || this.getSessionModel === null) {
      return 'sidecar (signals mismatch — see adapter logs)'
    }

    const reasons: string[] = []
    if (typeof flowModel === 'string') {
      const sessionModel = this.getSessionModel()
      if (
        typeof sessionModel === 'string' &&
        this.sidecarModelPattern.test(flowModel) &&
        !this.sidecarModelPattern.test(sessionModel)
      ) {
        reasons.push(`sidecar model ${flowModel}`)
      }
    }
    const shape = state.requestShape
    if (shape) {
      // Match the COMPOUND signal 2a from isSidecarFlow exactly —
      // both `max_tokens` AND `messageCount` must be small. Earlier
      // revisions reported `tiny max_tokens (...)` whenever the
      // budget alone was small, which was misleading once we tightened
      // the predicate to require a small messages array too.
      if (
        typeof shape.maxTokens === 'number' &&
        shape.maxTokens > 0 &&
        shape.maxTokens <= MAX_TOKENS_SIDECAR_THRESHOLD &&
        typeof shape.messageCount === 'number' &&
        shape.messageCount > 0 &&
        shape.messageCount <= AUXILIARY_MESSAGE_COUNT_THRESHOLD
      ) {
        reasons.push(
          `tiny max_tokens (${shape.maxTokens}) on ${shape.messageCount}-message request`,
        )
      }
      // Match against the SAME fingerprint list isSidecarFlow uses,
      // and against EVERY system block (not just the first), because
      // sideQuery prepends attribution + CLI-sysprompt blocks before
      // the auxiliary prompt. A flow demoted purely on max_tokens
      // that happens to carry a non-fingerprint system prompt should
      // NOT be labelled `auxiliary system prompt` — that would
      // mislead future debug sessions into chasing a fingerprint
      // that never tripped.
      if (shape.systemPrefixes && shape.systemPrefixes.length > 0) {
        let matchedFp: string | null = null
        outer: for (const blockPrefix of shape.systemPrefixes) {
          const lc = blockPrefix.toLowerCase()
          if (lc.length === 0) continue
          for (const fp of SIDECAR_SYSTEM_PROMPT_PREFIXES) {
            if (lc.startsWith(fp.toLowerCase())) {
              matchedFp = fp
              break outer
            }
          }
        }
        if (matchedFp !== null) {
          reasons.push(`auxiliary system prompt`)
        }
      }
    }
    if (reasons.length === 0) {
      // Defensive — isSidecarFlow returned true but no signal matches
      // here. Means the heuristics drifted out of sync; surface as much
      // detail as possible so we can fix the divergence.
      return 'sidecar (signals mismatch — see adapter logs)'
    }
    return reasons.join(' + ')
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
    const value: unknown = JSON.parse(raw)
    const parsed = asRecord(value)
    if (parsed) return { parsed }
    return { parsed: undefined, parseError: 'tool input is not a JSON object' }
  } catch (err) {
    return {
      parsed: undefined,
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Base64 → Uint8Array. This adapter is packaged for the Node-side
 *  headless runtime, so use the imported Node Buffer directly instead
 *  of probing `globalThis`. The old probe needed double-unknown casts
 *  and implied a browser execution path that no longer exists for this
 *  transport adapter. */
function base64ToBytes(b64: string): Uint8Array {
  return Buffer.from(b64, 'base64')
}
