export type SseEvent = {
  event: string
  data: string
}

export class IncrementalSseParser {
  private buffer = ''

  append(text: string): SseEvent[] {
    this.buffer += text.replace(/\r\n/g, '\n')
    const events: SseEvent[] = []

    while (true) {
      const boundary = this.buffer.indexOf('\n\n')
      if (boundary === -1) break
      const chunk = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const parsed = parseSseStream(chunk)
      if (parsed.length > 0) events.push(...parsed)
    }

    return events
  }

  flush(): SseEvent[] {
    const tail = this.buffer.trim()
    this.buffer = ''
    return tail ? parseSseStream(tail) : []
  }
}

export type AnthropicStreamEvent =
  | { type: 'message_start'; raw: Record<string, unknown> }
  | { type: 'message_stop'; raw: Record<string, unknown> }
  | { type: 'content_block_start'; raw: Record<string, unknown> }
  | { type: 'content_block_stop'; raw: Record<string, unknown> }
  | {
      type: 'text_delta'
      index?: number
      text: string
      raw: Record<string, unknown>
    }
  | {
      type: 'thinking_delta'
      index?: number
      thinking: string
      raw: Record<string, unknown>
    }
  | {
      type: 'other'
      eventType: string
      raw: Record<string, unknown>
    }

export function parseSseStream(text: string): SseEvent[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const chunks = normalized.split('\n\n')
  const events: SseEvent[] = []

  for (const chunk of chunks) {
    const trimmed = chunk.trim()
    if (!trimmed) continue

    let event = 'message'
    const dataLines: string[] = []

    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart())
      }
    }

    events.push({
      event,
      data: dataLines.join('\n'),
    })
  }

  return events
}

export function parseAnthropicEvents(text: string): AnthropicStreamEvent[] {
  return parseAnthropicEventsFromSse(parseSseStream(text))
}

export function parseAnthropicEventsFromSse(
  sseEvents: SseEvent[],
): AnthropicStreamEvent[] {
  const out: AnthropicStreamEvent[] = []

  for (const sse of sseEvents) {
    if (!sse.data || sse.data === '[DONE]') continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(sse.data) as Record<string, unknown>
    } catch {
      continue
    }

    const type = String(parsed.type ?? sse.event)
    switch (type) {
      case 'message_start':
        out.push({ type: 'message_start', raw: parsed })
        break
      case 'message_stop':
        out.push({ type: 'message_stop', raw: parsed })
        break
      case 'content_block_start':
        out.push({ type: 'content_block_start', raw: parsed })
        break
      case 'content_block_stop':
        out.push({ type: 'content_block_stop', raw: parsed })
        break
      case 'content_block_delta': {
        const delta = parsed.delta as Record<string, unknown> | undefined
        const index = typeof parsed.index === 'number' ? parsed.index : undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          out.push({
            type: 'text_delta',
            index,
            text: delta.text,
            raw: parsed,
          })
        } else if (
          delta?.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          out.push({
            type: 'thinking_delta',
            index,
            thinking: delta.thinking,
            raw: parsed,
          })
        } else {
          out.push({
            type: 'other',
            eventType: type,
            raw: parsed,
          })
        }
        break
      }
      default:
        out.push({
          type: 'other',
          eventType: type,
          raw: parsed,
        })
        break
    }
  }

  return out
}
