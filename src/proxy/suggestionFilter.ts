// Faithful, compact port of `shouldFilterSuggestion` from Claude Code's
// vendored source (vendor/claude-code-src/full/services/PromptSuggestion/
// promptSuggestion.ts:354). The fork's raw text output is frequently
// meta-noise the user never wants to see as a chip ("silence", "nothing to
// suggest"), evaluative ("looks good"), Claude-voice ("Let me…"), formatted,
// or too long. We reproduce the source's filters so our chip shows exactly
// what Claude Code itself would have shown. Kept as a pure function with no
// adapter/channel deps so it unit-tests trivially and the adapter stays thin.
//
// Returns TRUE when the suggestion should be DROPPED (not shown).

const ALLOWED_SINGLE_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yea', 'yup', 'sure', 'ok', 'okay',
  'push', 'commit', 'deploy', 'stop', 'continue', 'check', 'exit', 'quit',
  'no',
])

export function shouldFilterSuggestion(raw: string | null | undefined): boolean {
  if (!raw) return true
  const suggestion = raw.trim()
  if (!suggestion) return true

  const lower = suggestion.toLowerCase()
  const wordCount = suggestion.split(/\s+/).length

  if (lower === 'done') return true
  if (
    lower === 'nothing found' ||
    lower === 'nothing found.' ||
    lower.startsWith('nothing to suggest') ||
    lower.startsWith('no suggestion') ||
    /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
    /^\W*silence\W*$/.test(lower)
  ) return true
  // Meta wrapped in parens/brackets.
  if (/^\(.*\)$|^\[.*\]$/.test(suggestion)) return true
  if (
    lower.startsWith('api error:') ||
    lower.startsWith('prompt is too long') ||
    lower.startsWith('request timed out') ||
    lower.startsWith('invalid api key') ||
    lower.startsWith('image was too large')
  ) return true
  // "Label: value" preface.
  if (/^\w+:\s/.test(suggestion)) return true
  // Too few words (allow slash commands + known single-word actions).
  if (wordCount < 2 && !suggestion.startsWith('/') && !ALLOWED_SINGLE_WORDS.has(lower)) {
    return true
  }
  if (wordCount > 12) return true
  if (suggestion.length >= 100) return true
  if (/[.!?]\s+[A-Z]/.test(suggestion)) return true // multiple sentences
  if (/[\n*]|\*\*/.test(suggestion)) return true // formatting
  if (/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(lower)) {
    return true
  }
  if (/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(suggestion)) {
    return true
  }
  return false
}
