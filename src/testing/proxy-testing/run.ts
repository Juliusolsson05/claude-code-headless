#!/usr/bin/env tsx
// End-to-end experiment runner.
//
// This harness now exercises the SAME protocol path as the Electron
// demo: proxy transport events flow into `ClaudeCodeHeadless` via its
// built-in `ClaudeProxyAdapter`, which drives the `semantic` channel
// with block-level events. We subscribe to the semantic channel to
// assemble the proxy-sourced view, to the screen path for the
// fallback view, and to the committed path for the settled view.
//
// Previously this file re-parsed buffered `response.body` payloads
// from the mitmproxy addon — a path that the addon no longer emits
// for SSE responses. Keeping the old code around would have meant
// `run.ts` and the demo validated different protocols: a regression
// in the live path could pass `proxy-test` and still break the demo.

import { mkdir, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'

import { ClaudeCodeHeadless } from '../../ClaudeCodeHeadless.js'
import { extractAssistantInProgress } from '../../parsers/ScreenParser.js'
import { summarizeComparison } from './compareWithScreen.js'
import { createProxyServer } from './proxyServer.js'
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

  // Enabling `options.proxy` tells ClaudeCodeHeadless that proxy is
  // the semantic source of truth — its screen path will stop
  // publishing semantic deltas (screen channel still fires for
  // overlays). The adapter is exposed as `headless.proxy`, and we
  // feed transport events through `handleProxyTransportEvent`.
  const headless = new ClaudeCodeHeadless({
    pty,
    cwd,
    cols: 120,
    rows: 40,
    snapshotIntervalMs: 16,
    proxy: {
      onDiagnostic: (m) => process.stderr.write(`[adapter] ${m}\n`),
    },
  })

  const proxyLog = createWriteStream(join(runDir, 'proxy-events.jsonl'), { flags: 'a' })
  const semanticLog = createWriteStream(join(runDir, 'semantic-events.jsonl'), { flags: 'a' })
  const screenLog = createWriteStream(join(runDir, 'screen-events.jsonl'), { flags: 'a' })
  const committedLog = createWriteStream(join(runDir, 'committed-events.jsonl'), { flags: 'a' })

  // Proxy-sourced text rolls up text_delta events from the semantic
  // channel. This is a coarse aggregate — the block-level stream is
  // richer — but it's directly comparable against `screenText` for
  // the summary. Multi-text-block turns concatenate naturally since
  // the channel already emits per-block `textSoFar` and our rollup
  // uses the `textDelta` increment.
  let proxyText = ''
  let latestScreenText = ''

  // --- Proxy transport: record + forward into the adapter ---------------
  proxy.on('event', event => {
    proxyLog.write(JSON.stringify(event) + '\n')
    // The adapter type requires a narrower shape; the on-disk event
    // is `Record<string, unknown>`. Casting is safe here because the
    // addon enforces the shape on the Python side.
    headless.handleProxyTransportEvent(event as unknown as Parameters<
      typeof headless.handleProxyTransportEvent
    >[0])
  })
  proxy.on('stderr', text => {
    process.stderr.write(`[mitmdump] ${text}`)
  })

  // --- Semantic channel: the new source of truth -----------------------
  headless.semantic.on('event', ev => {
    semanticLog.write(JSON.stringify(ev) + '\n')
  })
  headless.semantic.on('text_delta', ev => {
    // Only count proxy-sourced deltas for the aggregate — screen
    // fallback deltas (source='screen') are suppressed today when
    // proxy is configured, but the guard is cheap and future-proof.
    if (ev.source === 'proxy') proxyText += ev.textDelta
  })

  // --- Screen channel: mirror for overlays + the fallback view --------
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

  // --- Committed channel: durable transcript truth --------------------
  headless.committed.on('event', ev => {
    committedLog.write(JSON.stringify(ev) + '\n')
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
    semanticLog.end()
    screenLog.end()
    committedLog.end()

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
          // Document which protocol the run exercised, so future runs
          // comparing results can tell apart pre- and post-migration
          // harness behavior.
          protocol: 'semantic-channel-v1',
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
