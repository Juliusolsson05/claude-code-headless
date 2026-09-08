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

// WHY THIS IS A SHAPE TEST AND NOT A LIST OF REQUIRED SUBSTRINGS
//
// Until 2.1.143 this file gated on three substrings appearing anywhere in the
// screen: 'Do you want to proceed?', 'Yes', and 'No, and tell Claude'. By
// 2.1.263 that gate was wrong on BOTH of the strings that carried any weight,
// and the failure mode is the worst one available to us: `visible: false` on a
// live prompt means the SDK never surfaces the modal, nobody answers, and the
// turn hangs forever behind a PTY waiting on a keystroke.
//
// What upstream actually renders now (all citations are vendor/claude-code-src,
// which is the read-only 2.1.263 source drop — never imported, only grepped):
//
//   1. The reject option lost its long label. FilePermissionDialog's
//      permissionOptions.tsx:167-172 and BashPermissionRequest's
//      bashToolUseOptions.tsx:140-143 both push `{ label: 'No', value: 'no' }`.
//      'No, and tell Claude what to do differently' survives in exactly two
//      dialogs — SandboxPermissionRequest.tsx:91 and
//      WebFetchPermissionRequest.tsx:104 — plus as the *placeholder* of the
//      Tab-to-amend input variant (permissionOptions.tsx:155 / and again in
//      bashToolUseOptions.tsx:135), which is not the label and is not on screen
//      until a human presses Tab. So requiring it blinded us to Write, Edit,
//      Bash, NotebookEdit and Sed prompts — i.e. nearly every prompt that fires.
//
//   2. The question is not always 'Do you want to proceed?'. Only Bash
//      (BashPermissionRequest.tsx:464) and PowerShell (:221) use that wording.
//      FilePermissionDialog.tsx:55 merely *defaults* to it, and both file
//      callers override it: FileWritePermissionRequest.tsx:121 renders
//      'Do you want to create <basename>?' / '…overwrite <basename>?' and
//      FileEditPermissionRequest.tsx:66 renders 'Do you want to make this edit
//      to <basename>?'. WebFetch and Sandbox have their own wordings too.
//
// So the only thing every dialog shares is a *shape*, not a string: one
// 'Do you want to …?' line, immediately followed by the numbered option rows
// that CustomSelect renders, whose first option is a 'Yes…' and whose last is a
// 'No…'. That is what we match.
//
// WHY NOT JUST LOOSEN THE MARKER TO A BARE 'No' SUBSTRING — because 'No' occurs
// constantly in ordinary agent output ('Node', 'Not found', 'No changes', a
// diff hunk, a test name) and a false positive here is not a cosmetic bug: the
// consumer opens a modal and writes keystrokes into a PTY that is not waiting
// for them. When the screen is ambiguous we must return `visible: false` and
// let the human look at the terminal. Hence: 'No' only counts when it is the
// label of a *numbered option row rendered below the question line*.
const QUESTION_LINE_RE = /^Do you want to \S.*\?/

// Option rows as CustomSelect prints them. select.tsx:575 renders
// `${i}.`.padEnd(maxIndexWidth + 2) ahead of the label, and design-system's
// ListItem.tsx:127 prefixes the focused row with figures.pointer — '❯' on a
// unicode terminal, '>' on the ASCII fallback, hence both in the class.
//
// The numbers are guaranteed: `hideIndexes` defaults to false (select.tsx:217)
// and no permission dialog passes it, and `layout` defaults to 'compact'
// (select.tsx:219), which is the branch that prints the index. The 'expanded'
// layout at select.tsx:403 would print bare labels — if a future release
// switches permission dialogs to it, this regex is where detection dies, and
// the fix is to add a pointer-anchored fallback row shape.
const OPTION_RE = /^\s*(?:[❯>]\s*)?(\d+)[.)]\s+(.+)$/

