import { EventEmitter } from 'events'

import type {
  SemanticApiErrorEvent,
  SemanticBlockCompletedEvent,
  SemanticBlockKind,
  SemanticBlockStartedEvent,
  SemanticConfidence,
  SemanticConnectorTextDeltaEvent,
  SemanticCitationsDeltaEvent,
  SemanticEvent,
  SemanticFlowIgnoredEvent,
  SemanticFlowSelectedEvent,
  SemanticLifecycleViolationEvent,
  SemanticProviderSessionObservedEvent,
  SemanticPromptSuggestionEvent,
  SemanticSignatureEvent,
  SemanticSource,
  SemanticSourceChangedEvent,
  SemanticStreamErrorEvent,
  SemanticStreamPhaseEvent,
  SemanticTextDeltaEvent,
  SemanticThinkingDeltaEvent,
  SemanticToolInputDeltaEvent,
  SemanticToolInputFinalizedEvent,
  SemanticToolResultEvent,
  SemanticTurnCompletedEvent,
  SemanticTurnDeltaEvent,
  SemanticTurnStartedEvent,
  SemanticTurnStoppedEvent,
  SemanticUsageEvent,
  StreamPhase,
} from './types.js'

// SemanticChannel — the "what the model is producing right now" stream.
//
// WHY this is its own class (instead of a bare EventEmitter on the
// top-level Headless class):
//
// 1. The channel owns a tiny bit of state — the currently-active
//    turnId and the last-known live source. Without this state we
//    cannot emit `source_changed` correctly, and consumers can't
//    reconcile when proxy takes over from screen mid-turn.
//
// 2. It gives the package a single obvious place to route new sources
//    through. Today we feed it from JSONL + screen; tomorrow we feed
//    it from the proxy stream too (see PROXY_STREAMING.md). The
//    mechanics of "start a turn / apply a delta / finish a turn" are
//    the same for every source, so centralising them here prevents
//    every adapter from reinventing its own lifecycle.
//
// 3. It keeps the top-level `ClaudeCodeHeadless` class from becoming
//    a god-object. The three channels are meant to be composable —
//    eventually the screen parser subsystem should be swappable and
//    the committed adapter should be usable standalone. Channel
//    classes are the seam that makes that refactor possible later.
//
// This class NEVER fires for non-semantic state (trust dialogs, picker
// changes, …). Those belong on `ScreenChannel`. If you find yourself
// wanting to emit visual-only state here, stop — you are re-creating
// the entwined surface that this whole split was meant to kill.
//
// -----------------------------------------------------------------------
// Lifecycle strictness (2026-04-18 redesign).
// -----------------------------------------------------------------------
//
// Prior versions of this channel auto-sealed mismatched turns and
// auto-started turns on delta-without-start. That behaviour was
// defensible when screen was the only live producer — races between
// the idle detector and the JSONL tailer genuinely did happen and
// someone had to paper over them. It became actively harmful once
// proxy streaming landed: two authoritative producers could push
// onto the same channel, the channel's auto-heal would flip
// `activeTurnId` between them, and the renderer reducer would keep
// wiping its block map on every flip (see the Codex semantic flicker
// plan, 2026-04-17).
//
// The fix is to make the channel strict:
//
//   * `startTurn` while another turn is active → DROP, emit
//     `lifecycle_violation`. Callers must explicitly `finishTurn` the
//     previous turn before opening a new one.
//
//   * `applyDelta` with a turnId that does not match the active turn
//     (or with no active turn at all) → DROP, emit
//     `lifecycle_violation`. Callers must `startTurn` first.
//
//   * `finishTurn` with a mismatched turnId → DROP (unchanged), emit
//     `lifecycle_violation` so dashboards can see the miss.
//
// The channel is now a transport, not a healer. Producer coherence is
// enforced by the orchestrator (ClaudeCodeHeadless / CodexHeadless)
// via the LiveOwner ownership model — see
// `claude-code-headless/src/channels/types.ts` for the ownership types
// and `2026-04-18-headless-live-turn-redesign.md` for the full plan.

