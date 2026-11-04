// Worker Orca cua Qt LSP: chay loi (core.ts) cho file tren may nay, va chuyen sang agent tren may khac
// qua SSH (remote.ts) khi file mo trong Orca nam o may do (workspace SSH, may ghep doi...).
// Tu dong toi da: khong thay file tren may nay -> do tim tren moi may trong ~/.ssh/config (chi doc, song song),
// may nao co file thi chay agent o do va nho cho du an; nut ⇄ o thanh trang thai de doi may cho tung du an.
// Duong dan file o may khac duoc danh dau "@<host>:<duong dan>" de editor dung nguyen nhu duong dan thuong.
import type { OrcaWorkerApi } from 'orca/worker'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from './core'
import { RemoteAgent, findSsh } from './remote'
import { EXT_RE, PROBE_SKIP } from './probe-script'
import type { AttachInput, AttachOutput } from './protocol'

const WIN = process.platform === 'win32'
const norm = (p: string) => (WIN ? p.toLowerCase() : p)
const isLocal = (w: { hostId: string | null }) => !w.hostId || w.hostId === 'local'
const HERE = dirname(fileURLToPath(import.meta.url))

/** "@host:C:\x\y.py" <-> { host, path } */
const REMOTE_RE = /^@([^:]+):(.*)$/s
const tag = (host: string, p: string) => `@${host}:${p}`
const untag = (p: string): { host: string; path: string } | null => { const m = REMOTE_RE.exec(p); return m ? { host: m[1], path: m[2] } : null }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** May trong ~/.ssh/config (bo mau * ?). auto=true: chi may thu tu dong duoc - bo may qua ProxyCommand
 *  (vd. cloudflared co the mo trinh duyet dang nhap), may Git (github...), va alias trung may chi giu mot. */
