// Detect Claude Code's resume-choice prompt from a screen snapshot.
//
// CC shows this when resuming a large/old session where loading the
// full transcript would consume a substantial portion of the user's
// context window. The screen is interactive and looks roughly like:
//
//   This session is 14h 5m old and 305.8k tokens.
//   Resuming the full session will consume a substantial portion...
//     1. Resume from summary (recommended)
//   ❯ 2. Resume full session as-is
//     3. Don't ask me again
//   Enter to confirm · Esc to cancel
//
// We keep this separate from ScreenParser so consumers can handle the
// modal as a structured UI state, the same way they do for trust dialogs.

export type ResumePromptState = {
  /** True if CC is currently showing the resume-choice prompt. */
  visible: boolean
  /** The age string from "This session is <age> old ..." */
  sessionAgeText?: string
  /** The token count string from "... and <tokens> tokens." */
  tokenCountText?: string
  /** Currently selected option (0-indexed), based on the `❯` marker. */
  selectedIndex?: number
}

const SESSION_INFO_RE = /This session is\s+(.+?)\s+old and\s+(.+?)\s+tokens\./
const RECOMMENDATION_MARKER =
  'Resuming the full session will consume a substantial portion of your usage limits.'
const SUMMARY_LABEL = 'Resume from summary'
const FULL_LABEL = 'Resume full session as-is'
const DONT_ASK_LABEL = "Don't ask me again"
const FOOTER_ENTER = 'Enter'
const FOOTER_ESC = 'Esc'

const OPTION_PATTERNS = [
  new RegExp(String.raw`^\s*(❯?)\s*1\.\s+${escapeRegex(SUMMARY_LABEL)}(?:\s+\(recommended\))?\s*$`),
  new RegExp(String.raw`^\s*(❯?)\s*2\.\s+${escapeRegex(FULL_LABEL)}\s*$`),
  new RegExp(String.raw`^\s*(❯?)\s*3\.\s+${escapeRegex(DONT_ASK_LABEL)}\s*$`),
]

export function detectResumePrompt(screen: string): ResumePromptState {
  if (!screen) return { visible: false }
  const lines = screen.split('\n')

  let sessionAgeText: string | undefined
  let tokenCountText: string | undefined
  let anchorIdx = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const info = SESSION_INFO_RE.exec(line)
    if (info) {
      sessionAgeText = info[1].trim()
      tokenCountText = info[2].trim()
      anchorIdx = i
      break
    }
  }

  if (anchorIdx === -1) return { visible: false }

  const windowLines = lines.slice(anchorIdx, anchorIdx + 12)
  const windowText = windowLines.join('\n')
  if (!windowText.includes(RECOMMENDATION_MARKER)) return { visible: false }
  if (!windowText.includes(FOOTER_ENTER) || !windowText.includes(FOOTER_ESC)) {
    return { visible: false }
  }

  let selectedIndex = 0
  for (let i = 0; i < OPTION_PATTERNS.length; i++) {
    const line = windowLines.find(l => OPTION_PATTERNS[i].test(l))
    const match = line ? OPTION_PATTERNS[i].exec(line) : null
    if (!match) return { visible: false }
    if (match[1] === '❯') selectedIndex = i
  }

  return {
    visible: true,
    sessionAgeText,
    tokenCountText,
    selectedIndex,
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
