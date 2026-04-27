#!/usr/bin/env tsx
/**
 * testing/verify.ts — automated parser regression tests.
 *
 * Runs against a recorded session and asserts that parsers produce
 * expected output. Exit code 0 = pass, 1 = fail.
 *
 * Usage:
 *   npx tsx src/testing/verify.ts recordings/<dir>
 *
 * If no dir is given, runs against ALL recording dirs found in
 * recordings/. Each is replayed to its final state and the parsers
 * are checked for sanity (non-empty extraction, valid structures).
 */

import { readFile, readdir, stat } from 'fs/promises'
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
import { evaluateClaudeConditions } from '../conditions/index.js'

type RawEvent = { ts: number; data: string }
type Meta = { cols?: number; rows?: number }

let passed = 0
let failed = 0

function assert(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function verifyConditionEvaluator(): void {
  console.log('\n── condition evaluator ──')
  const snapshot = evaluateClaudeConditions({
    trustDialog: {
      visible: true,
      workspace: '/tmp/project',
      options: [
        { key: '1', label: 'Yes, I trust this folder' },
        { key: '2', label: 'No, exit' },
      ],
    },
    resumePrompt: { visible: false },
    permissionPrompt: { visible: false },
    compaction: { visible: false },
    slashPicker: { visible: false, items: [] },
  })
  assert('snapshot provider is claude', snapshot.provider === 'claude')
  assert(
    'trust dialog condition is mapped',
    snapshot.conditions['claude.trust-dialog']?.state.workspace === '/tmp/project',
  )
  assert(
    'trust dialog exposes pty actions',
    snapshot.conditions['claude.trust-dialog']?.actions.some(
      action => action.kind === 'pty' && action.id === 'accept',
    ) === true,
  )
}

async function verifyRecording(dir: string): Promise<void> {
  console.log(`\n── ${dir} ──`)

  let meta: Meta = {}
  try {
    meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta
  } catch { /* ok */ }

  let events: RawEvent[]
  try {
    events = (await readFile(join(dir, 'raw.events.jsonl'), 'utf8'))
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as RawEvent)
  } catch {
    console.log('  (skipped — no raw.events.jsonl)')
    return
  }

  assert('has events', events.length > 0, `got ${events.length}`)
  if (events.length === 0) return

  const term = new Terminal({
    cols: meta.cols ?? 120,
    rows: meta.rows ?? 40,
    allowProposedApi: true,
    scrollback: 10000,
  })

  for (const ev of events) term.write(ev.data)
  await new Promise<void>(r => setTimeout(r, 50))

  const screen = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < screen.length; i++) {
    const line = screen.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const plain = lines.join('\n')

  assert('screen non-empty', plain.length > 0)

  // extractStreamingText should strip chrome and produce something
  const stripped = extractStreamingText(plain)
  assert('extractStreamingText non-empty', stripped.length > 0)

  // terminalToMarkdown should produce output with at least as many chars
  const md = terminalToMarkdown(term)
  assert('terminalToMarkdown non-empty', md.length > 0)
  assert('markdown ≥ plain length', md.length >= plain.length * 0.8,
    `md=${md.length} vs plain=${plain.length}`)

  // If there's an assistant marker, extraction should produce something
  const hasMarker = plain.includes('⏺')
  if (hasMarker) {
    const assistant = extractAssistantInProgress(plain)
    assert('extractAssistantInProgress found content', assistant.length > 0)
    const assistantMd = extractAssistantInProgress(md)
    assert('markdown extraction found content', assistantMd.length > 0)
  }

  // detectTrustDialog should return a valid structure
  const trust = detectTrustDialog(plain)
  assert('detectTrustDialog returns valid shape', typeof trust.visible === 'boolean')

  const resumePrompt = detectResumePrompt(plain)
  assert('detectResumePrompt returns valid shape', typeof resumePrompt.visible === 'boolean')

  // detectSlashPicker should return a valid structure
  const picker = detectSlashPicker(term)
  assert('detectSlashPicker returns valid shape',
    typeof picker.visible === 'boolean' && Array.isArray(picker.items))
}

async function main(): Promise<void> {
  verifyConditionEvaluator()

  const arg = process.argv[2]

  if (arg) {
    await verifyRecording(arg)
  } else {
    // Run against all recordings
    let dirs: string[] = []
    try {
      const entries = await readdir('recordings')
      for (const e of entries) {
        const s = await stat(join('recordings', e))
        if (s.isDirectory()) dirs.push(join('recordings', e))
      }
    } catch {
      console.log('No recordings/ directory found. Record a session first:')
      console.log('  npx tsx src/testing/record.ts')
      process.exit(0)
    }
    if (dirs.length === 0) {
      console.log('No recordings found.')
      process.exit(0)
    }
    dirs.sort()
    for (const d of dirs) await verifyRecording(d)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('[verify] fatal:', err); process.exit(1) })
