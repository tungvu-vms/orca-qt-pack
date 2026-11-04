// Ket noi toi agent Qt LSP tren may khac qua lenh `ssh` cua he thong (OpenSSH co san tren macOS, Linux, Windows 10+).
// - Khong can mo cong hay cai gi truoc: lan dau worker tu chep agent sang (~/.orca-qt-lsp/agent-<ma>.mjs)
//   bang `ssh host node -` + stdin, nen khong phu thuoc shell ben kia (sh, zsh, PowerShell, cmd).
// - Can: dang nhap SSH bang khoa (BatchMode, khong hoi mat khau) va Node >= 18 tren may kia.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

export interface RemoteInfo { version: string; platform: string; node: string; home: string }

/** Cach goi node tren may kia: PATH cua phien SSH, cho cai pho bien, roi shell dang nhap (nvm, fnm, asdf...). */
const NODE_CANDIDATES: ((args: string) => string[])[] = [
  (a) => ['node', a],
  (a) => ['/opt/homebrew/bin/node', a],
  (a) => ['/usr/local/bin/node', a],
  (a) => ['/usr/bin/node', a],
  // nvm / fnm / volta / asdf: node khong nam tren PATH cua phien SSH khong tuong tac.
  // Lenh duoi chay bang sh (Linux/macOS); tren Windows (cmd) se loi va bi bo qua.
  (a) => ['sh', '-c', `'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node 2>/dev/null | sort -V | tail -1); [ -n "$n" ] && exec "$n" ${a}; exit 127'`],
  (a) => ['bash', '-lc', `'exec node ${a}'`],
  (a) => ['zsh', '-lc', `'exec node ${a}'`],
  (a) => ['bash', '-ic', `'exec node ${a}'`]
]

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
    this.version = createHash('sha1').update(agentSource).digest('hex').slice(0, 10)
  }

  get alive() { return !!this.proc && this.proc.exitCode === null && !!this.info }

  private sshArgs(cmd: string[]) {
    return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', this.host, ...cmd]
  }

  /** Chay mot lenh ngan qua SSH, gui `input` vao stdin roi dong. */
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

  /** Chep agent sang may kia (neu chua co ban nay) va tim node dung duoc. */
  private async install(): Promise<void> {
    const b64 = Buffer.from(this.agentSource).toString('base64')
    const script = `const fs=require('fs'),path=require('path'),os=require('os');` +
      `const d=path.join(os.homedir(),'.orca-qt-lsp');fs.mkdirSync(d,{recursive:true});` +
      `const f=path.join(d,'agent-${this.version}.mjs');` +
      `if(!fs.existsSync(f)){fs.writeFileSync(f+'.tmp',Buffer.from('${b64}','base64'));fs.renameSync(f+'.tmp',f)}` +
      `for(const n of fs.readdirSync(d))if(/^agent-[0-9a-f]+\\.mjs$/.test(n)&&n!=='agent-${this.version}.mjs')try{fs.unlinkSync(path.join(d,n))}catch{}` +
      `console.log('QTLSP-OK '+process.version+' '+process.platform)\n`
    const tried: string[] = []
    const custom = String(this.settings.remoteNode ?? '').trim()
    const candidates = custom ? [(a: string) => [custom, a], ...NODE_CANDIDATES] : NODE_CANDIDATES
    for (const node of candidates) {
      const r = await this.run(node('-'), script)
      if (r.out.includes('QTLSP-OK')) { this.node = node; this.log(`${this.host}: agent ${this.version} san sang (${r.out.trim().split(' ').slice(1).join(' ')}, ${node('').join(' ')})`); return }
      tried.push(`${node('').join(' ')}: ${(r.err || r.out).trim().split('\n').pop()?.slice(0, 160) ?? r.code}`)
      // Loi SSH (khong ket noi/khong co khoa) thi thu node khac cung vo ich
      if (r.code === 255) break
    }
    const last = tried[tried.length - 1] ?? ''
    const hint = /Host key verification|Permission denied|publickey|Could not resolve|timed out|Connection refused/i.test(last)
      ? `Kiểm tra: chạy "ssh ${this.host}" một lần trong terminal (chấp nhận host key) và dùng khóa SSH, không mật khẩu.`
      : 'Máy kia cần Node.js >= 18 (hoặc đặt "Remote node path").'
    throw new Error(`Không chạy được agent trên ${this.host}: ${last}. ${hint}`)
  }

  start(): Promise<RemoteInfo> {
    if (this.alive && this.info) return Promise.resolve(this.info)
    if (this.starting) return this.starting
    this.starting = (async () => {
      await this.install()
      const p = spawn(this.ssh, this.sshArgs(this.node(`.orca-qt-lsp/agent-${this.version}.mjs`)), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = p
      let errTail = ''
      p.stderr!.on('data', (d) => { errTail = (errTail + d).slice(-2000) })
      p.on('error', (e) => { this.lastError = e.message })
      p.on('exit', (code) => {
        this.lastError = `${this.host}: agent thoát (${code}) ${errTail.trim().split('\n').pop() ?? ''}`
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
      const info = await this.call<RemoteInfo>('$hello', { settings: this.settings }, 30000)
      this.info = info
      return info
    })().finally(() => { this.starting = null })
    return this.starting
  }

  call<T = any>(m: string, p: unknown, timeoutMs = 90000): Promise<T> {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return Promise.reject(new Error(this.lastError || `${this.host}: chưa kết nối`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.host}: ${m} quá thời gian`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin!.write(JSON.stringify({ id, m, p }) + '\n')
    })
  }

  /** Gui khong cho tra loi (vd. danh sach thu muc goc). */
  notify(m: string, p: unknown) { if (this.proc && this.proc.exitCode === null) this.proc.stdin!.write(JSON.stringify({ id: 0, m, p }) + '\n') }

  stop() { try { this.proc?.stdin?.end() } catch { /* */ } setTimeout(() => { try { this.proc?.kill() } catch { /* */ } }, 2000) }
}
