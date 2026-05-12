import { EventEmitter } from 'events'

import {
  isCompactBoundaryEntry,
  isConversationEntry,
  type Entry,
} from '../transcript/TranscriptTypes.js'
import type {
  CommittedCompactBoundaryEvent,
  CommittedEntryEvent,
  CommittedEvent,
  CommittedToolResultEvent,
  CommittedTurnEvent,
} from './types.js'

// CommittedChannel — "what the JSONL transcript says actually
// happened". This is append-only, durable history. Unlike the
// semantic channel (which is a best-effort live view that can be
// corrected mid-turn) every event here corresponds to bytes already
// written to disk by Claude Code.
//
// WHY this is separate from semantic:
//
// Live semantic truth and committed truth have different failure
// modes. Semantic deltas can be wrong, late, or superseded. Committed
// entries are what the provider believes actually occurred, and are
// safe to use for feed/history storage on the app side. Mixing them
// in one channel forced consumers to guess which events they were
// safe to persist — that guess is now eliminated: anything on THIS
// channel is persistable as-is.
//
// WHY we still emit raw entries in addition to synthesised
// `turn_committed` events: the transcript has more than just
// user/assistant conversation turns (tool_use, tool_result,
// compact_boundary, isSidechain, system entries). Downstream
// consumers may want to render tool history, compaction banners, or
// sidechain transcripts without us pre-deciding what counts as a
// "turn".

export type CommittedChannelEvents = {
  event: [CommittedEvent]
  turn_committed: [CommittedTurnEvent]
  entry: [CommittedEntryEvent]
  compact_boundary: [CommittedCompactBoundaryEvent]
  /** Committed tool_result content. Fires after `publishEntry` has
   *  processed a user-role entry that carried tool_result blocks.
   *  See `CommittedToolResultEvent` docstring for why this lives on
   *  the committed channel rather than semantic. */
  tool_result: [CommittedToolResultEvent]
  // WHY not 'error':
  //   Node's EventEmitter treats the literal event name 'error'
  //   specially — if no listener is attached, the emitter throws
  //   synchronously and crashes the process. Consumers who only
  //   care about turn_committed / entry would bring down the host
  //   the first time a transcript read failed. Rename to
  //   'tail_error' so missing listeners stay harmless.
  tail_error: [Error]
}

export interface CommittedChannel {
  on<K extends keyof CommittedChannelEvents>(
    event: K,
    listener: (...args: CommittedChannelEvents[K]) => void,
  ): this
  off<K extends keyof CommittedChannelEvents>(
    event: K,
    listener: (...args: CommittedChannelEvents[K]) => void,
  ): this
  emit<K extends keyof CommittedChannelEvents>(
    event: K,
    ...args: CommittedChannelEvents[K]
  ): boolean
}

export class CommittedChannel extends EventEmitter {
  /**
   * Feed one JSONL entry into the channel. Emits:
   *  - always: `entry` (the raw line in a typed envelope)
   *  - when the entry is a user/assistant message: `turn_committed`
   *  - when the entry is a compact boundary: `compact_boundary`
   *
   * The mapping lives HERE (not in the app) because "turn committed"
   * is a provider-level concept that should not be reinvented by every
   * consumer. Agent Code used to compute this on its side, which caused
   * subtle drift as Claude's transcript format evolved.
   */
  publishEntry(entry: Entry, file: string): void {
    const ts = Date.now()

    const raw: CommittedEntryEvent = {
      type: 'entry',
      entry,
      file,
      ts,
    }
    this.emit('entry', raw)
    this.emit('event', raw)

    if (isCompactBoundaryEntry(entry)) {
      const ev: CommittedCompactBoundaryEvent = {
        type: 'compact_boundary',
        entry,
        file,
        ts,
      }
      this.emit('compact_boundary', ev)
      this.emit('event', ev)
      return
    }

    if (isConversationEntry(entry)) {
      // Extract plain text from the entry's content blocks. We
      // intentionally do NOT flatten tool_use / tool_result into the
      // committed turn text — those are separate concerns a consumer
      // may want to render with their own UI. Keeping `text` strictly
      // model-authored text lets the app use this field directly as
      // the body of a feed item.
      const msg = entry.message
      let text = ''
      if (typeof msg.content === 'string') {
        text = msg.content
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .map(block => {
            if (block.type === 'text' && typeof block.text === 'string') {
              return block.text
            }
            return ''
          })
          .filter(Boolean)
          .join('\n')
      }

      const ev: CommittedTurnEvent = {
        type: 'turn_committed',
        turnId: entry.uuid,
        role: entry.type,
        text,
        entry,
        file,
        ts,
      }
      this.emit('turn_committed', ev)
      this.emit('event', ev)

      // Tool-result extraction.
      //
      // WHY this lives here and not on the semantic channel anymore:
      // see the CommittedToolResultEvent docstring. Short version —
      // tool_result is durable data that arrives in a user-role
      // transcript entry AFTER the assistant turn ended. Publishing
      // it on the semantic channel forced the renderer to keep the
      // assistant's live turn artificially alive, which is the
      // "committed data mutating live semantics" leak the 2026-04-18
      // redesign plan called out.
      //
      // We locate the parent assistant turn via `parentUuid` (the
      // uuid of the preceding assistant entry) with a fallback to
      // the user entry's own uuid. The fallback is a belt-and-braces
      // guard for older transcripts that may not have parentUuid set
      // on every entry; the renderer matches on toolUseId anyway so
      // the wrong turnId is only a reconciliation hint, not a
      // correctness issue.
      if (entry.type === 'user' && Array.isArray(entry.message.content)) {
        const parentEntry = entry as unknown as {
          uuid: string
          parentUuid?: string
        }
        const parentTurnId =
          typeof parentEntry.parentUuid === 'string' && parentEntry.parentUuid
            ? parentEntry.parentUuid
            : parentEntry.uuid
        for (const block of entry.message.content) {
          if (block.type !== 'tool_result') continue
          const content =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map(item =>
                      typeof item === 'string'
                        ? item
                        : typeof item.text === 'string'
                          ? item.text
                          : '',
                    )
                    .filter(Boolean)
                    .join('\n')
                : ''
          const toolUseIdRaw = (block as { tool_use_id?: unknown }).tool_use_id
          if (typeof toolUseIdRaw !== 'string') continue
          const toolResultEv: CommittedToolResultEvent = {
            type: 'tool_result',
            turnId: parentTurnId,
            toolUseId: toolUseIdRaw,
            content,
            isError: (block as { is_error?: unknown }).is_error === true,
            file,
            ts,
          }
          this.emit('tool_result', toolResultEv)
          this.emit('event', toolResultEv)
        }
      }
    }
  }

  publishError(err: Error): void {
    this.emit('tail_error', err)
  }
}
