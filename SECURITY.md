# Security Policy

`claude-code-headless` drives the real `claude` CLI and, optionally,
intercepts its network traffic. Both have real security implications.
Read this before you embed the package.

## Threat model — what this package does

### It runs an autonomous agent

The package spawns the real `claude` binary in a pseudo-terminal. Claude
Code is an autonomous coding agent: depending on its permission settings
it can read and write files, run shell commands, and make network
requests. `claude-code-headless` does **not** add a sandbox. The security
posture of a session is exactly the posture of the `claude` CLI you
launched, with whatever permissions you granted it.

If you auto-approve permission prompts, you are auto-approving real shell
commands. Treat the working directory and the host accordingly.

### The proxy decrypts your Anthropic traffic — locally

The optional proxy adapter uses a mitmproxy-style runtime to observe
Claude Code's network stream. To do that it performs a TLS
man-in-the-middle on traffic to Anthropic's API, using a locally
generated CA certificate.

This means:

- A local CA certificate is generated and trusted **for the spawned
  `claude` process only** — scoped via environment variables, not
  installed system-wide by this package.
- While the proxy runs, your Anthropic API traffic — prompts, responses,
  credentials in transit — is decrypted in memory inside your own
  process. It is **not** sent anywhere; it is parsed locally to drive the
  `semantic` channel.
- The proxy listens on a local port. **Do not bind it to a public
  interface.** Anything that can reach that port can read the decrypted
  stream.

The proxy is **opt-in**. If you don't construct the adapter, no
interception happens.

### Transcripts contain conversation data

The package reads Claude Code's JSONL transcripts from
`~/.claude/projects/`. These hold full conversation history — anything
you or the agent put in context. Handle whatever you surface from the
`committed` channel with that in mind.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's private vulnerability reporting — "Report a
vulnerability" under the repository's **Security** tab — or by direct
contact with the maintainer. Include a description, reproduction steps,
and impact. You will get an acknowledgement and a fix timeline.

## Scope

**In scope:** this package's own code — process spawning, the proxy
adapter, the parsers, transcript handling.

**Out of scope:** vulnerabilities in the `claude` CLI itself (report
those to Anthropic), in `mitmproxy`, in `node-pty`, or in other
dependencies — report those upstream.
