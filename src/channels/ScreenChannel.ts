import { EventEmitter } from 'events'

import type {
  ScreenActivityEvent,
  ScreenCompactionEvent,
  ScreenEvent,
  ScreenResumePromptEvent,
  ScreenSlashPickerEvent,
  ScreenSnapshotEvent,
  ScreenTrustDialogEvent,
} from './types.js'

// ScreenChannel — "what the user would see on the terminal right now".
//
// WHY a dedicated channel:
//
// Screen events are not a lesser version of semantic events. They are
// a different kind of truth: the PTY's current paint. A trust modal,
// a slash picker, a compaction banner — none of these belong on the
// semantic channel because they do not describe model output. They
// describe UI. Consumers that render overlays, mirror the PTY, or
// drive fail-safe fallback behavior all want THIS channel and nothing
// else.
//
// Keeping visual state out of the semantic channel is what lets the
// app render live assistant markdown from semantic deltas without
// having to filter out "oh also there's a trust dialog" pseudo-events.
// And keeping semantic state out of the screen channel is what lets
// the app mirror the terminal without having to deduplicate things
// the model said.

export type ScreenChannelEvents = {
  event: [ScreenEvent]
  snapshot: [ScreenSnapshotEvent]
  activity: [ScreenActivityEvent]
  trust_dialog: [ScreenTrustDialogEvent]
  resume_prompt: [ScreenResumePromptEvent]
  compaction: [ScreenCompactionEvent]
  slash_picker: [ScreenSlashPickerEvent]
}

export interface ScreenChannel {
  on<K extends keyof ScreenChannelEvents>(
    event: K,
    listener: (...args: ScreenChannelEvents[K]) => void,
  ): this
  off<K extends keyof ScreenChannelEvents>(
    event: K,
    listener: (...args: ScreenChannelEvents[K]) => void,
  ): this
  emit<K extends keyof ScreenChannelEvents>(
    event: K,
    ...args: ScreenChannelEvents[K]
  ): boolean
}

export class ScreenChannel extends EventEmitter {
  // The channel is a pure forwarder — the actual debouncing, key
  // diffing, and parser orchestration live in ClaudeCodeHeadless
  // because those require cross-cutting state (idle debounce,
  // per-snapshot parser key comparison). Keeping the channel itself
  // dumb means we can swap screen adapters later without rewriting
  // the public surface.

  publishSnapshot(params: { plain: string; markdown: string }): void {
    const ev: ScreenSnapshotEvent = {
      type: 'snapshot',
      plain: params.plain,
      markdown: params.markdown,
      ts: Date.now(),
    }
    this.emit('snapshot', ev)
    this.emit('event', ev)
  }

  publishActivity(params: { active: boolean; status: string | null }): void {
    const ev: ScreenActivityEvent = {
      type: 'activity',
      active: params.active,
      status: params.status,
      ts: Date.now(),
    }
    this.emit('activity', ev)
    this.emit('event', ev)
  }

  publishTrustDialog(state: ScreenTrustDialogEvent['state']): void {
    const ev: ScreenTrustDialogEvent = {
      type: 'trust_dialog',
      state,
      ts: Date.now(),
    }
    this.emit('trust_dialog', ev)
    this.emit('event', ev)
  }

  publishResumePrompt(state: ScreenResumePromptEvent['state']): void {
    const ev: ScreenResumePromptEvent = {
      type: 'resume_prompt',
      state,
      ts: Date.now(),
    }
    this.emit('resume_prompt', ev)
    this.emit('event', ev)
  }

  publishCompaction(state: ScreenCompactionEvent['state']): void {
    const ev: ScreenCompactionEvent = {
      type: 'compaction',
      state,
      ts: Date.now(),
    }
    this.emit('compaction', ev)
    this.emit('event', ev)
  }

  publishSlashPicker(state: ScreenSlashPickerEvent['state']): void {
    const ev: ScreenSlashPickerEvent = {
      type: 'slash_picker',
      state,
      ts: Date.now(),
    }
    this.emit('slash_picker', ev)
    this.emit('event', ev)
  }
}
