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
  type CompactionStateEvent,
  type SlashPickerEvent,
  type ExitEvent,
} from './ClaudeCodeHeadless.js'

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
