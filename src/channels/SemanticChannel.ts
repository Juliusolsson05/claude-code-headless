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
  SemanticSignatureEvent,
  SemanticSource,
  SemanticSourceChangedEvent,
  SemanticStreamErrorEvent,
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
   * Begin a semantic turn. If a turn was already active this is a
   * no-op — callers should finalize the prior turn first. We tolerate
   * the no-op rather than throw because both JSONL and screen can
   * race to announce a new turn, and throwing would make the caller
   * responsible for synchronising producers that inherently can't be.
   */
  startTurn(params: {
    turnId: string
    role: 'user' | 'assistant'
    source: SemanticSource
    confidence?: SemanticTurnStartedEvent['confidence']
  }): void {
    if (this.activeTurnId === params.turnId) return

    // If the previous turn never got a `turn_completed`, emit one now
    // with the text we had so consumers can flush their live buffer
    // instead of silently losing it. This matters when screen-driven
    // idle detection missed the end of the previous turn and JSONL
    // announces the next one directly.
    if (this.activeTurnId) {
      this.finishTurn({
        turnId: this.activeTurnId,
        fullText: this.lastFullText || undefined,
        source: this.lastSource ?? params.source,
        confidence: 'medium',
      })
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
    }
    this.emit('turn_started', ev)
    this.emit('event', ev)
  }

  /**
   * Publish a delta for the active turn. `fullText` is required (late
   * subscribers rely on it); `textDelta` is optional because
   * screen-sourced updates give snapshots, not increments. Callers
   * are expected to compute `textDelta` when they can (proxy SSE
   * naturally does; screen adapters can diff against `getLastFullText`).
   */
  applyDelta(params: {
    turnId: string
    fullText: string
    textDelta?: string
    markdownText?: string
    source: SemanticSource
    confidence?: SemanticTurnDeltaEvent['confidence']
  }): void {
    // Idempotency guard. Screen snapshots fire at ~60Hz; many of them
    // carry no new text. Suppressing no-ops at the channel boundary
    // means downstream markdown renderers don't have to be clever.
    if (
      this.activeTurnId === params.turnId &&
      this.lastFullText === params.fullText &&
      !params.textDelta
    ) {
      return
    }

    // Source switch mid-turn (screen → proxy, typically). Emit the
    // dedicated event BEFORE the delta so consumers can reset any
    // rendering state that was tied to the lower-trust source.
    if (
      this.activeTurnId === params.turnId &&
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

    // Auto-start a turn if a delta arrives without a prior `startTurn`.
    // Happens when JSONL announces an assistant entry we didn't see
    // coming. Cheaper to heal here than to force every caller to
    // orchestrate start/delta ordering.
    if (this.activeTurnId !== params.turnId) {
      this.startTurn({
        turnId: params.turnId,
        role: 'assistant',
        source: params.source,
      })
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
   * Finalize the active turn. Idempotent: emitting twice for the same
   * turnId is a no-op, which matters because both the idle detector
   * and the JSONL commit can legitimately think they're the one that
   * ended the turn. Whichever arrives first wins; the second is
   * dropped.
   */
  finishTurn(params: {
    turnId: string
    fullText?: string
    source: SemanticSource
    confidence?: SemanticTurnCompletedEvent['confidence']
  }): void {
    if (this.activeTurnId !== params.turnId) return

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
}
