// Connects to the Qt LSP agent on another host via the system `ssh` command (OpenSSH ships with macOS, Linux, Windows 10+).
// - No ports to open and nothing to preinstall: on first use the worker copies the agent over (~/.orca-qt-lsp/agent-<hash>.mjs)
//   via `ssh host node -` + stdin, so it does not depend on the remote shell (sh, zsh, PowerShell, cmd).
// - Requires: key-based SSH login (BatchMode, no password prompt) and Node >= 18 on the remote host.
import { spawn, type ChildProcess } from 'node:child_process'
import { LANGUAGE_PROFILE, PLUGIN_ID } from './language-profile'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PROBE_SCRIPT, type ProbeQuery } from './probe-script'

export interface RemoteInfo { version: string; platform: string; node: string; home: string; language?: string; pluginId?: string }

/** Ways to invoke node on the remote host: the SSH session PATH, common install locations, then a login shell (nvm, fnm, asdf...). */
const NODE_CANDIDATES: ((args: string) => string[])[] = [
  (a) => ['node', a],
  (a) => ['/opt/homebrew/bin/node', a],
  (a) => ['/usr/local/bin/node', a],
  (a) => ['/usr/bin/node', a],
  // nvm / fnm / volta / asdf: node is not on the PATH of a non-interactive SSH session.
  // The command below runs under sh (Linux/macOS); on Windows (cmd) it fails and is skipped.
  (a) => ['sh', '-c', `'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node 2>/dev/null | sort -V | tail -1); [ -n "$n" ] && exec "$n" ${a}; exit 127'`],
  (a) => ['bash', '-lc', `'exec node ${a}'`],
  (a) => ['zsh', '-lc', `'exec node ${a}'`],
  (a) => ['bash', '-ic', `'exec node ${a}'`]
]

/** An ssh destination: `alias`, `user@host`, `host:port`-free. Never starts with `-` (would be read as an ssh option). */
export const isValidHost = (h: string) => /^[A-Za-z0-9_][A-Za-z0-9_.@%+-]*$/.test(h) && h.length <= 255

