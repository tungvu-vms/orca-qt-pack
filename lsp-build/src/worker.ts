// Worker Orca cua Qt LSP: chay loi (core.ts) cho file tren may nay, va chuyen sang agent tren may khac
// qua SSH (remote.ts) khi file mo trong Orca nam o may do (workspace SSH, may ghep doi...).
// Duong dan file o may khac duoc danh dau "@<host>:<duong dan>" de editor dung nguyen nhu duong dan thuong.
import type { OrcaWorkerApi } from 'orca/worker'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from './core'
import { RemoteAgent, findSsh } from './remote'
import type { AttachInput, AttachOutput } from './protocol'

const WIN = process.platform === 'win32'
const norm = (p: string) => (WIN ? p.toLowerCase() : p)
const isLocal = (w: { hostId: string | null }) => !w.hostId || w.hostId === 'local'
const HERE = dirname(fileURLToPath(import.meta.url))

/** "@host:C:\x\y.py" <-> { host, path } */
const REMOTE_RE = /^@([^:]+):(.*)$/s
const tag = (host: string, p: string) => `@${host}:${p}`
const untag = (p: string): { host: string; path: string } | null => { const m = REMOTE_RE.exec(p); return m ? { host: m[1], path: m[2] } : null }

export default function activate(orca: OrcaWorkerApi): void {
  const setting = async <T,>(k: string, fallback: T): Promise<T> => {
    try { const v = await orca.settings.get(k); return (v === undefined || v === null || v === '' ? fallback : v) as T } catch { return fallback }
  }

  async function localRoots(): Promise<{ focused: string | null; roots: string[] }> {
    const { workspaces } = await orca.host.call('workspace.list', {})
    const local = workspaces.filter(isLocal)
    let focused: string | null = null
    const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
    if (ctx) {
      const m = local.find((w) => w.name === ctx.displayName && (w.branch ?? '') === (ctx.branch ?? '')) ?? local.find((w) => w.name === ctx.displayName)
      focused = m?.path ?? null
    }
    return { focused, roots: local.map((w) => resolve(w.path)) }
  }

  const local = createCore({
    log: (m) => orca.log(m),
    post: (ev, p) => orca.panels.post(ev as any, p as any),
    setting,
    storageGet: (k) => orca.storage.get(k),
    storageSet: async (k, v) => { await orca.storage.set(k, v as any) },
    roots: () => localRoots(),
    reveal: async (path, line) => {
      const { workspaces } = await orca.host.call('workspace.list', {})
      const p = norm(resolve(path))
      let ws: (typeof workspaces)[number] | null = null
      for (const w of workspaces) if (isLocal(w) && p.startsWith(norm(resolve(w.path)) + (WIN ? '\\' : '/')) && (!ws || w.path.length > ws.path.length)) ws = w
      if (!ws) return { opened: false, reason: 'outside' }
      const rel = resolve(path).slice(resolve(ws.path).length + 1).split(/[\\/]/).join('/')
      await orca.host.call('editor.open', { workspaceId: ws.id, path: rel })
      return { opened: true, line, rel }
    }
  })

  // ---------- may khac qua SSH ----------
  const agents = new Map<string, RemoteAgent>()
  let agentSource: string | null = null
  const hostsSetting = async () => String(await setting('remoteHosts', '')).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)

  async function agentFor(host: string): Promise<RemoteAgent> {
    let a = agents.get(host)
    if (!a) {
      agentSource ??= readFileSync(join(HERE, 'agent.mjs'), 'utf8')
      a = new RemoteAgent(host, findSsh(await setting('sshPath', '')), agentSource, { remoteRoots: await setting('remoteRoots', ''), remoteNode: await setting('remoteNode', '') })
      a.log = (l) => orca.log(l)
      a.onEvent = (ev, p: any) => {
        // Su kien tu agent mang duong dan cua may kia: gan nhan host truoc khi gui cho editor
        if (p && typeof p.path === 'string') p = { ...p, path: tag(host, p.path) }
        orca.panels.post(ev as any, p)
      }
      agents.set(host, a)
    }
    await a.start()
    return a
  }

  /** Duong dan workspace Orca dang tro sang may khac (SSH...): goi y cho agent noi can tim. */
  async function remoteHints(): Promise<string[]> {
    const { workspaces } = await orca.host.call('workspace.list', {}).catch(() => ({ workspaces: [] as { path: string; hostId: string | null }[] }))
    return workspaces.filter((w) => !isLocal(w)).map((w) => w.path)
  }

  /** Doi moi duong dan "path" trong ket qua cua agent sang dang co nhan host. */
  // Chi gan nhan cho duong dan FILE (ket qua attach, locations, peek); interpreter (python.exe) giu nguyen
  // vi editor gui lai nguyen gia tri do cho agent.
  const SKIP_KEYS = new Set(['current', 'list', 'interpreter'])
  const tagPaths = (host: string, v: any): any => {
    if (Array.isArray(v)) return v.map((x) => tagPaths(host, x))
    if (v && typeof v === 'object') {
      const o: any = {}
      for (const [k, x] of Object.entries(v)) o[k] = SKIP_KEYS.has(k) ? x : (k === 'path' || k === 'workspace') && typeof x === 'string' ? tag(host, x) : tagPaths(host, x)
      return o
    }
    return v
  }

  async function attach(input: AttachInput): Promise<AttachOutput> {
    const res: AttachOutput = await local.handlers['lsp.attach'](input)
    if (res.path) return res
    const hosts = await hostsSetting()
    if (!hosts.length) {
      return { ...res, message: 'Không tìm thấy file này trên máy này. Nếu file nằm ở máy khác (SSH, máy ghép nối): thêm máy đó vào Settings → Qt Code Intelligence → "Remote SSH hosts".' }
    }
    const hints = await remoteHints()
    const errors: string[] = []
    for (const host of hosts) {
      try {
        const a = await agentFor(host)
        const r: AttachOutput = await a.call('lsp.attach', { ...input, hints }, 120000)
        if (r.path) return tagPaths(host, r)
        errors.push(`${host}: không có`)
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    return { ...res, message: `Không tìm thấy file trên máy này và trên ${hosts.join(', ')} (${errors.join('; ')}). Máy kia: thêm thư mục dự án vào "Remote project folders" nếu không phải workspace Orca.` }
  }

  /** Moi handler khac: duong dan co nhan host thi chuyen sang agent cua host do. */
  const route = (name: string) => async (input: any) => {
    const target = input && typeof input.path === 'string' ? untag(input.path) : null
    if (!target) return local.handlers[name](input)
    const a = await agentFor(target.host)
    if (name === 'lsp.reveal') return { opened: false, reason: 'remote' }
    const out = tagPaths(target.host, await a.call(name, { ...input, path: target.path }))
    // May khac: Orca khong mo duoc tab cho file do qua plugin -> editor hien peek thay vi mo tab
    if (name === 'lsp.definition' && out?.locations) for (const l of out.locations) l.inWorkspace = false
    return out
  }

  orca.panels.handle('lsp.attach', (input) => attach(input as unknown as AttachInput) as any)
  for (const name of Object.keys(local.handlers)) if (name !== 'lsp.attach') orca.panels.handle(name, route(name) as any)
  orca.panels.handle('lsp.remoteStatus', async () => ({
    hosts: await hostsSetting(),
    agents: [...agents.values()].map((a) => ({ host: a.host, alive: a.alive, info: a.info, error: a.lastError }))
  }) as any)

  orca.events.on('workspace.removed', ({ path }) => local.workspaceRemoved(path))
}

export function deactivate(): void { /* cac tien trinh con (server, ssh) tu thoat khi worker dung */ }
