// Detect Claude Code's terminal permission prompt.
//
// Permission prompts are interactive TUI state, like trust dialogs and
// resume prompts. They do not appear as durable transcript entries, so
// GUI consumers need a screen parser to render a native approval modal.

export type PermissionPromptState = {
  visible: boolean
  title?: string
  toolName?: string
  command?: string
  options?: Array<{ key: string; label: string }>
  selectedIndex?: number
}

const REQUIRED_MARKERS = [
  'Do you want to proceed?',
  'Yes',
  'No, and tell Claude',
] as const

const ASSISTANT_TOOL_RE = /^\s*⏺\s+([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?/
const TREE_LINE_RE = /^\s*⎿\s*(.+)$/
const OPTION_RE = /^\s*(?:[❯>]\s*)?(\d+)[.)]\s+(.+)$/

export function detectPermissionPrompt(screen: string): PermissionPromptState {
  if (!screen) return { visible: false }
  for (const marker of REQUIRED_MARKERS) {
    if (!screen.includes(marker)) return { visible: false }
  }

  const lines = screen.split('\n')
  let title: string | undefined
  let toolName: string | undefined
  let command: string | undefined
  const options: Array<{ key: string; label: string }> = []
  let selectedIndex: number | undefined

  for (const line of lines) {
    if (!title && line.includes('Do you want to proceed?')) {
      title = line.trim()
    }

    const tool = ASSISTANT_TOOL_RE.exec(line)
    if (tool) {
      toolName = tool[1]
      const inline = tool[2]?.trim()
      if (inline) command = inline
      continue
    }

    const tree = TREE_LINE_RE.exec(line)
    if (!command && tree?.[1]) {
      const value = tree[1].trim()
      if (value && !value.startsWith('Tip:')) command = value
    }

    const option = OPTION_RE.exec(line)
    if (option) {
      const key = option[1] ?? String(options.length + 1)
      const label = (option[2] ?? '').trim()
      if (label) {
        if (/^\s*[❯>]/.test(line)) selectedIndex = options.length
        options.push({ key, label })
      }
    }
  }

  if (options.length === 0) {
    options.push(
      { key: '1', label: 'Yes' },
      { key: '2', label: "Yes, and don't ask again" },
      { key: '3', label: 'No, and tell Claude what to do differently' },
    )
  }

  return {
    visible: true,
    title,
    toolName,
    command,
    options,
    selectedIndex,
  }
}

export const PERMISSION_PROMPT_APPROVE_KEYS = '\r'
export const PERMISSION_PROMPT_DENY_KEYS = '3\r'
