// Installs basedpyright when missing (shared by the Orca worker and the SSH agent).
// Uses the npm bundled with the found node (nvm/fnm do not put npm on PATH); one install at a time per folder.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PYRIGHT_VERSION = '1.40.2'
const running = new Map<string, Promise<string | null>>()

/** Install into `prefix` using `node` (path to node.exe/node); returns langserver.index.js or null. */
export function installPyright(prefix: string, node: string, log: (m: string) => void): Promise<string | null> {
  const entry = join(prefix, 'node_modules', 'basedpyright', 'langserver.index.js')
  if (existsSync(entry)) return Promise.resolve(entry)
  const busy = running.get(prefix)
  if (busy) return busy
  const job = new Promise<string | null>((resolve) => {
    mkdirSync(prefix, { recursive: true })
    const binDir = dirname(node)
    const cli = [join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => existsSync(p))
    const args = ['install', '--prefix', prefix, `basedpyright@${PYRIGHT_VERSION}`, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error']
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: binDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '') }
    log(`installing basedpyright ${PYRIGHT_VERSION} into ${prefix} ...`)
    const p = cli
      ? spawn(node, [cli, ...args], { env, windowsHide: true })
      : spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { env, windowsHide: true })
    let err = ''
    p.stderr?.on('data', (d) => { err = (err + d).slice(-1500) })
    const timer = setTimeout(() => { try { p.kill() } catch { /* */ } }, 300000)
    p.on('error', (e) => { err += e.message })
    p.on('close', (code) => {
      clearTimeout(timer)
      running.delete(prefix)
      if (code === 0 && existsSync(entry)) { log('basedpyright installed'); resolve(entry) }
      else { log(`basedpyright install failed (${code}): ${err.trim().slice(-400)}`); resolve(null) }
    })
  })
  running.set(prefix, job)
  return job
}