// Approve/reject labels, matched at the START of an option label so that the
// prose inside a longer label can never trigger them. \b after the word keeps
// 'Not now' and 'Yesterday' out while still admitting every real variant:
//   Yes | Yes, allow all edits during this session (shift+tab)
//       | Yes, and don't ask again for npm test commands in /repo
//       | Yes, and allow Claude to edit its own settings for this session
//   No  | No, and tell Claude what to do differently   (Sandbox/WebFetch, legacy)
const APPROVE_LABEL_RE = /^Yes\b/
const REJECT_LABEL_RE = /^No\b/

const ASSISTANT_TOOL_RE = /^\s*⏺\s+([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?/
const TREE_LINE_RE = /^\s*⎿\s*(.+)$/

export function detectPermissionPrompt(screen: string): PermissionPromptState {
  if (!screen) return { visible: false }

  const lines = screen.split('\n')

  // The LAST question line wins, not the first. A screen can carry an older
  // 'Do you want to …?' that has already scrolled up into the transcript with
  // no option rows under it; anchoring on the first one would make us look for
  // options in the wrong place and report `visible: false` on a live dialog —
  // the exact hang this parser exists to prevent. The live dialog is always the
  // bottom-most thing on screen.
  let questionIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION_LINE_RE.test((lines[i] ?? '').trim())) {
      questionIndex = i
      break
    }
  }
  if (questionIndex === -1) return { visible: false }

  const title = (lines[questionIndex] ?? '').trim()

  // The tool call being approved is printed ABOVE the dialog, so only scan up
  // to the question. Last match wins: the prompt belongs to the most recent
  // tool line, and earlier ones are just transcript scrollback.
  let toolName: string | undefined
  let command: string | undefined
  for (let i = 0; i < questionIndex; i++) {
    const line = lines[i] ?? ''

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
  }

  // Option rows live strictly BELOW the question — FilePermissionDialog.tsx:173
  // and BashPermissionRequest.tsx:463 both render <Text>{question}</Text>
  // immediately followed by <Select>. Restricting the scan to that region is
  // what stops a numbered list in ordinary agent output from being mistaken for
  // the dialog's options.
  const options: Array<{ key: string; label: string }> = []
  let selectedIndex: number | undefined
  for (let i = questionIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const option = OPTION_RE.exec(line)
    if (!option) continue
    const key = option[1] ?? String(options.length + 1)
    const label = (option[2] ?? '').trim()
    if (!label) continue
    if (/^\s*[❯>]/.test(line)) selectedIndex = options.length
    options.push({ key, label })
  }

  // The Yes-before-No ordering is upstream's, not a coincidence we are leaning
  // on loosely: every dialog pushes its accept option(s) first and its reject
  // option last (bashToolUseOptions.tsx and permissionOptions.tsx both build the
  // array in that order). Requiring the order — rather than just presence — is
  // free extra evidence that these rows are a permission Select and not prose.
  const approveAt = options.findIndex((o) => APPROVE_LABEL_RE.test(o.label))
  const rejectAt = options.findIndex((o) => REJECT_LABEL_RE.test(o.label))
  if (approveAt === -1 || rejectAt === -1 || approveAt >= rejectAt) {
    return { visible: false }
  }

  // NOTE — there is no default option list any more. The old code synthesised
  // ['Yes', "Yes, and don't ask again", 'No, and tell Claude what to do
  // differently'] whenever it parsed zero rows, which is now both unreachable
  // (we only get here having matched a Yes row and a No row) and a lie: those
  // three labels are not what 2.1.263 renders. Reporting the rows we actually
  // read is the whole point — consumers key their buttons off `options`.
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
// CAVEAT, deliberately left as-is: '3\r' hard-codes "the reject option is #3".
// That holds for every file dialog (Yes / Yes-session / No) and for a Bash
// dialog that got an always-allow suggestion, but NOT for a Bash prompt with no
// suggestions, which renders only Yes / No — there '3' selects nothing and the
// prompt stays open. Fixing it means teaching the consumers (the Electron
// PermissionPromptModal and conditions/permissionPrompt.ts, which duplicate
// this keystroke as a wire contract) to read the reject row's `key` out of the
// `options` array above. That is a cross-package change and is out of scope for
// the detection fix; recorded here so the next reader does not rediscover it.
export const PERMISSION_PROMPT_DENY_KEYS = '3\r'