export type SemanticChannelEvents = {
  event: [SemanticEvent]
  // Turn-level aggregate (backward compatible — screen fallback path
  // still emits these; proxy adapter also emits them alongside
  // block-level events for consumers that only want rolled-up text).
  turn_started: [SemanticTurnStartedEvent]
  turn_delta: [SemanticTurnDeltaEvent]
  turn_completed: [SemanticTurnCompletedEvent]
  source_changed: [SemanticSourceChangedEvent]

  // Block-level semantic stream (proxy-driven). Consumers that render
  // per-block UI (thinking, tool calls, interleaved text) subscribe
  // to these.
  block_started: [SemanticBlockStartedEvent]
  text_delta: [SemanticTextDeltaEvent]
  thinking_delta: [SemanticThinkingDeltaEvent]
  signature: [SemanticSignatureEvent]
  connector_text_delta: [SemanticConnectorTextDeltaEvent]
  citations_delta: [SemanticCitationsDeltaEvent]
  tool_input_delta: [SemanticToolInputDeltaEvent]
  tool_input_finalized: [SemanticToolInputFinalizedEvent]
  block_completed: [SemanticBlockCompletedEvent]

  // Cross-turn linkage
  tool_result: [SemanticToolResultEvent]

  // Turn lifecycle beyond start/delta/complete
  turn_stopped: [SemanticTurnStoppedEvent]
  usage_updated: [SemanticUsageEvent]

  // Errors
  stream_error: [SemanticStreamErrorEvent]
  api_error: [SemanticApiErrorEvent]

  // Attribution diagnostics
  flow_selected: [SemanticFlowSelectedEvent]
  flow_ignored: [SemanticFlowIgnoredEvent]
  provider_session_observed: [SemanticProviderSessionObservedEvent]

  // Ephemeral next-prompt suggestion (issue #174). NOT a turn — routed to
  // a composer chip, never folded into history.
  prompt_suggestion: [SemanticPromptSuggestionEvent]

  // Upstream stream-phase derivation. Mirrors Claude Code's
  // `streamMode` state machine (utils/messages.ts:2929). Emitted by the
  // proxy adapter at `content_block_start` / `message_stop` /
  // `content_block_stop` transitions; by the screen-spinner path as a
  // coarser `thinking` / `idle` fallback when proxy is off.
  stream_phase: [SemanticStreamPhaseEvent]

  // Lifecycle-violation diagnostics. Fires when a publisher calls in
  // with a turnId that does not match the active turn. Intentionally
  // NOT emitted on the catch-all `'event'` stream — see the rationale
  // in channels/types.ts for why lifecycle violations stay off the
  // reducer-facing `SemanticEvent` union.
  lifecycle_violation: [SemanticLifecycleViolationEvent]
}

export interface SemanticChannel {
  on<K extends keyof SemanticChannelEvents>(
    event: K,
    listener: (...args: SemanticChannelEvents[K]) => void,
  ): this
  off<K extends keyof SemanticChannelEvents>(
    event: K,
    listener: (...args: SemanticChannelEvents[K]) => void,
  ): this
  emit<K extends keyof SemanticChannelEvents>(
    event: K,
    ...args: SemanticChannelEvents[K]
  ): boolean
}

export class SemanticChannel extends EventEmitter {
  private activeTurnId: string | null = null
  private activeRole: 'user' | 'assistant' | null = null
  private lastSource: SemanticSource | null = null
  private lastFullText = ''

  getActiveTurnId(): string | null {
    return this.activeTurnId
  }

  getLastSource(): SemanticSource | null {
    return this.lastSource
  }

  /** Last known text for the active turn. Handy for late subscribers
   *  or for building a screen/proxy reconciler that needs to know
   *  what's already been published. */
  getLastFullText(): string {
    return this.lastFullText
  }

