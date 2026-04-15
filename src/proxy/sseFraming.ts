// SSE framing — byte/text → framed event records.
//
// Production-path twin of the helper in testing/proxy-testing/. Promoted
// here because the proxy adapter needs framing that is independent of
// the experimental harness: experiments can disappear, the adapter
// cannot.
//
// Contract:
//   - `append(text)` buffers decoded text and returns every complete
//     SSE record found. An SSE record is terminated by `\n\n` (CRLF is
//     normalised first). A partial trailing record stays buffered until
//     the next append.
//   - `flush()` returns whatever is left in the buffer as a best-effort
//     final record, or `[]` if the buffer is empty or whitespace-only.
//
// We do text-level framing, not byte-level: the caller is responsible
// for feeding UTF-8-decoded strings, and must use a streaming decoder
// (`TextDecoder(…, { stream: true })`) so multi-byte codepoints that
// span transport chunks don't corrupt. The proxy adapter handles that.
//
// Pure: no Node, no DOM, no IO.

export type SseEvent = {
  /** The `event:` field, or `'message'` if omitted (SSE default). */
  event: string
  /** Concatenated `data:` lines with leading space trimmed on each.
   *  The caller decides whether this is JSON, text, or `[DONE]`. */
  data: string
}

export class IncrementalSseParser {
  private buffer = ''

  append(text: string): SseEvent[] {
    // Normalise CRLF upfront so the split boundary is always `\n\n`.
    // Anthropic's SSE is LF-terminated in practice, but some proxies
    // rewrite to CRLF and we don't want that to change framing
    // behavior silently.
    this.buffer += text.replace(/\r\n/g, '\n')

    const events: SseEvent[] = []
    // Repeated-slice is fine here: SSE records are small and per-turn
    // volume is bounded. A ring buffer would be premature optimisation.
    while (true) {
      const boundary = this.buffer.indexOf('\n\n')
      if (boundary === -1) break
      const chunk = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const parsed = parseSseRecord(chunk)
      if (parsed) events.push(parsed)
    }
    return events
  }

  /** Called at end-of-stream. The upstream `[DONE]` sentinel always
   *  arrives with a proper `\n\n`, so in the common case this returns
   *  []. The method exists for the abnormal case where the connection
   *  terminates mid-record: we'd rather surface the partial than
   *  silently drop it. */
  flush(): SseEvent[] {
    const tail = this.buffer.trim()
    this.buffer = ''
    return tail ? [parseSseRecord(tail)].filter(Boolean) as SseEvent[] : []
  }
}

/** Parse a single SSE record (the text between two `\n\n` boundaries).
 *  Returns `null` for empty records or ones that are entirely comments
 *  (lines starting with `:`), which SSE uses for keepalives. */
function parseSseRecord(raw: string): SseEvent | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let event = 'message'
  const dataLines: string[] = []

  for (const line of trimmed.split('\n')) {
    if (line.startsWith(':')) continue // comment / keepalive
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      // SSE spec: one leading space after `data:` is stripped; any
      // additional spaces are preserved. We implement the strict rule
      // because Anthropic emits compact `data:{...}` without a leading
      // space and we don't want to trim JSON-significant whitespace.
      const raw = line.slice('data:'.length)
      dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw)
    }
    // id: / retry: / unknown fields are ignored — Anthropic doesn't
    // send them and we don't need replay semantics here.
  }

  if (dataLines.length === 0 && event === 'message') return null
  return { event, data: dataLines.join('\n') }
}
