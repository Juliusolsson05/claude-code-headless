// claude-code-headless — programmatic control of Claude Code via headless terminal.
//
// Main entry point. Exports the high-level ClaudeCodeHeadless class
// plus all the primitives it composes for consumers who want finer
// control.

// --- Main API ---
export {
  ClaudeCodeHeadless,
  type ClaudeCodeHeadlessOptions,
  type ClaudeCodeHeadlessEvents,
  type HeadlessEvent,
  type ActivityEvent,
  type IdleEvent,
  type ScreenEvent,
  type JsonlEntryEvent,
  type TrustDialogEvent,
  type ResumePromptEvent,
  type PermissionPromptEvent,
  type CompactionStateEvent,
  type SlashPickerEvent,
  type ConditionsEvent,
  type ExitEvent,
} from './ClaudeCodeHeadless.js'

// --- Conditions framework (PR-3) ---
// The ordered module registry, the generic evaluator, and the typed snapshot
// shapes. Exported from the package index exactly as codex-headless exports
// CODEX_MODULES + makeEvaluator, so the host app (and any other consumer) can
// drive Claude conditions through the registry. ClaudeConditionSnapshot is the
// wire type claudeSession forwards to the renderer relay.
export {
  CLAUDE_MODULES,
  makeEvaluator,
  trustDialogModule,
  permissionPromptModule,
  resumePromptModule,
  compactionModule,
  buildClaudeTrustDialogCondition,
  buildClaudePermissionPromptCondition,
  buildClaudeResumePromptCondition,
  buildClaudeCompactionCondition,
  type ConditionEvaluator,
  type ClaudeCondition,
  type ClaudeConditionInputs,
  type ClaudeConditionKind,
  type ClaudeConditionMap,
  type ClaudeConditionSnapshot,
  type ConditionAction,
  type ConditionPtyAction,
  type ConditionCustomAction,
} from './conditions/index.js'

// --- Terminal ---
export {
  HeadlessTerminal,
  type HeadlessTerminalOptions,
  type HeadlessTerminalEvents,
  type ScreenSnapshot,
  terminalToMarkdown,
} from './terminal/HeadlessTerminal.js'

// --- Parsers ---
export {
  // Screen structure
  extractStreamingText,
  extractAssistantInProgress,
  isChromeLine,
  isDividerLine,
  isPromptLine,
  isUserPromptLine,
  isStatusLine,
  isIntermediateChromeLine,
  ASSISTANT_LINE_MARKER,
  // Activity detection
  detectActivity,
} from './parsers/ScreenParser.js'

export {
  detectTrustDialog,
  TRUST_DIALOG_ACCEPT_KEYS,
  type TrustDialogState,
} from './parsers/TrustDialogParser.js'

export {
  detectPermissionPrompt,
  PERMISSION_PROMPT_APPROVE_KEYS,
  PERMISSION_PROMPT_DENY_KEYS,
  type PermissionPromptState,
} from './parsers/PermissionPromptParser.js'

export {
  detectCompaction,
  type CompactionState,
} from './parsers/CompactionParser.js'

export {
  detectResumePrompt,
  type ResumePromptState,
} from './parsers/ResumePromptParser.js'

export {
  detectSlashPicker,
  type SlashPickerState,
  type PickerItem,
} from './parsers/SlashPickerParser.js'

export {
  diffLines,
  type DiffLine,
} from './parsers/LineDiff.js'

// --- Transcript ---
export {
  type TextBlock,
  type ThinkingBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  type Message,
  type ConversationEntry,
  type CompactBoundaryEntry,
  type CompactSummaryEntry,
  type SystemEntry,
  type Entry,
  isConversationEntry,
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
} from './transcript/TranscriptTypes.js'

export {
  tailNewSessionFile,
  tailSessionFile,
  type JsonlEntry,
} from './transcript/JsonlTailer.js'

export {
  listSessionsForCwd,
  type SessionInfo,
} from './transcript/SessionList.js'

export {
  getProjectDirForCwd,
} from './transcript/ProjectDir.js'

