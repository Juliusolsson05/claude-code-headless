#!/usr/bin/env tsx
/**
 * testing/replay.ts — load a recorded session and run parsers offline.
 *
 * Usage:
 *   npx tsx src/testing/replay.ts recordings/<dir>            # final state
 *   npx tsx src/testing/replay.ts recordings/<dir> --frames   # every frame
 *
 * Feeds raw.events.jsonl into a headless xterm terminal, runs
 * extractAssistantInProgress + terminalToMarkdown on the result.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'

import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless

import {
  extractAssistantInProgress,
  extractStreamingText,
} from '../parsers/ScreenParser.js'
import { detectResumePrompt } from '../parsers/ResumePromptParser.js'
import { detectTrustDialog } from '../parsers/TrustDialogParser.js'
import { detectSlashPicker } from '../parsers/SlashPickerParser.js'
import { terminalToMarkdown } from '../terminal/HeadlessTerminal.js'

type RawEvent = { ts: number; data: string }
type Meta = { cols?: number; rows?: number; cwd?: string }

const SEP = '─'.repeat(78)
const box = (title: string, body: string) => `${SEP}\n${title}\n${SEP}\n${body}\n`

function snapshot(term: InstanceType<typeof Terminal>): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: tsx src/testing/replay.ts <recordingDir> [--frames]')
    process.exit(1)
  }

  const dumpFrames = process.argv.includes('--frames')

  let meta: Meta = {}
  try {
    meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta
  } catch { /* ok */ }

  const events: RawEvent[] = (await readFile(join(dir, 'raw.events.jsonl'), 'utf8'))
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as RawEvent)

  console.log(box('META', JSON.stringify(meta, null, 2)))
  console.log(`${events.length} raw events, ${((events[events.length - 1]?.ts ?? 0) - (events[0]?.ts ?? 0)) / 1000}s\n`)

  if (events.length === 0) { console.error('empty recording'); process.exit(1) }

  const term = new Terminal({
    cols: meta.cols ?? 120,
    rows: meta.rows ?? 40,
    allowProposedApi: true,
    scrollback: 10000,
  })

  const writeAndFlush = (data: string): Promise<void> =>
    new Promise(resolve => term.write(data, () => resolve()))

  if (dumpFrames) {
    let prev = ''
    for (let i = 0; i < events.length; i++) {
      await writeAndFlush(events[i].data)
      const screen = snapshot(term)
      if (screen === prev) continue
      prev = screen
      const assistant = extractAssistantInProgress(screen)
      const mdScreen = terminalToMarkdown(term)
      const assistantMd = extractAssistantInProgress(mdScreen)
      console.log(box(`FRAME ${i + 1}/${events.length}  (+${events[i].ts - events[0].ts}ms)`, ''))
      console.log('--- raw screen ---')
      console.log(screen)
      console.log('\n--- extractAssistantInProgress (plain) ---')
      console.log(assistant || '(empty)')
      console.log('\n--- extractAssistantInProgress (markdown) ---')
      console.log(assistantMd || '(empty)')
      console.log()
    }
    return
  }

  // Final-state replay. Awaiting writeAndFlush per event makes each
  // write fully parsed before the next runs — the previous version
  // fired all writes back-to-back and slept 50ms hoping the parser
  // had caught up. Use the documented xterm callback instead.
  for (const ev of events) await writeAndFlush(ev.data)

  const screen = snapshot(term)
  const mdScreen = terminalToMarkdown(term)

  console.log(box('FINAL RAW SCREEN', screen))
  console.log(box('extractStreamingText', extractStreamingText(screen)))
  console.log(box('extractAssistantInProgress (plain)', extractAssistantInProgress(screen) || '(none)'))
  console.log(box('extractAssistantInProgress (markdown)', extractAssistantInProgress(mdScreen) || '(none)'))
  console.log(box('detectTrustDialog', JSON.stringify(detectTrustDialog(screen), null, 2)))
  console.log(box('detectResumePrompt', JSON.stringify(detectResumePrompt(screen), null, 2)))
  console.log(box('detectSlashPicker', JSON.stringify(detectSlashPicker(term), null, 2)))
}

main().catch(err => { console.error('[replay] fatal:', err); process.exit(1) })
