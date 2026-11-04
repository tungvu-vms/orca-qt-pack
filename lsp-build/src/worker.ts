// Worker cua Qt LSP: chay language server cho Python (basedpyright), QML (qmlls) va C/C++ (clangd),
// do ra duong dan file dang mo (editor khong biet path), chuyen yeu cau tu editor sang server.
// Moi (ngon ngu, goc du an) mot server.
import type { OrcaWorkerApi } from 'orca/worker'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LspClient } from './lsp-client'
import { discoverInterpreters, type Interpreter } from './interpreters'
import { EXTS_OF_LANG, LANGUAGE_ID, SERVER_LABEL, findBuildDirs, findClangd, findQmlls, projectRootFor, type Lang } from './servers'
import type {
  AttachInput, AttachOutput, CompletionOutput, DefinitionOutput, DiagnosticsOutput, DocInput, HoverOutput, Loc, PosInput
} from './protocol'

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'env', 'dist', '.orca', '.mypy_cache', '.pytest_cache', 'site-packages', '.cache', '.qtc_clangd',
  // workspace la thu muc home (vd. /Users/<ten>): bo qua thu muc he thong/media lon
  'Library', 'Applications', 'AppData', 'Movies', 'Music', 'Pictures', 'Downloads', '$Recycle.Bin'])
const sha = (s: string) => createHash('sha1').update(s.replace(/\r\n/g, '\n')).digest('hex')
const WIN = process.platform === 'win32'

/** Thu muc cua plugin (worker nam o <plugin>/worker/worker.mjs). */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Server {
  lang: Lang
  root: string
  client: LspClient
  ready: Promise<void>
  open: Map<string, number>
  diagnostics: Map<string, DiagnosticsOutput>
  legend: { tokenTypes: string[]; tokenModifiers: string[] } | null
  /** Python: interpreter dang dung */
  interpreter: Interpreter | null
  /** Thong tin hien thi (build dir dung cho clangd/qmlls...) */
  detail: string
}

/** Orca tra hostId 'local' (hoac null) cho may nay; khac thi la may tu xa qua SSH. */
const isLocal = (w: { hostId: string | null }) => !w.hostId || w.hostId === 'local'
const norm = (p: string) => (WIN ? p.toLowerCase() : p)
const key = (lang: Lang, root: string) => `${lang}|${norm(root)}`
const langOfPath = (p: string): Lang | null => (EXTS_OF_LANG.python.test(p) ? 'python' : EXTS_OF_LANG.qml.test(p) ? 'qml' : EXTS_OF_LANG.cpp.test(p) ? 'cpp' : null)