  /**
   * Begin a semantic turn.
   *
   * Strict lifecycle rules (see file header):
   *
   *   * Same-turn re-entry is an idempotent no-op. Producers that
   *     legitimately promote their own turn (e.g. proxy seeing a
   *     duplicate `message_start` on SSE reconnect) must see
   *     unchanged state.
   *
   *   * Attempting to open a turn while a DIFFERENT turn is already
   *     active is a protocol violation. We DROP the new start and
   *     emit a `lifecycle_violation` event so dashboards can see it.
   *     The previous auto-seal behaviour was removed because it hid
   *     cross-source ownership bugs (see the Codex semantic flicker
   *     plan, 2026-04-17-codex-semantic-flicker-fix.md).
   *
   * Callers who legitimately need to replace the active turn must
   * call `finishTurn(activeTurnId, …)` first — the orchestrator's
   * ownership helpers do this as part of `transitionLiveOwner`.
   */
  startTurn(params: {
    turnId: string
    role: 'user' | 'assistant'
    source: SemanticSource
    confidence?: SemanticTurnStartedEvent['confidence']
    /** Forwarded verbatim onto the emitted `turn_started` event.
     *  Set by ClaudeProxyAdapter when the request-shape sniff
     *  detected the compaction-prompt signature so the renderer can
     *  show a placeholder instead of raw <analysis>/<summary> XML.
     *  See SemanticTurnStartedEvent.isCompactionSynthesis for the
     *  full rationale. */
    isCompactionSynthesis?: boolean
  }): void {
    if (this.activeTurnId === params.turnId) return

    if (this.activeTurnId) {
      const violation: SemanticLifecycleViolationEvent = {
        type: 'lifecycle_violation',
        kind: 'start_while_active',
        attemptedTurnId: params.turnId,
        activeTurnId: this.activeTurnId,
        source: params.source,
        ts: Date.now(),
      }
      this.emit('lifecycle_violation', violation)
      return
    }

    this.activeTurnId = params.turnId
    this.activeRole = params.role
    this.lastSource = params.source
    this.lastFullText = ''

    const ev: SemanticTurnStartedEvent = {
      type: 'turn_started',
      turnId: params.turnId,
      role: params.role,
      source: params.source,
      confidence: params.confidence ?? (params.source === 'screen' ? 'fallback' : 'high'),
      ts: Date.now(),
      // Only attach the flag when the caller opted in. Leaving the
      // field absent (vs. explicitly `false`) keeps event payloads
      // byte-identical for non-Claude sources, which matters for the
      // golden fixture tests downstream of the channel.
      ...(params.isCompactionSynthesis ? { isCompactionSynthesis: true } : {}),
    }
    this.emit('turn_started', ev)
    this.emit('event', ev)
  }

  /**
   * Publish a delta for the active turn.
   *
   * Strict lifecycle rules (see file header):
   *
   *   * If no turn is active, or the caller's turnId does not match
   *     the active turn, the delta is DROPPED. A
   *     `lifecycle_violation` event fires so debug tooling can see
   *     the miss without console noise. The old auto-start behaviour
   *     was removed because it lets any racing producer silently
   *     take over the active turn slot.
   *
   *   * Same-turn snapshots with unchanged text and no explicit
   *     textDelta are still suppressed — this is a cadence optimization
   *     (screen fires ~60Hz), not a lifecycle decision.
   *
   *   * A same-turn source change still emits `source_changed`
   *     before the delta, so consumers that want to reset optimistic
   *     rendering on promotion (screen→proxy) keep their hook.
   *
   * `fullText` is required (late subscribers rely on it); `textDelta`
   * is optional because screen-sourced updates give snapshots, not
   * increments. Callers compute `textDelta` when they can (proxy SSE
   * naturally does; screen adapters diff against `getLastFullText`).
   */
  applyDelta(params: {
    turnId: string
    fullText: string
    textDelta?: string
    markdownText?: string
    source: SemanticSource
    confidence?: SemanticTurnDeltaEvent['confidence']
  }): void {
    if (this.activeTurnId !== params.turnId) {
      const violation: SemanticLifecycleViolationEvent = {
        type: 'lifecycle_violation',
        kind: 'delta_mismatched_turn',
        attemptedTurnId: params.turnId,
        activeTurnId: this.activeTurnId,
        source: params.source,
        ts: Date.now(),
      }
      this.emit('lifecycle_violation', violation)
      return
    }

    if (this.lastFullText === params.fullText && !params.textDelta) {
      return
    }

    if (
      this.lastSource !== null &&
      this.lastSource !== params.source
    ) {
      const ev: SemanticSourceChangedEvent = {
        type: 'source_changed',
        turnId: params.turnId,
        previousSource: this.lastSource,
        source: params.source,
        confidence: params.confidence ?? 'high',
        ts: Date.now(),
      }
      this.emit('source_changed', ev)
      this.emit('event', ev)
    }

    this.lastSource = params.source
    this.lastFullText = params.fullText

    const ev: SemanticTurnDeltaEvent = {
      type: 'turn_delta',
      turnId: params.turnId,
      textDelta: params.textDelta,
      fullText: params.fullText,
      markdownText: params.markdownText,
      source: params.source,
      confidence: params.confidence ?? (params.source === 'screen' ? 'fallback' : 'high'),
      ts: Date.now(),
    }
    this.emit('turn_delta', ev)
    this.emit('event', ev)
  }

