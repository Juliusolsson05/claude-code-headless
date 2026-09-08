import { spawn as ptySpawn, type IPty } from 'node-pty'

export type SpawnClaudeWithProxyOptions = {
  cwd: string
  cols?: number
  rows?: number
  binary?: string
  proxyUrl: string
  caCertPath: string
  /** CLI arguments appended verbatim after the binary.
   *
   *  WHY this exists: this spawner used to pass an EMPTY argv, so an
   *  SDK-driven session could only ever run the interactive TUI in
   *  default permission mode — every Write/Edit/Bash raised a prompt the
   *  driver then had to answer through the screen channel, and there was
   *  no way to pre-approve anything or pick a model. The flags are
   *  Claude Code's own (`--permission-mode`, `--model`, `--resume`, …);
   *  we deliberately do not model them as typed options here because
   *  this package tracks a CLI it does not own, and a typed mirror would
   *  drift on every Claude Code release. */
  args?: string[]
  /** Environment overrides merged over the inherited process env.
   *
   *  Applied BEFORE the proxy variables, so a consumer can shape the
   *  child's environment freely without being able to break observation
   *  — see `buildSpawnPlan` for exactly which keys are non-negotiable
   *  and why. */
  env?: Record<string, string>
}

/** The full description of the child process, with nothing spawned yet.
 *  Exists so argv/env assembly is unit-testable without a PTY — the env
 *  rules below are load-bearing (get NODE_EXTRA_CA_CERTS wrong and every
 *  session dies with a TLS error) and deserve tests that don't need a
 *  real `claude` binary on the machine. */
export type ClaudeSpawnPlan = {
  file: string
  args: string[]
  env: Record<string, string>
}

/**
 * Translate options into the exact `{file, args, env}` a PTY spawn would
 * receive. Pure — no process is started, nothing is validated.
 *
 * WHY the input is `Partial<…>` while `spawnClaudeWithProxy` keeps every
 * field required: this function is a TRANSLATOR, and each field it reads
 * contributes independently — a missing `proxyUrl` means "emit no proxy
 * vars", not "invalid input". It also never touches `cwd` / `cols` /
 * `rows`, which are spawn-time concerns that never reach the plan.
 * Requiring the full option set here would be requiring fields the
 * function does not use. The place where the fields genuinely are
 * mandatory — you cannot observe a session you did not point at the
 * proxy — is `spawnClaudeWithProxy`, and its signature is unchanged, so
 * no real caller can spawn an untapped session by accident.
 */
export function buildSpawnPlan(
  options: Partial<SpawnClaudeWithProxyOptions>,
): ClaudeSpawnPlan {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }

  // Layer 1 — presentation defaults. These sit BEFORE the consumer's
  // overrides because they are opinions, not requirements: a caller
  // driving a differently-sized terminal or reporting its own entrypoint
  // has a legitimate reason to change them.
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'

  // Layer 2 — the consumer's environment.
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (typeof value === 'string') env[key] = value
    }
  }

  // Layer 3 — proxy configuration. LAST, so it wins over anything the
  // consumer set. This ordering is the whole point: the proxy env is
  // load-bearing for observation, and a consumer that (accidentally or
  // by inheriting a shell HTTPS_PROXY into its own overrides) pointed
  // the child somewhere else would silently kill the mitm tap. The
  // session would still "work" — it would just produce no semantic
  // events at all, which is exactly the failure that is hardest to
  // diagnose from the outside.
  if (options.proxyUrl) {
    env.HTTPS_PROXY = options.proxyUrl
    env.https_proxy = options.proxyUrl
    env.HTTP_PROXY = options.proxyUrl
    env.http_proxy = options.proxyUrl
  }

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
  if (options.caCertPath) env.NODE_EXTRA_CA_CERTS = options.caCertPath

  // Keep loopback direct so the experiment doesn't eat its own tail.
  // Do NOT add `.anthropic.com` here — that would bypass the proxy for the
  // very traffic we want to observe.
  //
  // NOTE this is also why a loopback provider (a LiteLLM shim on
  // 127.0.0.1) cannot be observed by adding it to `allowedHosts` alone:
  // NO_PROXY sends it straight past the proxy. Such a deployment needs
  // this value narrowed by the caller through `options.env`… which the
  // layering above cannot express, because NO_PROXY is set here in layer
  // 3. Left as-is deliberately: every current consumer runs a remote
  // provider, and quietly making the loopback bypass overridable would
  // let a stray shell NO_PROXY break the tap for everyone else.
  env.NO_PROXY = 'localhost,127.0.0.1,::1'
  env.no_proxy = env.NO_PROXY

  return {
    file: options.binary ?? 'claude',
    args: [...(options.args ?? [])],
    env,
  }
}

export function spawnClaudeWithProxy(
  options: SpawnClaudeWithProxyOptions,
): IPty {
  const plan = buildSpawnPlan(options)
  return ptySpawn(plan.file, plan.args, {
    name: 'xterm-256color',
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    cwd: options.cwd,
    env: plan.env,
  })
}
