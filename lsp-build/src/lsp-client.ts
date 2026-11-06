// Minimal LSP client over stdio (JSON-RPC, Content-Length). Runs in the plugin's Node worker.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

type Handler = (params: any) => any

export class LspClient {
  private proc: ChildProcess
  private buf = Buffer.alloc(0)
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; cleanup: () => void }>()
  private notifyHandlers = new Map<string, Handler>()
  private requestHandlers = new Map<string, Handler>()
  private cancellationFolder?: string
  private cancelled = new Set<number>()
  exited = false
  onExit?: (code: number | null) => void
  log: (line: string) => void = () => {}

  constructor(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, options?: { fileCancellation?: boolean }) {
    if (options?.fileCancellation) {
      const base = join(tmpdir(), 'python-languageserver-cancellation')
      mkdirSync(base, { recursive: true })
      this.cancellationFolder = mkdtempSync(join(base, 'orca-'))
      args = [...args, `--cancellationReceive=file:${basename(this.cancellationFolder)}`]
    }
    this.proc = spawn(command, args, { cwd, env: env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d))
    this.proc.stderr!.on('data', (d: Buffer) => this.log(`[stderr] ${d.toString().trim().slice(0, 500)}`))
    this.proc.on('exit', (code) => {
      this.exited = true
      for (const p of this.pending.values()) { p.cleanup(); p.reject(new Error('language server exited')) }
      this.pending.clear()
      this.clearCancellationFolder()
      this.onExit?.(code)
    })
    this.proc.on('error', (e) => {
      this.log(`[spawn] ${e.message}`)
      this.exited = true
      for (const p of this.pending.values()) { p.cleanup(); p.reject(e) }
      this.pending.clear()
      this.clearCancellationFolder()
    })
  }

  onNotification(method: string, h: Handler) { this.notifyHandlers.set(method, h) }
  onRequest(method: string, h: Handler) { this.requestHandlers.set(method, h) }

  request<T = any>(method: string, params: unknown, timeoutMs = 15000, signal?: AbortSignal): Promise<T> {
    if (this.exited) return Promise.reject(new Error('language server exited'))
    const aborted = () => Object.assign(new Error('Request cancelled'), { name: 'AbortError' })
    if (signal?.aborted) return Promise.reject(aborted())
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        this.cancelRequest(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      const cancel = () => {
        if (!this.pending.delete(id)) return
        cleanup()
        this.cancelRequest(id)
        reject(aborted())
      }
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', cancel, { once: true })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown) {
    if (!this.exited) this.write({ jsonrpc: '2.0', method, params })
  }

  kill() { try { this.proc.kill() } catch { /* already exited */ } }

  private cancelRequest(id: number) {
    if (this.cancellationFolder) {
      try {
        writeFileSync(join(this.cancellationFolder, `cancellation-${id}.tmp`), '')
        this.cancelled.add(id)
      } catch (e) { this.log(`[cancellation] ${String(e)}`) }
    }
    this.notify('$/cancelRequest', { id })
  }

  private clearCancellationFolder() {
    const folder = this.cancellationFolder
    // Never recurse outside the unique folder allocated by this client.
    if (folder && dirname(resolve(folder)) === resolve(tmpdir(), 'python-languageserver-cancellation') && basename(folder).startsWith('orca-')) {
      try { rmSync(folder, { recursive: true, force: true }) } catch { /* best effort after exit */ }
    }
    this.cancellationFolder = undefined
    this.cancelled.clear()
  }

  private write(msg: unknown) {
    const s = JSON.stringify(msg)
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(s, 'utf8')}\r\n\r\n${s}`)
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n')
      if (h < 0) return
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, h).toString('ascii'))
      if (!m) { this.buf = this.buf.subarray(h + 4); continue }
      const len = Number(m[1])
      if (this.buf.length < h + 4 + len) return
      const body = this.buf.subarray(h + 4, h + 4 + len).toString('utf8')
      this.buf = this.buf.subarray(h + 4 + len)
      let msg: any
      try { msg = JSON.parse(body) } catch { continue }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: any) {
    if (msg.id !== undefined && msg.method === undefined) {
      if (this.cancelled.delete(msg.id) && this.cancellationFolder) {
        try { rmSync(join(this.cancellationFolder, `cancellation-${msg.id}.tmp`), { force: true }) } catch { /* exit cleanup retries */ }
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      p.cleanup()
      if (msg.error) p.reject(new Error(msg.error.message ?? 'LSP error'))
      else p.resolve(msg.result)
      return
    }
    if (msg.id !== undefined) {
      const h = this.requestHandlers.get(msg.method)
      Promise.resolve(h ? h(msg.params) : null)
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null }))
        .catch((e) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } }))
      return
    }
    this.notifyHandlers.get(msg.method)?.(msg.params)
  }
}