export function findSsh(setting: string): string {
  if (setting) return setting
  if (process.platform === 'win32') {
    const sys = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\OpenSSH\\ssh.exe`
    if (existsSync(sys)) return sys
  }
  return 'ssh'
}

export class RemoteAgent {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private starting: Promise<RemoteInfo> | null = null
  private node: (args: string) => string[] = NODE_CANDIDATES[0]
  info: RemoteInfo | null = null
  lastError = ''
  onEvent: (ev: string, payload: unknown) => void = () => {}
  log: (line: string) => void = () => {}
  private readonly version: string

  constructor(readonly host: string, private readonly ssh: string, private readonly agentSource: string, private readonly settings: Record<string, unknown>) {
    if (!isValidHost(host)) throw new Error(`Invalid SSH host: ${JSON.stringify(host)}`)
    this.version = createHash('sha1').update(agentSource).digest('hex').slice(0, 10)
  }

  get alive() { return !!this.proc && this.proc.exitCode === null && !!this.info }

  private sshArgs(cmd: string[]) {
    return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '--', this.host, ...cmd]
  }

  /** Run a short command over SSH, write `input` to stdin, then close it. */
  private run(cmd: string[], input: string, timeoutMs = 60000): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const p = spawn(this.ssh, this.sshArgs(cmd), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = ''
      const t = setTimeout(() => { try { p.kill() } catch { /* */ } }, timeoutMs)
      p.stdout!.on('data', (d) => { out += d })
      p.stderr!.on('data', (d) => { err += d })
      p.on('error', (e) => { err += e.message })
      p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
      p.stdin!.end(input)
    })
  }

  private nodeKnown = false
  private get agentFile() { return LANGUAGE_PROFILE === 'all' ? `agent-${this.version}.mjs` : `agent-${PLUGIN_ID}-${this.version}.mjs` }
  private nodeCandidates() {
    if (this.nodeKnown) return [this.node]
    const custom = String(this.settings.remoteNode ?? '').trim()
    // Passed to the remote shell as one word: a plain path only
    if (custom && !/^[w./~:\-]+$/.test(custom)) throw new Error(`Invalid "Remote node path": ${custom}`)
    return custom ? [(a: string) => [custom, a], ...NODE_CANDIDATES] : NODE_CANDIDATES
  }

  /** Search for the file on the remote host, read-only (see probe-script.ts). Throws if SSH or node fails. */
  async probe(q: ProbeQuery): Promise<{ path: string; root: string } | null> {
    const script = `const Q=${JSON.stringify(Buffer.from(JSON.stringify(q)).toString('base64'))};${PROBE_SCRIPT}`
    let last = ''
    for (const node of this.nodeCandidates()) {
      const r = await this.run(node('-'), script, q.ms + 20000)
      const m = /QTLSP-FOUND (.+)/.exec(r.out)
      if (m || r.out.includes('QTLSP-NONE')) { this.node = node; this.nodeKnown = true; return m ? JSON.parse(m[1]) : null }
      last = (r.err || r.out).trim().split('\n').pop()?.slice(0, 160) ?? String(r.code)
      if (r.code === 255) break
    }
    throw new Error(last || 'could not run node')
  }

  /** Copy the agent to the remote host (if this version is missing) and find a working node. */
  private async install(): Promise<void> {
    const b64 = Buffer.from(this.agentSource).toString('base64')
    const script = `const fs=require('fs'),path=require('path'),os=require('os');` +
      `const d=path.join(os.homedir(),'.orca-qt-lsp');fs.mkdirSync(d,{recursive:true});` +
      `const f=path.join(d,${JSON.stringify(this.agentFile)});` +
      `if(!fs.existsSync(f)){const t=f+'.'+process.pid+'.'+require('crypto').randomBytes(6).toString('hex')+'.tmp';` +
      `try{fs.writeFileSync(t,Buffer.from('${b64}','base64'));fs.renameSync(t,f)}catch(e){if(!fs.existsSync(f))throw e}finally{try{fs.unlinkSync(t)}catch{}}}` +
      // Content-addressed files can be about to launch in another worker. Do not
      // prune any executable here; only this install's unique temporary file.
      `console.log('QTLSP-OK '+process.version+' '+process.platform)\n`
    const tried: string[] = []
    for (const node of this.nodeCandidates()) {
      const r = await this.run(node('-'), script)
      if (r.out.includes('QTLSP-OK')) { this.node = node; this.nodeKnown = true; this.log(`${this.host}: agent ${this.version} ready (${r.out.trim().split(' ').slice(1).join(' ')}, ${node('').join(' ')})`); return }
      tried.push(`${node('').join(' ')}: ${(r.err || r.out).trim().split('\n').pop()?.slice(0, 160) ?? r.code}`)
      // SSH error (no connection/no key): trying other node candidates is pointless
      if (r.code === 255) break
    }
    const last = tried[tried.length - 1] ?? ''
    const hint = /Host key verification|Permission denied|publickey|Could not resolve|timed out|Connection refused/i.test(last)
      ? `Check: run "ssh ${this.host}" once in a terminal (accept the host key) and use an SSH key, not a password.`
      : 'The remote host needs Node.js >= 18 (or set "Remote node path").'
    throw new Error(`Could not run the agent on ${this.host}: ${last}. ${hint}`)
  }

  start(): Promise<RemoteInfo> {
    if (this.alive && this.info) return Promise.resolve(this.info)
    if (this.starting) return this.starting
    this.starting = (async () => {
      await this.install()
      const p = spawn(this.ssh, this.sshArgs(this.node(`.orca-qt-lsp/${this.agentFile}`)), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = p
      let errTail = ''
      p.stderr!.on('data', (d) => { errTail = (errTail + d).slice(-2000) })
      p.on('error', (e) => { this.lastError = e.message })
      p.on('exit', (code) => {
        this.lastError = `${this.host}: agent exited (${code}) ${errTail.trim().split('\n').pop() ?? ''}`
        this.log(this.lastError)
        this.info = null
        this.proc = null
        for (const x of this.pending.values()) { clearTimeout(x.timer); x.reject(new Error(this.lastError)) }
        this.pending.clear()
      })
      createInterface({ input: p.stdout! }).on('line', (line) => {
        let m: any
        try { m = JSON.parse(line) } catch { return }
        if (m.log) { this.log(`${this.host}: ${m.log}`); return }
        if (m.ev) { this.onEvent(m.ev, m.p); return }
        const x = this.pending.get(m.id)
        if (!x) return
        this.pending.delete(m.id)
        clearTimeout(x.timer)
        if ('e' in m) x.reject(new Error(m.e)); else x.resolve(m.r)
      })
      const info = await this.call<RemoteInfo>('$hello', { settings: this.settings, language: LANGUAGE_PROFILE, pluginId: PLUGIN_ID }, 30000)
      if (LANGUAGE_PROFILE !== 'all' && (info.language !== LANGUAGE_PROFILE || info.pluginId !== PLUGIN_ID)) {
        this.stop(); throw new Error('Remote agent language/profile identity mismatch')
      }
      this.info = info
      return info
    })().finally(() => { this.starting = null })
    return this.starting
  }

  call<T = any>(m: string, p: unknown, timeoutMs = 90000): Promise<T> {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return Promise.reject(new Error(this.lastError || `${this.host}: not connected`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.host}: ${m} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin!.write(JSON.stringify({ id, m, p }) + '\n')
    })
  }

  /** Send without waiting for a reply (e.g. the list of root folders). */
  notify(m: string, p: unknown) { if (this.proc && this.proc.exitCode === null) this.proc.stdin!.write(JSON.stringify({ id: 0, m, p }) + '\n') }

  stop() { try { this.proc?.stdin?.end() } catch { /* */ } setTimeout(() => { try { this.proc?.kill() } catch { /* */ } }, 2000) }
}