export function sshConfigHosts(auto = false, configPath = join(homedir(), '.ssh', 'config')): string[] {
  type Block = { names: string[]; opts: Record<string, string> }
  const blocks: Block[] = []
  const read = (file: string, depth: number) => {
    if (depth > 3 || !existsSync(file)) return
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return }
    let cur: Block | null = null
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim()
      const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line)
      if (!m) continue
      const k = m[1].toLowerCase()
      if (k === 'host') { cur = { names: m[2].split(/\s+/).filter(Boolean), opts: {} }; blocks.push(cur); continue }
      if (k === 'match') { cur = null; continue }
      if (k === 'include') {
        for (const v of m[2].split(/\s+/)) {
          if (/[*?]/.test(v)) continue
          const p = v.replace(/^~/, homedir())
          read(/^([\\/]|[A-Za-z]:)/.test(p) ? p : join(homedir(), '.ssh', p), depth + 1)
        }
        continue
      }
      if (cur && !(k in cur.opts)) cur.opts[k] = m[2].trim()
    }
  }
  read(configPath, 0)
  const out: string[] = []
  const seenTarget = new Set<string>()
  for (const b of blocks) {
    for (const n of b.names) {
      if (/[*?!]/.test(n)) continue
      const hostName = (b.opts.hostname ?? n).toLowerCase()
      if (/^(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com|ssh\.github\.com)$/.test(hostName)) continue
      if (auto && b.opts.proxycommand) continue
      const target = `${(b.opts.user ?? '').toLowerCase()}@${hostName}:${b.opts.port ?? '22'}|${b.opts.proxyjump ?? ''}`
      if (auto && seenTarget.has(target)) continue
      seenTarget.add(target)
      out.push(n)
    }
  }
  return [...new Set(out)]
}

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
  const cfg = { sshPath: '', remoteRoots: '', remoteNode: '' }
  const loadCfg = async () => {
    cfg.sshPath = String(await setting('sshPath', ''))
    cfg.remoteRoots = String(await setting('remoteRoots', ''))
    cfg.remoteNode = String(await setting('remoteNode', ''))
  }
  const cfgReady = loadCfg()
  try {
    (orca.settings as any).onDidChange?.(() => { void loadCfg(); for (const a of agents.values()) a.stop(); agents.clear() })
  } catch { /* ban Orca cu khong co onDidChange */ }
  const extraHosts = async () => String(await setting('remoteHosts', '')).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)

  function remoteFor(host: string): RemoteAgent {
    let a = agents.get(host)
    if (!a) {
      agentSource ??= readFileSync(join(HERE, 'agent.mjs'), 'utf8')
      a = new RemoteAgent(host, findSsh(cfg.sshPath), agentSource, { remoteRoots: cfg.remoteRoots, remoteNode: cfg.remoteNode })
      a.log = (l) => orca.log(l)
      a.onEvent = (ev, p: any) => {
        // Su kien tu agent mang duong dan cua may kia: gan nhan host truoc khi gui cho editor
        if (p && typeof p.path === 'string') p = { ...p, path: tag(host, p.path) }
        orca.panels.post(ev as any, p)
      }
      agents.set(host, a)
    }
    return a
  }
  async function agentFor(host: string): Promise<RemoteAgent> {
    await cfgReady
    const a = remoteFor(host)
    await a.start()
    return a
  }

  /** Duong dan workspace Orca dang tro sang may khac (SSH...): goi y cho may kia noi can tim. */
  async function remoteHints(): Promise<string[]> {
    const { workspaces } = await orca.host.call('workspace.list', {}).catch(() => ({ workspaces: [] as { path: string; hostId: string | null }[] }))
    return workspaces.filter((w) => !isLocal(w)).map((w) => w.path)
  }

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

  // ---------- May cho tung du an (nut ⇄ o thanh trang thai cua editor) ----------
  // Khoa = ten workspace Orca dang focus. Gia tri: ten may SSH, 'local', hoac khong co (tu dong).
  const PROJECT_HOSTS = 'projectHosts'
  const NO_PROJECT = '(không có workspace)'
  async function projectKey(): Promise<string> {
    const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
    return ctx?.displayName || NO_PROJECT
  }
  async function projectHosts(): Promise<Record<string, string>> {
    try { const v = await orca.storage.get(PROJECT_HOSTS); return v && typeof v === 'object' ? { ...(v as Record<string, string>) } : {} } catch { return {} }
  }
  async function rememberHost(key: string, host: string | null) {
    const map = await projectHosts()
    if (host) map[key] = host; else delete map[key]
    await orca.storage.set(PROJECT_HOSTS, map as any)
  }

  async function attachOn(host: string, input: AttachInput, hints: string[]): Promise<AttachOutput> {
    const a = await agentFor(host)
    const r: AttachOutput = await a.call('lsp.attach', { ...input, hints }, 120000)
    return r.path ? tagPaths(host, r) : r
  }

  async function attach(input: AttachInput): Promise<AttachOutput> {
    await cfgReady
    const key = await projectKey()
    const chosen = (await projectHosts())[key]
    if (chosen === 'local') return local.handlers['lsp.attach'](input)
    // Du an da co may (chon tay hoac tu tim lan truoc): vao thang may do
    if (chosen) {
      try {
        const r = await attachOn(chosen, input, await remoteHints())
        if (r.path) return r
        // May cu khong con file (doi may, xoa du an): bo nho, tim lai tu dau
        await rememberHost(key, null)
      } catch (e) {
        return { ok: false, path: null, candidates: 0, workspace: null, server: null, message: `${chosen}: ${errText(e)} — bấm ⇄ ở góc dưới để chọn máy khác.` }
      }
    }
    const res: AttachOutput = await local.handlers['lsp.attach'](input)
    if (res.path) return res

    // Tu dong: do moi may SSH biet duoc (Settings + ~/.ssh/config) cung luc bang script chi doc (khong cai gi);
    // may nao co file thi moi chay agent o do va nho cho du an nay. May can mat khau / dang tat thi bo qua (BatchMode).
    const hosts = [...new Set([...(await extraHosts()), ...sshConfigHosts(true)])].slice(0, 40)
    if (!hosts.length) {
      return { ...res, message: 'Không tìm thấy file trên máy này, và ~/.ssh/config chưa có máy nào. Nếu code ở máy khác: bấm ⇄ ở góc dưới, gõ user@host.' }
    }
    const hints = await remoteHints()
    const sizes = [input.size, input.sizeCrlf].filter((s): s is number => typeof s === 'number').flatMap((s) => [s, s + 3])
    const roots = cfg.remoteRoots.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
    const q = { hash: input.hash ?? '', sizes, ext: EXT_RE[input.language], hints, roots, skip: PROBE_SKIP, ms: 25000 }
    const errors: string[] = []
    const found = await new Promise<{ host: string; root: string } | null>((done) => {
      let left = hosts.length
      let settled = false
      for (const host of hosts) {
        void remoteFor(host).probe(q).then(
          (hit) => { if (hit && !settled) { settled = true; done({ host, root: hit.root }) } else if (!hit) errors.push(`${host}: không có`) },
          (e) => { errors.push(`${host}: ${errText(e).slice(0, 80)}`) }
        ).finally(() => { if (--left === 0 && !settled) { settled = true; done(null) } })
      }
    })
    if (found) {
      orca.log(`project "${key}" -> ${found.host} (tự tìm thấy trong ${found.root})`)
      try {
        const r = await attachOn(found.host, input, [found.root, ...hints])
        // Chi nho khi biet du an (workspace dang focus); khong focus thi lan sau van tu tim lai
        if (r.path) { if (key !== NO_PROJECT) await rememberHost(key, found.host); return r }
      } catch (e) {
        return { ...res, message: `Tìm thấy file trên ${found.host} nhưng không chạy được agent: ${errText(e)}` }
      }
    }
    orca.log(`attach miss on ${hosts.length} hosts: ${errors.join('; ')}`)
    return { ...res, message: `Không tìm thấy file trên máy này và ${hosts.length} máy SSH (${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}). Bấm ⇄ ở góc dưới để chọn máy.` }
  }

  /** Moi handler khac: duong dan co nhan host thi chuyen sang agent cua host do. */
  const route = (name: string) => async (input: any) => {
    const target = input && typeof input.path === 'string' ? untag(input.path) : null
    if (!target) return local.handlers[name](input)
    if (name === 'lsp.reveal') return { opened: false, reason: 'remote' }
    const a = await agentFor(target.host)
    const out = tagPaths(target.host, await a.call(name, { ...input, path: target.path }))
    // May khac: Orca khong mo duoc tab cho file do qua plugin -> editor hien peek thay vi mo tab
    if (name === 'lsp.definition' && out?.locations) for (const l of out.locations) l.inWorkspace = false
    return out
  }

  orca.panels.handle('lsp.attach', (input) => attach(input as unknown as AttachInput) as any)
  for (const name of Object.keys(local.handlers)) if (name !== 'lsp.attach') orca.panels.handle(name, route(name) as any)

  /** Nut ⇄: may dang dung cho du an + danh sach may goi y. */
  orca.panels.handle('lsp.hostChoice', async () => {
    const key = await projectKey()
    const map = await projectHosts()
    const hosts = [...new Set([...(await extraHosts()), ...Object.values(map).filter((h) => h !== 'local'), ...sshConfigHosts(false)])]
    return { project: key, chosen: map[key] ?? null, hosts } as any
  })
  orca.panels.handle('lsp.setHost', async (input) => {
    const host = ((input as { host?: string | null } | null)?.host ?? '').trim() || null
    const key = await projectKey()
    await rememberHost(key, host)
    orca.log(`project "${key}" -> ${host ?? 'tự động'} (chọn tay)`)
    // Kiem tra ket noi ngay de bao loi som (khoa SSH, Node...)
    if (host && host !== 'local') {
      try { const a = await agentFor(host); return { project: key, chosen: host, ok: true, info: a.info } as any }
      catch (e) { return { project: key, chosen: host, ok: false, error: errText(e) } as any }
    }
    return { project: key, chosen: host, ok: true } as any
  })
  orca.panels.handle('lsp.remoteStatus', async () => ({
    projects: await projectHosts(),
    agents: [...agents.values()].map((a) => ({ host: a.host, alive: a.alive, info: a.info, error: a.lastError }))
  }) as any)

  orca.events.on('workspace.removed', ({ path }) => local.workspaceRemoved(path))
}

export function deactivate(): void { /* cac tien trinh con (server, ssh) tu thoat khi worker dung */ }