  /**
   * Finalize the active turn.
   *
   * Idempotent by design: two producers (idle detector + JSONL
   * commit) can legitimately both believe they ended the same turn.
   * Whichever arrives first wins; the second is DROPPED and a
   * `lifecycle_violation` event fires so debug tooling can count the
   * misses. Dropping is safe because `turn_completed` has already
   * fired; the duplicate would only confuse late subscribers.
   */
  finishTurn(params: {
    turnId: string
    fullText?: string
    source: SemanticSource
    confidence?: SemanticTurnCompletedEvent['confidence']
  }): void {
    if (this.activeTurnId !== params.turnId) {
      const violation: SemanticLifecycleViolationEvent = {
        type: 'lifecycle_violation',
        kind: 'finish_mismatched_turn',
        attemptedTurnId: params.turnId,
        activeTurnId: this.activeTurnId,
        source: params.source,
        ts: Date.now(),
      }
      this.emit('lifecycle_violation', violation)
      return
    }

    const ev: SemanticTurnCompletedEvent = {
      type: 'turn_completed',
      turnId: params.turnId,
      fullText: params.fullText ?? (this.lastFullText || undefined),
      source: params.source,
      confidence: params.confidence ?? (params.source === 'screen' ? 'fallback' : 'high'),
      ts: Date.now(),
    }
    this.emit('turn_completed', ev)
    this.emit('event', ev)

    this.activeTurnId = null
    this.activeRole = null
    this.lastSource = null
    this.lastFullText = ''
  }

  // ---------------------------------------------------------------------
  // Block-level publishers.
  //
  // Intentionally stateless relays. The state machine above
  // (activeTurnId / lastSource / lastFullText) exists because the
  // screen fallback path needs it — we have to synthesise turns from
  // idle transitions. The block-level path is driven by the real
  // upstream stream (`content_block_start` / `content_block_delta` /
  // `content_block_stop`), which is already structured, so we pass
  // events through without reinterpreting them.
  //
  // Confidence defaulting follows the same rule as the turn-level
  // helpers: proxy/jsonl → 'high', screen → 'fallback'. Caller can
  // override when they know better (e.g. proxy with an unselected
  // flow would be 'medium').
  // ---------------------------------------------------------------------

  private defaultConfidence(source: SemanticSource): SemanticConfidence {
    return source === 'screen' ? 'fallback' : 'high'
  }

