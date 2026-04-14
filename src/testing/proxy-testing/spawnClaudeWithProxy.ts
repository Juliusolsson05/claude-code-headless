import { spawn as ptySpawn, type IPty } from 'node-pty'

export type SpawnClaudeWithProxyOptions = {
  cwd: string
  cols?: number
  rows?: number
  binary?: string
  proxyUrl: string
  caCertPath: string
}

export function spawnClaudeWithProxy(
  options: SpawnClaudeWithProxyOptions,
): IPty {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }

  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
  env.HTTPS_PROXY = options.proxyUrl
  env.https_proxy = options.proxyUrl
  env.HTTP_PROXY = options.proxyUrl
  env.http_proxy = options.proxyUrl
  env.NODE_EXTRA_CA_CERTS = options.caCertPath
  env.SSL_CERT_FILE = options.caCertPath
  env.REQUESTS_CA_BUNDLE = options.caCertPath
  env.CURL_CA_BUNDLE = options.caCertPath

  // Keep loopback direct so the experiment doesn't eat its own tail.
  // Do NOT add `.anthropic.com` here — that would bypass the proxy for the
  // very traffic we want to observe.
  env.NO_PROXY = 'localhost,127.0.0.1,::1'
  env.no_proxy = env.NO_PROXY

  return ptySpawn(options.binary ?? 'claude', [], {
    name: 'xterm-256color',
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    cwd: options.cwd,
    env,
  })
}
