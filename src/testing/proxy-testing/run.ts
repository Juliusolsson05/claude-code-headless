#!/usr/bin/env tsx
import { mkdir, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'

import { ClaudeCodeHeadless } from '../../ClaudeCodeHeadless.js'
import { extractAssistantInProgress } from '../../parsers/ScreenParser.js'
import { summarizeComparison } from './compareWithScreen.js'
import { createProxyServer } from './proxyServer.js'
import { parseAnthropicEvents } from './sseParser.js'
import { spawnClaudeWithProxy } from './spawnClaudeWithProxy.js'

async function main(): Promise<void> {
  const cwd = process.env.CC_PROXY_TEST_CWD ?? process.cwd()
  const binary = process.env.CC_PROXY_TEST_CLAUDE_BINARY ?? 'claude'
  const prompt = process.env.CC_PROXY_TEST_PROMPT
  const durationMs = process.env.CC_PROXY_TEST_DURATION_MS
    ? Number(process.env.CC_PROXY_TEST_DURATION_MS)
    : null

  const runDir = join(
    process.cwd(),
    '.proxy-testing',
    'runs',
    new Date().toISOString().replace(/[:.]/g, '-'),
  )
  await mkdir(runDir, { recursive: true })

  const proxy = await createProxyServer(join(process.cwd(), '.proxy-testing', 'runtime'))
  await proxy.start()

  const pty = spawnClaudeWithProxy({
    cwd,
    binary,
    proxyUrl: proxy.info.proxyUrl,
    caCertPath: proxy.info.caCertPath,
  })

  const headless = new ClaudeCodeHeadless({
    pty,
    cwd,
    cols: 120,
    rows: 40,
    snapshotIntervalMs: 16,
  })

  const proxyLog = createWriteStream(join(runDir, 'proxy-events.jsonl'), { flags: 'a' })
  const screenLog = createWriteStream(join(runDir, 'screen-events.jsonl'), { flags: 'a' })
  const jsonlLog = createWriteStream(join(runDir, 'jsonl-events.jsonl'), { flags: 'a' })

  let proxyText = ''
  let latestScreenText = ''

  proxy.on('event', event => {
    proxyLog.write(JSON.stringify(event) + '\n')

    const body = typeof event.body === 'string' ? event.body : null
    const url = typeof event.url === 'string' ? event.url : ''
    if (!body || !url.includes('/v1/messages')) return

    for (const parsed of parseAnthropicEvents(body)) {
      if (parsed.type === 'text_delta') {
        proxyText += parsed.text
      }
    }
  })

  proxy.on('stderr', text => {
    process.stderr.write(`[mitmdump] ${text}`)
  })

  headless.on('screen', snap => {
    latestScreenText = extractAssistantInProgress(snap.recent)
    screenLog.write(
      JSON.stringify({
        ts: Date.now(),
        assistant: latestScreenText,
        plain: snap.plain,
      }) + '\n',
    )
  })

  headless.on('jsonl-entry', (entry, file) => {
    jsonlLog.write(JSON.stringify({ ts: Date.now(), file, entry }) + '\n')
  })

  headless.on('exit', ({ exitCode, signal }) => {
    process.stderr.write(`\n[proxy-test] claude exited (code=${exitCode}, signal=${signal ?? '-'})\n`)
    void shutdown(exitCode ?? 0)
  })

  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    try { pty.kill() } catch { /* already gone */ }
    await headless.stop()
    await proxy.stop()
    proxyLog.end()
    screenLog.end()
    jsonlLog.end()

    const summary = summarizeComparison({
      proxyText,
      screenText: latestScreenText,
    })

    await writeFile(
      join(runDir, 'meta.json'),
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          cwd,
          binary,
          proxyUrl: proxy.info.proxyUrl,
          caCertPath: proxy.info.caCertPath,
          prompt: prompt ?? null,
        },
        null,
        2,
      ),
    )
    await writeFile(join(runDir, 'summary.txt'), `${summary}\n`)
    process.stderr.write(`[proxy-test] saved run to ${runDir}\n`)
    process.exit(code)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  await headless.start()

  process.stderr.write(`[proxy-test] proxy: ${proxy.info.proxyUrl}\n`)
  process.stderr.write(`[proxy-test] CA: ${proxy.info.caCertPath}\n`)
  process.stderr.write(`[proxy-test] run dir: ${runDir}\n`)

  if (prompt) {
    setTimeout(() => {
      headless.sendPrompt(prompt)
    }, 1500)
  }

  if (durationMs && Number.isFinite(durationMs) && durationMs > 0) {
    setTimeout(() => {
      void shutdown(0)
    }, durationMs)
  }
}

main().catch(err => {
  console.error('[proxy-test] fatal:', err)
  process.exit(1)
})
