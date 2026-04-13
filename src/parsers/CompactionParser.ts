// Detect Claude Code's compaction UI from a screen snapshot.
//
// We keep this intentionally narrow. The parser only matches the real
// Claude compaction screen states we have observed:
//
//   ✽ Compacting conversation… (1m 51s)
//   Error during compaction: Conversation too long...
//   ✻ Conversation compacted (ctrl+o for history)
//   ⎿  Compacted (ctrl+o to see full summary)

export type CompactionState = {
  visible: boolean
  phase?: 'running' | 'error' | 'done'
  statusText?: string
  errorText?: string
}

const RUNNING_RE = /^\s*[^\w\s]\s+Compacting conversation…(?:\s+\([^)]+\))?\s*$/
const ERROR_RE = /Error during compaction:\s*(.+?)\s*$/
const DONE_BANNER_RE = /^\s*[^\w\s]\s+Conversation compacted(?:\s+\(ctrl\+o\s+for\s+history\))?\s*$/
const DONE_STDOUT_RE = /Compacted \(ctrl\+o to see full summary\)/

export function detectCompaction(screen: string): CompactionState {
  if (!screen) return { visible: false }
  const lines = screen.split('\n')

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    const error = ERROR_RE.exec(line)
    if (error) {
      return {
        visible: true,
        phase: 'error',
        errorText: error[1].trim(),
      }
    }
    if (RUNNING_RE.test(line)) {
      return {
        visible: true,
        phase: 'running',
        statusText: line.trim(),
      }
    }
    if (DONE_BANNER_RE.test(line) || DONE_STDOUT_RE.test(line)) {
      return {
        visible: true,
        phase: 'done',
        statusText: line.trim(),
      }
    }
  }

  return { visible: false }
}