export default function activate(orca: OrcaWorkerApi): void {
  const servers = new Map<string, Server>()
  const hashIndex = new Map<string, { at: number; byHash: Map<string, string[]> }>()

  async function setting<T>(k: string, fallback: T): Promise<T> {
    try { const v = await orca.settings.get(k); return (v === undefined || v === null || v === '' ? fallback : v) as T } catch { return fallback }
  }

  async function focusedRoot(): Promise<string | null> {
    const ctx = await orca.host.call('workspace.readContext', {})
    if (!ctx) return null
    const { workspaces } = await orca.host.call('workspace.list', {})
    const local = workspaces.filter(isLocal)
    const pool = local.length ? local : workspaces
    const m = pool.find((w) => w.name === ctx.displayName && (w.branch ?? '') === (ctx.branch ?? '')) ?? pool.find((w) => w.name === ctx.displayName)
    return m?.path ?? null
  }

  /** Chi muc RE theo kich thuoc file (khong doc noi dung): "size:<bytes>" -> duong dan.
   *  Du an lon (a large project: 10k thu muc, 8.7k file nguon, 127 MB) bam het mat ~11 s/workspace va vuot gioi han so file;
   *  nen chi bam nhung file cung kich thuoc voi file dang mo (thuong 1-3 file).
   *  Thu muc build sinh ra bi bo qua khi quet. */
  const MAX_FILES = 200000
  const skipDir = (n: string) => SKIP.has(n) || n.startsWith('.') || /^(build|out|cmake-build-)/i.test(n)
  /** Quet theo chieu rong (thu muc nong truoc): workspace co the la ca thu muc home.
   *  `match` duoc goi cho tung file; tra ve true thi dung som (khong luu chi muc do chua day du). */
  function scan(root: string, match?: (full: string, size: number) => boolean): string | null {
    const cached = hashIndex.get(root)
    if (cached && Date.now() - cached.at < 300000) return null
    const bySize = new Map<string, string[]>()
    let count = 0
    const stopAt = Date.now() + 30000
    let level: string[] = [root]
    for (let depth = 0; level.length && depth <= 14; depth++) {
      const next: string[] = []
      for (const dir of level) {
        if (count > MAX_FILES || Date.now() > stopAt) return null
        let ents: import('node:fs').Dirent[] = []
        try { ents = readdirSync(dir, { withFileTypes: true }) } catch { continue }
        for (const e of ents) {
          const n = e.name
          if (e.isDirectory()) { if (!skipDir(n)) next.push(join(dir, n)); continue }
          if (!e.isFile() || !langOfPath(n)) continue
          const full = join(dir, n)
          let size: number
          try { size = statSync(full).size } catch { continue }
          count++
          const k = `size:${size}`
          const list = bySize.get(k)
          if (list) list.push(full); else bySize.set(k, [full])
          if (match?.(full, size)) return full
        }
      }
      level = next
    }
    hashIndex.set(root, { at: Date.now(), byHash: bySize })
    return null
  }
  /** Chi muc theo kich thuoc file (chi stat, khong doc noi dung): "size:<bytes>" -> duong dan. */
  function indexFor(root: string): Map<string, string[]> {
    scan(root)
    return hashIndex.get(root)?.byHash ?? new Map()
  }
  /** Bam noi dung co cache theo (duong dan, mtime, size). */
  const hashCache = new Map<string, { mtime: number; size: number; h: string }>()
  function fileHash(p: string): string | null {
    try {
      const st = statSync(p)
      const c = hashCache.get(p)
      if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.h
      const h = sha(readFileSync(p, 'utf8').replace(/^﻿/, ''))
      hashCache.set(p, { mtime: st.mtimeMs, size: st.size, h })
      return h
    } catch { return null }
  }

  // ---------- Python interpreter ----------
  const SAVED_KEY = 'interpreters'
  async function savedInterpreters(): Promise<Record<string, string>> {
    try { const v = await orca.storage.get(SAVED_KEY); return v && typeof v === 'object' ? (v as Record<string, string>) : {} } catch { return {} }
  }
  async function interpretersFor(root: string, file?: string): Promise<Interpreter[]> {
    const saved = (await savedInterpreters())[norm(root)]
    return discoverInterpreters(file ?? join(root, '__init__.py'), root, { saved, setting: await setting('python', '') })
  }

  // ---------- Tim chuong trinh ----------
  function findNode(): string {
    const exe = WIN ? 'node.exe' : 'node'
    for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(WIN ? ';' : ':')) if (dir && existsSync(join(dir, exe))) return join(dir, exe)
    for (const c of WIN ? ['C:\\Program Files\\nodejs\\node.exe'] : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']) if (existsSync(c)) return c
    return process.execPath
  }
  function pyrightEntry(): string | null {
    const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
    const local = process.env.LOCALAPPDATA ?? (WIN ? join(h, 'AppData', 'Local') : join(h, '.local', 'share'))
    const appData = process.env.APPDATA ?? (WIN ? join(h, 'AppData', 'Roaming') : undefined)
    const c = [join(PLUGIN_DIR, 'server', 'pyright', 'langserver.index.js'), join(local, 'orca-qt-lsp', 'node_modules', 'basedpyright', 'langserver.index.js')]
    if (appData) c.push(join(appData, 'npm', 'node_modules', 'basedpyright', 'langserver.index.js'), join(appData, 'npm', 'node_modules', 'pyright', 'langserver.index.js'))
    for (const p of ['/usr/local', '/opt/homebrew', join(h, '.npm-global')]) c.push(join(p, 'lib', 'node_modules', 'basedpyright', 'langserver.index.js'), join(p, 'lib', 'node_modules', 'pyright', 'langserver.index.js'))
    return c.find((p) => existsSync(p)) ?? null
  }

  /** Lenh chay server cho (lang, root). Nem loi de hien tren thanh trang thai neu thieu chuong trinh. */
  async function commandFor(lang: Lang, root: string): Promise<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv; detail: string }> {
    if (lang === 'python') {
      const entry = (await setting('pyrightPath', '')) || pyrightEntry()
      if (!entry) throw new Error('Không tìm thấy basedpyright/Pyright. Cài: npm i --prefix "%LOCALAPPDATA%\\orca-qt-lsp" basedpyright')
      const node = (await setting('nodePath', '')) || findNode()
      return { cmd: node, args: [entry, '--stdio'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detail: entry.includes('basedpyright') ? 'basedpyright' : 'pyright' }
    }
    if (lang === 'qml') {
      const qmlls = findQmlls(await setting('qmllsPath', ''), await setting('qtBin', ''))
      if (!qmlls) throw new Error('Không tìm thấy qmlls (Qt 6.4+). Đặt "qmlls path" hoặc "Qt bin folder" trong Settings của plugin.')
      const args: string[] = []
      const builds = findBuildDirs(root, 'qml')
      for (const b of builds.slice(0, 1)) args.push('-b', b)
      // Thu muc module QML cua Qt di kem qmlls (khi qmlls nam ngoai bin cua kit)
      const qmlDir = join(dirname(dirname(qmlls)), 'qml')
      if (existsSync(qmlDir)) args.push('-I', qmlDir)
      return { cmd: qmlls, args, detail: builds[0] ? `build: ${builds[0].slice(root.length + 1) || '.'}` : 'chưa có thư mục build (chạy CMake configure để qmlls thấy module của dự án)' }
    }
    const clangd = findClangd(await setting('clangdPath', ''))
    if (!clangd) throw new Error('Không tìm thấy clangd. Cài LLVM hoặc Qt Creator, hoặc đặt "clangd path" trong Settings.')
    const args = ['--background-index', '--clang-tidy=false', '--header-insertion=never', '--completion-style=detailed', '--log=error', '--pch-storage=memory']
    const cc = findBuildDirs(root, 'compile_commands')
    if (cc[0]) args.push(`--compile-commands-dir=${cc[0]}`)
    // Cho clangd hoi compiler trong compile_commands (MinGW g++ cua Qt...) de lay include he thong dung.
    args.push('--query-driver=**/*g++*,**/*gcc*,**/*c++*,**/*cc.exe,**/*clang++*,**/*clang*,**/cl.exe')
    return { cmd: clangd, args, detail: cc[0] ? `compile_commands: ${cc[0].slice(root.length + 1) || '.'}` : 'chưa có compile_commands.json (CMake configure với CMAKE_EXPORT_COMPILE_COMMANDS=ON)' }
  }

  // ---------- Server ----------
  async function serverFor(lang: Lang, root: string, file?: string): Promise<Server> {
    const existing = servers.get(key(lang, root))
    if (existing && !existing.client.exited) return existing
    const { cmd, args, env, detail } = await commandFor(lang, root)
    orca.log(`spawn ${lang}: ${cmd} ${args.join(' ')} (root ${root})`)
    const client = new LspClient(cmd, args, lang === 'python' ? PLUGIN_DIR : root, env)
    client.log = (l) => orca.log(`[${lang}] ${l}`)
    const srv: Server = { lang, root, client, ready: Promise.resolve(), open: new Map(), diagnostics: new Map(), legend: null, interpreter: null, detail }
    client.onExit = (code) => { orca.log(`${lang} server exited (${code}) for ${root}`); if (servers.get(key(lang, root)) === srv) servers.delete(key(lang, root)) }

    if (lang === 'python') {
      srv.interpreter = (await interpretersFor(root, file))[0] ?? null
      orca.log(`interpreter for ${root}: ${srv.interpreter ? `${srv.interpreter.path} [${srv.interpreter.source}]` : 'none'}`)
    }
    client.onRequest('workspace/configuration', (params: { items: { section?: string }[] }) =>
      params.items.map((it) => {
        if (lang !== 'python') return {}
        const py = srv.interpreter?.path
        if (it.section === 'python') return py ? { pythonPath: py, defaultInterpreterPath: py } : {}
        if (it.section === 'python.analysis' || it.section === 'basedpyright.analysis') {
          return { typeCheckingMode: 'standard', diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true, autoImportCompletions: true }
        }
        return {}
      }))
    client.onRequest('window/workDoneProgress/create', () => null)
    client.onRequest('client/registerCapability', () => null)
    client.onRequest('window/showMessageRequest', () => null)
    client.onRequest('workspace/semanticTokens/refresh', () => { orca.panels.post('lsp.refresh', { lang, root }); return null })
    client.onNotification('window/showMessage', (p: { message?: string }) => orca.log(`[${lang}] ${p?.message ?? ''}`))
    client.onNotification('textDocument/publishDiagnostics', (p: { uri: string; version?: number; diagnostics: any[] }) => {
      let path: string
      try { path = fileURLToPath(p.uri) } catch { return }
      const out: DiagnosticsOutput = {
        version: p.version ?? -1,
        items: p.diagnostics.map((d) => ({ range: d.range, severity: d.severity ?? 1, message: d.message, source: d.source ?? SERVER_LABEL[lang], code: typeof d.code === 'object' ? d.code?.value : d.code }))
      }
      srv.diagnostics.set(norm(path), out)
      // Tin post gioi han 256 KiB: chi day toi da 300 loi, cat moi thong bao 500 ky tu
      orca.panels.post('lsp.diagnostics', { path, version: out.version, items: out.items.slice(0, 300).map((d) => ({ ...d, message: String(d.message).slice(0, 500) })) })
    })
    const rootUri = pathToFileURL(root).href
    srv.ready = client.request('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: rootUri, name: root.split(sep).pop() }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          definition: { linkSupport: false },
          declaration: { linkSupport: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] }, contextSupport: true },
          publishDiagnostics: { versionSupport: true },
          semanticTokens: { requests: { full: true, range: false }, tokenTypes: [], tokenModifiers: [], formats: ['relative'], multilineTokenSupport: false, overlappingTokenSupport: false }
        },
        workspace: { configuration: true, workspaceFolders: true, semanticTokens: { refreshSupport: true } }
      },
      initializationOptions: lang === 'cpp' ? { clangdFileStatus: false } : {}
    }, 60000).then((init: any) => {
      const legend = init?.capabilities?.semanticTokensProvider?.legend
      if (legend?.tokenTypes) srv.legend = { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers ?? [] }
      client.notify('initialized', {})
      if (lang === 'python') client.notify('workspace/didChangeConfiguration', { settings: {} })
    })
    servers.set(key(lang, root), srv)
    await srv.ready
    orca.log(`${lang} ready for ${root} (${detail})`)
    return srv
  }

  function serverOf(lang: Lang, path: string): Server | null {
    let best: Server | null = null
    for (const s of servers.values()) {
      if (s.lang !== lang) continue
      if ((norm(path).startsWith(norm(s.root) + sep)) && (!best || s.root.length > best.root.length)) best = s
    }
    return best
  }
  const attachedRoots = new Map<string, string>()
  const uriOf = (path: string) => pathToFileURL(path).href

  /** Goc du an cua file cho ngon ngu `lang`: workspace Orca chua file (dai nhat), roi goc du an ben trong. */
  async function rootForFile(lang: Lang, path: string): Promise<string | null> {
    const hit = attachedRoots.get(`${lang}|${norm(path)}`)
    if (hit) return hit
    const { workspaces } = await orca.host.call('workspace.list', {})
    const p = norm(resolve(path))
    let best: string | null = null
    for (const w of workspaces) {
      if (!isLocal(w)) continue
      const r = resolve(w.path)
      if (p.startsWith(norm(r) + sep) && (!best || r.length > best.length)) best = r
    }
    if (!best) return null
    const root = projectRootFor(lang, path, best)
    attachedRoots.set(`${lang}|${norm(path)}`, root)
    return root
  }
  async function serverForPath(path: string): Promise<Server> {
    const lang = langOfPath(path)
    if (!lang) throw new Error(`Không hỗ trợ loại file ${path}`)
    const r = await rootForFile(lang, path)
    if (!r) throw new Error(`Không tìm thấy workspace chứa ${path}`)
    const srv = await serverFor(lang, r, path)
    if (!srv.open.has(norm(path))) {
      try {
        srv.client.notify('textDocument/didOpen', { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[lang](path), version: 0, text: readFileSync(path, 'utf8') } })
        srv.open.set(norm(path), 0)
      } catch { /* server tu doc tu dia */ }
    }
    return srv
  }

  orca.panels.handle('lsp.attach', async (input: AttachInput): Promise<AttachOutput> => {
    const lang = input.language as Lang
    const focused = await focusedRoot().catch(() => null)
    const { workspaces } = await orca.host.call('workspace.list', {})
    const known = [...servers.values()].map((s) => s.root)
    // Workspace dang focus truoc (tab vua mo thuong thuoc workspace nay), roi workspace da co server, roi cac workspace khac.
    const roots = [focused, ...known, ...workspaces.filter(isLocal).map((w) => resolve(w.path))]
      .filter((r, i, a): r is string => !!r && a.findIndex((x) => x && norm(x) === norm(r)) === i)
    // Editor gui ma bam (file lon vuot gioi han 1 MiB cua kenh plugin); ban cu gui ca text.
    const h = input.hash ?? sha(input.text ?? '')
    // Editor gui so byte UTF-8 (ban LF va ban CRLF): chi bam nhung file tren dia co dung kich thuoc do.
    const sizes = [input.size, input.sizeCrlf].filter((s): s is number => typeof s === 'number').flatMap((s) => [s, s + 3]) // +3: BOM UTF-8
    const sizeSet = new Set(sizes)
    const ok = (p: string) => langOfPath(p) === lang && fileHash(p) === h
    const find = (r: string): string[] => {
      const cached = hashIndex.get(r)
      if (!cached || Date.now() - cached.at >= 300000) {
        // Chua co chi muc: quet va dung ngay khi gap file trung (khong phai doi quet het thu muc lon).
        const hit = scan(r, (full, size) => (sizeSet.size ? sizeSet.has(size) : true) && ok(full))
        if (hit) return [hit]
      }
      const idx = hashIndex.get(r)?.byHash
      if (!idx) return []
      const cands = sizes.length ? sizes.flatMap((s) => idx.get(`size:${s}`) ?? []) : [...idx.values()].flat()
      return [...new Set(cands)].filter(ok)
    }
    let wsRoot: string | null = null
    let hits: string[] = []
    const deadline = Date.now() + 60000
    for (const r of roots) {
      if (Date.now() > deadline) break
      hits = find(r)
      if (hits.length) { wsRoot = r; break }
    }
    // Khong thay trong bang cu (file moi tao/sua): quet lai tat ca, bo cache.
    if (!wsRoot) {
      for (const r of roots) {
        if (Date.now() > deadline) break
        hashIndex.delete(r)
        hits = find(r)
        if (hits.length) { wsRoot = r; break }
      }
    }
    if (!wsRoot) {
      // Workspace dang focus nam tren may khac (SSH / runtime ghep doi): worker chi doc duoc dia cua may nay.
      const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
      const remote = ctx ? workspaces.find((w) => !isLocal(w) && w.name === ctx.displayName) : undefined
      const message = remote
        ? `Workspace "${remote.name}" nằm trên máy khác (${remote.hostId}); plugin chỉ đọc được file trên máy đang chạy Orca này. Mở dự án dưới dạng workspace cục bộ để dùng Ctrl+Click.`
        : 'Không tìm thấy file này trong workspace cục bộ nào của Orca (file mở ngoài workspace, hoặc workspace ở máy khác).'
      return { ok: false, path: null, candidates: 0, workspace: focused, server: null, message }
    }
    // Workspace long nhau: dung workspace Orca dai nhat chua file, roi goc du an theo ngon ngu.
    let ws = wsRoot
    for (const w of workspaces) if (isLocal(w) && norm(hits[0]).startsWith(norm(resolve(w.path)) + sep) && resolve(w.path).length > ws.length) ws = resolve(w.path)
    const root = projectRootFor(lang, hits[0], ws)
    try {
      const srv = await serverFor(lang, root, hits[0])
      for (const p of hits) attachedRoots.set(`${lang}|${norm(p)}`, root)
      return { ok: true, path: hits[0], candidates: hits.length, workspace: root, server: `${SERVER_LABEL[lang]}${srv.detail ? ` (${srv.detail})` : ''}` }
    } catch (e) {
      return { ok: false, path: hits[0], candidates: hits.length, workspace: root, server: null, message: e instanceof Error ? e.message : String(e) }
    }
  })

  // Ban sao noi dung tung file dang mo trong worker: editor chi gui phan thay doi (kenh plugin gioi han ~1 MiB/tin).
  const docs = new Map<string, string>()
  const sendFull = (srv: Server, path: string, text: string, version: number) => {
    if (srv.open.has(norm(path))) srv.client.notify('textDocument/didChange', { textDocument: { uri: uriOf(path), version }, contentChanges: [{ text }] })
    else srv.client.notify('textDocument/didOpen', { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[srv.lang](path), version, text } })
    srv.open.set(norm(path), version)
    docs.set(norm(path), text)
  }
  /** lsp.open: `text` (file nho) hoac khong co text -> doc tu dia (file lon, noi dung editor = dia luc mo). */
  orca.panels.handle('lsp.open', async ({ path, text, version }: DocInput) => {
    const srv = await serverForPath(path)
    sendFull(srv, path, text ?? readFileSync(path, 'utf8'), version)
    return { ok: true }
  })
  /** lsp.change: `edits` (offset trong noi dung cu, UTF-16) ap len ban sao; `text` = ca noi dung (ban cu / file nho). */
  orca.panels.handle('lsp.change', async ({ path, text, version, edits, expectLength }: DocInput) => {
    const srv = await serverForPath(path)
    let next = text
    if (next === undefined && edits) {
      const base = docs.get(norm(path))
      // Chua co ban sao (worker vua khoi dong lai): khong doan noi dung, bao editor gui lai ca file
      if (base === undefined) return { ok: false, resync: true }
      let cur = base
      // Monaco: cac change trong mot su kien tinh offset tren noi dung truoc su kien; ap tu cuoi len dau
      for (const e of [...edits].sort((a, b) => b.offset - a.offset)) cur = cur.slice(0, e.offset) + e.text + cur.slice(e.offset + e.length)
      next = cur
    }
    if (next === undefined) return { ok: false, resync: true }
    // Lech do dai = ban sao worker sai -> editor gui lai ca file (theo tung doan)
    if (edits && typeof expectLength === 'number' && next.length !== expectLength) return { ok: false, resync: true }
    sendFull(srv, path, next, version)
    return { ok: true }
  })

  /** Gui ca noi dung theo tung doan (file lon): begin -> part... -> commit. Moi doan < 512 KB. */
  const uploads = new Map<string, string[]>()
  orca.panels.handle('lsp.upload', async ({ path, version, part, index, total }: { path: string; version: number; part: string; index: number; total: number }) => {
    const k = norm(path)
    if (index === 0) uploads.set(k, [])
    const parts = uploads.get(k)
    if (!parts) return { ok: false }
    parts[index] = part
    if (index < total - 1) return { ok: true, pending: true }
    uploads.delete(k)
    sendFull(await serverForPath(path), path, parts.join(''), version)
    return { ok: true }
  })

  orca.panels.handle('lsp.close', async ({ path }: { path: string }) => {
    const lang = langOfPath(path)
    const srv = lang ? serverOf(lang, path) : null
    if (srv?.open.delete(norm(path))) srv.client.notify('textDocument/didClose', { textDocument: { uri: uriOf(path) } })
    if (srv && srv.open.size === 0) setTimeout(() => { if (srv.open.size === 0 && servers.get(key(srv.lang, srv.root)) === srv) stopServer(srv) }, 60000)
    return { ok: true }
  })

  function stopServer(srv: Server) {
    servers.delete(key(srv.lang, srv.root))
    hashIndex.delete(srv.root)
    void srv.client.request('shutdown', null, 3000).catch(() => {}).finally(() => { srv.client.notify('exit', null); setTimeout(() => srv.client.kill(), 500) })
  }
  orca.events.on('workspace.removed', ({ path }) => {
    for (const s of [...servers.values()]) if (norm(s.root) === norm(path) || norm(s.root).startsWith(norm(path) + sep)) stopServer(s)
  })

  const LIB_RE = /[\\/](site-packages|\.venv|venv|env|node_modules|typeshed-fallback|include|Qt[\\/]\d|mingw\d*_64|qml[\\/]Qt|QtQuick)[\\/]/i
  const isLibPath = (p: string, root: string) => !norm(p).startsWith(norm(root) + sep) || LIB_RE.test(p.slice(root.length)) || /[\\/](build|out|cmake-build-[^\\/]*)[\\/]/i.test(p.slice(root.length))

  orca.panels.handle('lsp.hover', async ({ path, position }: PosInput): Promise<HoverOutput> => {
    const srv = await serverForPath(path)
    const r: any = await srv.client.request('textDocument/hover', { textDocument: { uri: uriOf(path) }, position })
    if (!r) return { markdown: null, range: null }
    const c = r.contents
    const md = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x === 'string' ? x : '```' + (x.language ?? '') + '\n' + x.value + '\n```')).join('\n\n') : c?.kind === 'plaintext' ? '```\n' + c.value + '\n```' : c?.value ?? null
    return JSON.parse(JSON.stringify({ markdown: md ?? null, range: r.range ?? null }))
  })

  orca.panels.handle('lsp.definition', async ({ path, position }: PosInput): Promise<DefinitionOutput> => {
    const srv = await serverForPath(path)
    let r: any = await srv.client.request('textDocument/definition', { textDocument: { uri: uriOf(path) }, position })
    // clangd: tren khai bao (header) definition tro ve chinh no -> thu declaration de nhay qua lai .h/.cpp
    if ((!r || (Array.isArray(r) && !r.length)) && srv.lang === 'cpp') r = await srv.client.request('textDocument/declaration', { textDocument: { uri: uriOf(path) }, position }).catch(() => null)
    const list = r ? (Array.isArray(r) ? r : [r]) : []
    const locations: Loc[] = []
    for (const l of list) {
      const u = l.uri ?? l.targetUri
      let p: string
      try { p = fileURLToPath(u) } catch { continue }
      locations.push({ path: p, range: l.targetSelectionRange ?? l.range ?? l.targetRange, inWorkspace: !isLibPath(p, srv.root) })
    }
    return JSON.parse(JSON.stringify({ locations }))
  })

  orca.panels.handle('lsp.completion', async ({ path, position, trigger }: PosInput & { trigger?: string }): Promise<CompletionOutput> => {
    const srv = await serverForPath(path)
    const context = trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 }
    const r: any = await srv.client.request('textDocument/completion', { textDocument: { uri: uriOf(path) }, position, context })
    const items = (Array.isArray(r) ? r : r?.items ?? []).slice(0, 300).map((it: any) => {
      const doc = typeof it.documentation === 'string' ? it.documentation : it.documentation?.value
      const out: Record<string, unknown> = { label: String(it.label).trim(), kind: it.kind ?? 1 }
      if (it.detail) out.detail = String(it.detail)
      if (doc) out.documentation = String(doc).slice(0, 1500)
      const insert = it.textEdit?.newText ?? it.insertText
      if (insert) out.insertText = String(insert)
      if (it.textEdit?.range ?? it.textEdit?.replace) out.range = it.textEdit.range ?? it.textEdit.replace
      if (it.sortText) out.sortText = String(it.sortText)
      if (it.filterText) out.filterText = String(it.filterText)
      return out
    })
    return JSON.parse(JSON.stringify({ items, incomplete: Array.isArray(r) ? false : !!r?.isIncomplete }))
  })

  orca.panels.handle('lsp.diagnostics', async ({ path }: { path: string }) => {
    const lang = langOfPath(path)
    const srv = lang ? serverOf(lang, path) : null
    const d = srv?.diagnostics.get(norm(path))
    return d ? { version: d.version, items: d.items.slice(0, 2000).map((x) => ({ ...x, message: String(x.message).slice(0, 500) })) } : { version: -1, items: [] }
  })

  orca.panels.handle('lsp.serverInfo', async ({ path }: { path: string }) => {
    const srv = await serverForPath(path)
    return { lang: srv.lang, server: SERVER_LABEL[srv.lang], root: srv.root, detail: srv.detail }
  })

  /** Khoi dong lai server cua file (vd sau khi CMake configure tao compile_commands.json / build dir). */
  orca.panels.handle('lsp.restart', async ({ path }: { path: string }) => {
    const lang = langOfPath(path)
    const srv = lang ? serverOf(lang, path) : null
    if (srv) stopServer(srv)
    const fresh = await serverForPath(path)
    return { detail: fresh.detail }
  })

  orca.panels.handle('lsp.interpreters', async ({ path }: { path: string }) => {
    const srv = await serverForPath(path)
    if (srv.lang !== 'python') return { root: srv.root, current: null, list: [] }
    const list = await interpretersFor(srv.root, path)
    return JSON.parse(JSON.stringify({ root: srv.root, current: srv.interpreter, list }))
  })

  orca.panels.handle('lsp.setInterpreter', async ({ path, interpreter }: { path: string; interpreter: string | null }) => {
    const srv = await serverForPath(path)
    if (srv.lang !== 'python') return { current: null }
    const saved = await savedInterpreters()
    if (interpreter) saved[norm(srv.root)] = interpreter
    else delete saved[norm(srv.root)]
    await orca.storage.set(SAVED_KEY, saved)
    srv.interpreter = (await interpretersFor(srv.root, path))[0] ?? null
    srv.client.notify('workspace/didChangeConfiguration', { settings: {} })
    orca.log(`interpreter for ${srv.root} -> ${srv.interpreter?.path ?? 'none'} [${srv.interpreter?.source ?? '-'}]`)
    return JSON.parse(JSON.stringify({ current: srv.interpreter }))
  })

  orca.panels.handle('lsp.semanticTokens', async ({ path }: { path: string }) => {
    const srv = await serverForPath(path)
    if (!srv.legend) return { legend: null, data: [] }
    const r: any = await srv.client.request('textDocument/semanticTokens/full', { textDocument: { uri: uriOf(path) } }, 20000).catch(() => null)
    const data: number[] = Array.isArray(r?.data) ? r.data : []
    // Gioi han tin ~1 MiB: ~30k token (150k so, moi so <= 7 ky tu JSON) la du cho file nguon thuong; file sinh tu dong (resources_rc.py) bo qua phan sau.
    return { legend: srv.legend, data: data.length > 150_000 ? data.slice(0, 150_000) : data }
  })

  /** Noi dung file dich (chi doc) cho peek / dieu huong. Chi file nguon/stub/header. */
  orca.panels.handle('lsp.peek', async ({ path }: { path: string }) => {
    if (!langOfPath(path) && !/(^|[\\/])[A-Z][A-Za-z0-9]*$/.test(path)) return { text: '', lang: null }
    const lang = langOfPath(path) ?? 'cpp'
    // < 1 MiB sau khi ma hoa JSON (ky tu thuong ~1 byte, tieng Viet/ky tu dac biet co the 2-6): 300k ky tu cho an toan
    try { return { text: readFileSync(path, 'utf8').slice(0, 300_000), lang } } catch { return { text: '', lang } }
  })

  /** Mo dinh nghia trong tab Orca (file trong workspace); ngoai workspace thi editor hien peek. */
  orca.panels.handle('lsp.reveal', async ({ path, line }: { path: string; line: number }) => {
    const { workspaces } = await orca.host.call('workspace.list', {})
    const p = norm(resolve(path))
    let ws: (typeof workspaces)[number] | null = null
    for (const w of workspaces) if (isLocal(w) && p.startsWith(norm(resolve(w.path)) + sep) && (!ws || w.path.length > ws.path.length)) ws = w
    if (!ws) return { opened: false, reason: 'outside' }
    const rel = resolve(path).slice(resolve(ws.path).length + 1).split(sep).join('/')
    await orca.host.call('editor.open', { workspaceId: ws.id, path: rel })
    return { opened: true, line, rel }
  })
}

export function deactivate(): void { /* cac tien trinh con tu thoat khi worker dung */ }
