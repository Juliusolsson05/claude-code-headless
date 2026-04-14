#!/usr/bin/env tsx
import { access, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

async function main(): Promise<void> {
  const root = process.cwd()
  const workDir = join(root, '.proxy-testing')
  const venvDir = join(workDir, 'venv')
  const python = process.env.CC_PROXY_TEST_PYTHON || 'python3'

  await mkdir(workDir, { recursive: true })

  const mitmDumpPath = join(venvDir, 'bin', 'mitmdump')
  try {
    await access(mitmDumpPath, fsConstants.X_OK)
    console.log(`mitmdump already installed at ${mitmDumpPath}`)
    return
  } catch {
    // continue
  }

  await run(python, ['-m', 'venv', venvDir], root)
  await run(join(venvDir, 'bin', 'python'), ['-m', 'pip', 'install', '--upgrade', 'pip'], root)
  await run(join(venvDir, 'bin', 'python'), ['-m', 'pip', 'install', 'mitmproxy'], root)

  console.log(`installed mitmproxy into ${venvDir}`)
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
    })
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

main().catch(err => {
  console.error('[proxy-test-bootstrap] fatal:', err)
  process.exit(1)
})