  publishBlockStarted(params: {
    turnId: string
    blockIndex: number
    kind: SemanticBlockKind
    toolName?: string
    toolUseId?: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticBlockStartedEvent = {
      type: 'block_started',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      kind: params.kind,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('block_started', ev)
    this.emit('event', ev)
  }

  publishTextDelta(params: {
    turnId: string
    blockIndex: number
    textDelta: string
    textSoFar: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticTextDeltaEvent = {
      type: 'text_delta',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      textDelta: params.textDelta,
      textSoFar: params.textSoFar,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('text_delta', ev)
    this.emit('event', ev)
  }

  publishThinkingDelta(params: {
    turnId: string
    blockIndex: number
    thinkingDelta: string
    thinkingSoFar: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticThinkingDeltaEvent = {
      type: 'thinking_delta',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      thinkingDelta: params.thinkingDelta,
      thinkingSoFar: params.thinkingSoFar,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('thinking_delta', ev)
    this.emit('event', ev)
  }

  publishSignature(params: {
    turnId: string
    blockIndex: number
    signature: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticSignatureEvent = {
      type: 'signature',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      signature: params.signature,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('signature', ev)
    this.emit('event', ev)
  }

  publishConnectorTextDelta(params: {
    turnId: string
    blockIndex: number
    connectorTextDelta: string
    connectorTextSoFar: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticConnectorTextDeltaEvent = {
      type: 'connector_text_delta',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      connectorTextDelta: params.connectorTextDelta,
      connectorTextSoFar: params.connectorTextSoFar,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('connector_text_delta', ev)
    this.emit('event', ev)
  }

  publishCitationsDelta(params: {
    turnId: string
    blockIndex: number
    citationsDelta: unknown
    citationsSoFar: unknown[]
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticCitationsDeltaEvent = {
      type: 'citations_delta',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      citationsDelta: params.citationsDelta,
      citationsSoFar: params.citationsSoFar,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('citations_delta', ev)
    this.emit('event', ev)
  }

  publishToolInputDelta(params: {
    turnId: string
    blockIndex: number
    toolName: string
    toolUseId: string
    partialJson: string
    inputJsonSoFar: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticToolInputDeltaEvent = {
      type: 'tool_input_delta',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      partialJson: params.partialJson,
      inputJsonSoFar: params.inputJsonSoFar,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('tool_input_delta', ev)
    this.emit('event', ev)
  }

  publishToolInputFinalized(params: {
    turnId: string
    blockIndex: number
    toolName: string
    toolUseId: string
    inputJson: string
    parsed: Record<string, unknown> | undefined
    parseError?: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticToolInputFinalizedEvent = {
      type: 'tool_input_finalized',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      inputJson: params.inputJson,
      parsed: params.parsed,
      parseError: params.parseError,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('tool_input_finalized', ev)
    this.emit('event', ev)
  }

  publishBlockCompleted(params: {
    turnId: string
    blockIndex: number
    kind: SemanticBlockKind
    text?: string
    signature?: string
    toolName?: string
    toolUseId?: string
    inputJson?: string
    parsed?: Record<string, unknown>
    raw?: Record<string, unknown>
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticBlockCompletedEvent = {
      type: 'block_completed',
      turnId: params.turnId,
      blockIndex: params.blockIndex,
      kind: params.kind,
      text: params.text,
      signature: params.signature,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      inputJson: params.inputJson,
      parsed: params.parsed,
      raw: params.raw,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('block_completed', ev)
    this.emit('event', ev)
  }

  publishToolResult(params: {
    turnId: string
    toolUseId: string
    content: string
    isError: boolean
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticToolResultEvent = {
      type: 'tool_result',
      turnId: params.turnId,
      toolUseId: params.toolUseId,
      content: params.content,
      isError: params.isError,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('tool_result', ev)
    this.emit('event', ev)
  }

  publishTurnStopped(params: {
    turnId: string
    stopReason: SemanticTurnStoppedEvent['stopReason']
    syntheticErrorText?: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticTurnStoppedEvent = {
      type: 'turn_stopped',
      turnId: params.turnId,
      stopReason: params.stopReason,
      isRefusal: params.stopReason === 'refusal',
      syntheticErrorText: params.syntheticErrorText,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('turn_stopped', ev)
    this.emit('event', ev)
  }

  publishUsageUpdated(params: {
    turnId: string
    usage: SemanticUsageEvent['usage']
    costUSD?: number
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticUsageEvent = {
      type: 'usage_updated',
      turnId: params.turnId,
      usage: params.usage,
      costUSD: params.costUSD,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('usage_updated', ev)
    this.emit('event', ev)
  }

  publishStreamError(params: {
    turnId: string | null
    errorType: string
    message: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticStreamErrorEvent = {
      type: 'stream_error',
      turnId: params.turnId,
      errorType: params.errorType,
      message: params.message,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('stream_error', ev)
    this.emit('event', ev)
  }

  publishApiError(params: {
    turnId: string | null
    status?: number
    errorType?: string
    message: string
    isOverloaded?: boolean
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticApiErrorEvent = {
      type: 'api_error',
      turnId: params.turnId,
      status: params.status,
      errorType: params.errorType,
      message: params.message,
      isOverloaded: params.isOverloaded,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('api_error', ev)
    this.emit('event', ev)
  }

  publishFlowSelected(params: {
    turnId: string | null
    flowId: string
    reason: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticFlowSelectedEvent = {
      type: 'flow_selected',
      turnId: params.turnId,
      flowId: params.flowId,
      reason: params.reason,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('flow_selected', ev)
    this.emit('event', ev)
  }

  publishFlowIgnored(params: {
    flowId: string
    reason: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticFlowIgnoredEvent = {
      type: 'flow_ignored',
      flowId: params.flowId,
      reason: params.reason,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('flow_ignored', ev)
    this.emit('event', ev)
  }

  publishProviderSessionObserved(params: {
    provider: 'claude'
    providerSessionId: string
    flowId: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticProviderSessionObservedEvent = {
      type: 'provider_session_observed',
      provider: params.provider,
      providerSessionId: params.providerSessionId,
      flowId: params.flowId,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('provider_session_observed', ev)
    this.emit('event', ev)
  }

  /** Publish an ephemeral prompt suggestion. See
   *  SemanticPromptSuggestionEvent — this is deliberately NOT a turn and
   *  must never be folded into history. Emitted to both the named channel
   *  and the catch-all `event` emitter so the IPC forwarder picks it up. */
  publishPromptSuggestion(params: {
    flowId: string
    turnId: string | null
    text: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticPromptSuggestionEvent = {
      type: 'prompt_suggestion',
      flowId: params.flowId,
      turnId: params.turnId,
      text: params.text,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('prompt_suggestion', ev)
    this.emit('event', ev)
  }

  // -------------------------------------------------------------------
  // Stream-phase publisher.
  //
  // Stateful dedupe: the adapter will hit the same branch twice when
  // two consecutive deltas land on the same block kind (e.g. two
  // text_deltas on the same text block re-enter the `responding`
  // branch). Publishing a duplicate event on every delta would explode
  // the event volume with no information content, so we suppress
  // identical back-to-back phases. The dedupe is intentionally naive —
  // only (phase, turnId, toolUseId) must match. toolName change
  // without a toolUseId change (shouldn't happen) still goes through.
  // -------------------------------------------------------------------
  private lastPhase: StreamPhase = 'idle'
  private lastPhaseTurnId: string | null = null
  private lastPhaseToolUseId: string | undefined = undefined

  /** Last published phase. Adapter-internal fallbacks (screen, error
   *  paths) read this so they don't emit a redundant `idle` when the
   *  adapter has already moved on. */
  getLastPhase(): StreamPhase {
    return this.lastPhase
  }

  publishStreamPhase(params: {
    turnId: string | null
    phase: StreamPhase
    toolName?: string
    toolUseId?: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    if (
      this.lastPhase === params.phase &&
      this.lastPhaseTurnId === params.turnId &&
      this.lastPhaseToolUseId === params.toolUseId
    ) {
      return
    }
    this.lastPhase = params.phase
    this.lastPhaseTurnId = params.turnId
    this.lastPhaseToolUseId = params.toolUseId

    const ev: SemanticStreamPhaseEvent = {
      type: 'stream_phase',
      turnId: params.turnId,
      phase: params.phase,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('stream_phase', ev)
    this.emit('event', ev)
  }
}
