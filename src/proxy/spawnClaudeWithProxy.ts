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

  // CA trust: inject ONLY NODE_EXTRA_CA_CERTS, and deliberately NOT
  // SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE.
  //
  // WHY (Agent Code #281): those three vars each point at a *single-cert*
  // file, and each one REPLACES the process's entire root trust store with
  // just that cert. Since the proxy only MITMs the provider host and passes
  // every other host through with its REAL certificate, replacing the trust
  // store makes every passthrough host (npm registry, PyPI, Azure, GitHub, …)
  // fail to verify — breaking npm/pip/az/curl/git for any tool that reads
  // those vars. NODE_EXTRA_CA_CERTS is different: Node *appends* it to the
  // built-in roots (additive), so the spawned agent trusts the proxy cert for
  // the intercepted host while still trusting real certs everywhere else.
  // Chasing this per-tool (npm_config_cafile, GIT_SSL_CAINFO, …) is an
  // unwinnable allowlist; not replacing the store is the universal fix.
  env.NODE_EXTRA_CA_CERTS = options.caCertPath

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