// --- Channels (three-channel truth model) ---
//
// Subscribe to `claude.semantic`, `claude.screen`, and
// `claude.committed` on a ClaudeCodeHeadless instance for the new
// split surface. The old flat `'event' | 'screen' | …` events still
// fire so existing Agent Code consumers keep working while they migrate.
export {
  SemanticChannel,
  type SemanticChannelEvents,
} from './channels/SemanticChannel.js'
export {
  ScreenChannel,
  type ScreenChannelEvents,
} from './channels/ScreenChannel.js'
export {
  CommittedChannel,
  type CommittedChannelEvents,
} from './channels/CommittedChannel.js'
// NOTE: the top-level `ScreenEvent` below (from channels/types) is
// exported under an alias — the legacy flat-surface `ScreenEvent`
// exported by ClaudeCodeHeadless.ts already occupies that name for
// existing Agent Code consumers. Alias keeps both surfaces co-existing
// until the legacy name is deprecated.
export type {
  // Turn-level aggregate (backward compatible)
  SemanticSource,
  SemanticConfidence,
  SemanticEvent,
  SemanticTurnStartedEvent,
  SemanticTurnDeltaEvent,
  SemanticTurnCompletedEvent,
  SemanticSourceChangedEvent,
  // Block-level semantic stream (proxy-driven)
  SemanticBlockRef,
  SemanticBlockKind,
  SemanticBlockStartedEvent,
  SemanticTextDeltaEvent,
  SemanticThinkingDeltaEvent,
  SemanticSignatureEvent,
  SemanticToolInputDeltaEvent,
  SemanticToolInputFinalizedEvent,
  SemanticBlockCompletedEvent,
  // Cross-turn + lifecycle
  SemanticToolResultEvent,
  SemanticTurnStoppedEvent,
  SemanticUsageEvent,
  // Errors + diagnostics
  SemanticStreamErrorEvent,
  SemanticApiErrorEvent,
  SemanticFlowSelectedEvent,
  SemanticFlowIgnoredEvent,
  // Screen channel
  ScreenEvent as ChannelScreenEvent,
  ScreenSnapshotEvent,
  ScreenActivityEvent,
  ScreenTrustDialogEvent as ChannelTrustDialogEvent,
  ScreenResumePromptEvent as ChannelResumePromptEvent,
  ScreenCompactionEvent,
  ScreenSlashPickerEvent,
  // Committed channel
  CommittedEvent,
  CommittedTurnEvent,
  CommittedEntryEvent,
  CommittedCompactBoundaryEvent,
} from './channels/types.js'

// --- Proxy live-streaming adapter (optional) ---
//
// The `ClaudeProxyAdapter` takes transport-level events emitted by a
// mitmproxy-style runtime (request / response-chunk / response-end /
// response) and drives the SemanticChannel with structured per-block
// events. Consumers that want proxy-backed live rendering instantiate
// the adapter, wire their proxy runtime's event stream into
// `handleTransportEvent`, and subscribe to the SemanticChannel.
//
// This surface is optional — ClaudeCodeHeadless stays functional
// without it. See PROXY_STREAMING.md + EVENT_SPEC.md for protocol
// details.
export {
  ClaudeProxyAdapter,
  createDefaultAttributionPolicy,
  defaultAttributionPolicy,
  type ClaudeProxyAdapterOptions,
  type ProxyTransportEvent,
  type AttributionContext,
  type AttributionPolicy,
  type FlowAttribution,
} from './proxy/ClaudeProxyAdapter.js'
export {
  IncrementalSseParser,
  type SseEvent,
} from './proxy/sseFraming.js'
// --- Proxy runtime (mitmproxy launcher) ---
//
// This is the runtime that spawns `mitmdump` and surfaces its addon
// events over a JSONL file. Used by downstream apps (Agent Code) that
// want a production proxy-driven session. The caller must have
// mitmproxy installed — it is an external dependency, not bundled.
export {
  ProxyServer,
  createProxyServer,
  type ProxyServerInfo,
  type ProxyServerEvents,
  type ProxyCapturedEvent,
} from './proxy/proxyServer.js'
export {
  spawnClaudeWithProxy,
  type SpawnClaudeWithProxyOptions,
} from './proxy/spawnClaudeWithProxy.js'

export {
  parseAnthropicEventsFromSse,
  type AnthropicStreamEvent,
  type AnthropicMessageStart,
  type AnthropicContentBlockStart,
  type AnthropicTextDelta,
  type AnthropicInputJsonDelta,
  type AnthropicThinkingDelta,
  type AnthropicSignatureDelta,
  type AnthropicConnectorTextDelta,
  type AnthropicCitationsDelta,
  type AnthropicUnknownDelta,
  type AnthropicContentBlockStop,
  type AnthropicMessageDelta,
  type AnthropicMessageStop,
  type AnthropicPing,
  type AnthropicErrorEvent,
  type AnthropicOther,
  type AnthropicUsage,
  type ParsedContentBlockStart,
} from './proxy/anthropicEvents.js'
