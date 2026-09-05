// Comparison-only normalization. Never rewrite arbitrary durations, counts or
// /rc strings: those can be real composer edits, command arguments or output.
// Global replacements made "wait 5s" and "wait 6s" equivalent (#53). Unknown
// chrome costs a full frame; it must never broaden the fast path to content.
const CLAUDE_STATUS = /^(\s*)[·✢✳✶✻✽✺] ([A-Za-z][A-Za-z' -]*…) \(((?:\d+h\s*)?(?:\d+m\s*)?\d+s)((?: · [↑↓] \d+(?:\.\d+)?k? tokens)?(?: · thinking…)?)\)[ \t]*$/
const CODEX_STATUS = /^(\s*)[•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working \((?:\d+h\s*)?(?:\d+m\s*)?\d+s • esc to interrupt\)[ \t]*$/
const TOKEN_COUNTER = /\b\d+(?:\.\d+)?k?\s+tokens\b/g
const RC_FOOTER = /^ {2}⏵⏵ bypass permissions on \(shift\+tab to cycle\).*\/rc(?: connecting…)?[ \t]*$/

export function normalizeVolatileScreenText(text: string): string {
  let insideComposer = false
  return text.split('\n').map(line => {
    // Claude's multiline composer is bounded by horizontal rules. Even a
    // pasted exact status signature inside that region is user content. Other
    // divider layouts may conservatively disable caching, which is harmless.
    if (/^\s*─{3,}\s*$/.test(line)) {
      insideComposer = !insideComposer
      return line
    }
    if (insideComposer) return line
    const claude = CLAUDE_STATUS.exec(line)
    if (claude) return claude[1] + '⋯ ' + claude[2] + ' (Ns' + claude[4]!.replace(TOKEN_COUNTER, 'N tokens') + ')'
    const codex = CODEX_STATUS.exec(line)
    if (codex) return codex[1] + '⋯ Working (Ns • esc to interrupt)'
    if (RC_FOOTER.test(line)) return line.replace(/\/rc connecting…/, '/rc').trimEnd()
    // Do not trim drafts or normalize arbitrary bullet-prefixed output.
    return line
  }).join('\n')
}
