// Shared Qt LSP core: runs language servers for Python (basedpyright), QML (qmlls) and C/C++ (clangd),
// resolves the path of the open file (the editor does not know it) and forwards editor requests to the server.
// One server per (language, project root). Runs in the Orca worker (local files) and in the remote
// agent over SSH (files on the other machine) - everything Orca-specific lives in CoreEnv.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LspClient } from './lsp-client'
import { installPyright } from './pyright-install'
import { discoverInterpreters, type Interpreter } from './interpreters'
import { EXTS_OF_LANG, LANGUAGE_ID, SERVER_LABEL, findBuildDirs, findClangd, findQmlls, projectRootFor, type Lang } from './servers'
import type {
  AttachInput, AttachOutput, CompletionOutput, DefinitionOutput, DiagnosticsOutput, DocInput, HoverOutput, Loc, PosInput,
  ReferencesOutput, SignatureHelpOutput, DocumentSymbolsOutput, DocumentSymbol, DocumentHighlightsOutput, PrepareRenameOutput, RenameOutput, SourceEdit
} from './protocol'
import { jsonBytes, messageBytes, limitItems, POST_BUDGET, RESPONSE_BUDGET } from './transport'
import { DOCUMENT_READ_METHODS } from './protocol'

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'env', 'dist', '.orca', '.mypy_cache', '.pytest_cache', 'site-packages', '.cache', '.qtc_clangd',
  // workspace is the home folder (e.g. /Users/<name>): skip large system/media folders
  'Library', 'Applications', 'AppData', 'Movies', 'Music', 'Pictures', 'Downloads', '$Recycle.Bin'])
const sha = (s: string) => createHash('sha1').update(s.replace(/\r\n/g, '\n')).digest('hex')
const WIN = process.platform === 'win32'

/** Folder containing the program (plugin: <plugin>/worker/worker.mjs; agent: ~/.orca-qt-lsp/agent-*.mjs). */
const pluginDir = () => process.env.QT_LSP_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Server {
  lang: Lang
  root: string
  client: LspClient
  ready: Promise<void>
  open: Map<string, number>
  diagnostics: Map<string, DiagnosticsOutput>
  legend: { tokenTypes: string[]; tokenModifiers: string[] } | null
  /** Python: interpreter in use */
  interpreter: Interpreter | null
  /** Display info (build dir used by clangd/qmlls...) */
  detail: string
  capabilities: Record<string, any>
}



const norm = (p: string) => (WIN ? p.toLowerCase() : p)
const key = (lang: Lang, root: string) => `${lang}|${norm(root)}`
const langOfPath = (p: string): Lang | null => (EXTS_OF_LANG.python.test(p) ? 'python' : EXTS_OF_LANG.qml.test(p) ? 'qml' : EXTS_OF_LANG.cpp.test(p) ? 'cpp' : null)

export type Handler = (input: any) => Promise<any>
export interface CoreEnv {
  log(message: string): void
  post(event: string, payload: unknown): void
  setting<T>(key: string, fallback: T): Promise<T>
  storageGet(key: string): Promise<unknown>
  storageSet(key: string, value: unknown): Promise<void>
  /** Workspace root folders on this machine, the focused workspace (if known) first. */
  roots(hints?: string[]): Promise<{ focused: string | null; roots: string[] }>
  /** Open a file in an Orca tab; when absent (agent) the editor handles it. */
  reveal?(path: string, line: number): Promise<{ opened: boolean; rel?: string; reason?: string }>
  /** Remote agent: install basedpyright if that machine lacks it; returns langserver.index.js. */
  installPyright?(): Promise<string | null>
}
export interface Core {
  handlers: Record<string, Handler>
  workspaceRemoved(path: string): void
  shutdown(): void
}

export function createCore(host: CoreEnv): Core {
  const handlers: Record<string, Handler> = {}
  // Orca rejects undefined object properties even though JSON.stringify omits them.
  // Keep the shared RPC boundary identical for in-process tests and the SSH agent.
  const handle = (name: string, fn: Handler) => { handlers[name] = async (input) => {
    if (DOCUMENT_READ_METHODS.has(name) && Number.isInteger(input?.version)) {
      const lang = langOfPath(input.path)
      const server = lang ? serverOf(lang, input.path) : null
      // Orca can reap an idle worker while its editor frame remains open. Do not
      // answer against disk content at coordinates belonging to an unsaved draft.
      if (!docs.has(norm(input.path)) || server?.open.get(norm(input.path)) !== input.version) return { resync: true }
    }
    return JSON.parse(JSON.stringify((await fn(input)) ?? null))
  } }
  const servers = new Map<string, Server>()
  const starting = new Map<string, Promise<Server>>()
  const hashIndex = new Map<string, { at: number; byHash: Map<string, string[]> }>()

  async function setting<T>(k: string, fallback: T): Promise<T> {
    try { const v = await host.setting<T | null>(k, null); return (v === undefined || v === null || (v as unknown) === '' ? fallback : v) as T } catch { return fallback }
  }


  /** Cheap index by file size (contents not read): "size:<bytes>" -> paths.
   *  Hashing every file of a large project (10k folders, 8.7k source files, 127 MB) takes ~11 s per workspace
   *  and exceeds the file limit, so only files with the same size as the open file are hashed (usually 1-3).
   *  Generated build folders are skipped while scanning. */
  const MAX_FILES = 200000
  const skipDir = (n: string) => SKIP.has(n) || n.startsWith('.') || /^(build|out|cmake-build-)/i.test(n)
  /** Breadth-first scan (shallow folders first): the workspace may be the whole home folder.
   *  `match` is called for each file; returning true stops early (the index is not saved since it is incomplete). */
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
  /** Index by file size (stat only, contents not read): "size:<bytes>" -> paths. */
  function indexFor(root: string): Map<string, string[]> {
    scan(root)
    return hashIndex.get(root)?.byHash ?? new Map()
  }
  /** Content hash, cached by (path, mtime, size). */
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
    try { const v = await host.storageGet(SAVED_KEY); return v && typeof v === 'object' ? (v as Record<string, string>) : {} } catch { return {} }
  }
  async function interpretersFor(root: string, file?: string): Promise<Interpreter[]> {
    const saved = (await savedInterpreters())[norm(root)]
    const projectEnvs = String(await setting('projectEnvironments', 'on')).trim().toLowerCase() !== 'off'
    return discoverInterpreters(file ?? join(root, '__init__.py'), root, { saved, setting: await setting('python', ''), projectEnvs })
  }

  // ---------- Locate programs ----------
  function findNode(): string {
    const exe = WIN ? 'node.exe' : 'node'
    for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(WIN ? ';' : ':')) if (dir && existsSync(join(dir, exe))) return join(dir, exe)
    for (const c of WIN ? ['C:\\Program Files\\nodejs\\node.exe'] : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']) if (existsSync(c)) return c
    return process.execPath
  }
  /** Where basedpyright is auto-installed on this machine: %LOCALAPPDATA%orca-qt-lsp (Windows), ~/.local/share/orca-qt-lsp (macOS/Linux). */
  function pyrightPrefix(): string {
    const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
    return join(process.env.LOCALAPPDATA ?? (WIN ? join(h, 'AppData', 'Local') : join(h, '.local', 'share')), 'orca-qt-lsp')
  }
  function pyrightEntry(): string | null {
    const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
    const local = process.env.LOCALAPPDATA ?? (WIN ? join(h, 'AppData', 'Local') : join(h, '.local', 'share'))
    const appData = process.env.APPDATA ?? (WIN ? join(h, 'AppData', 'Roaming') : undefined)
    const c = [join(pluginDir(), 'server', 'pyright', 'langserver.index.js'), join(local, 'orca-qt-lsp', 'node_modules', 'basedpyright', 'langserver.index.js')]
    if (appData) c.push(join(appData, 'npm', 'node_modules', 'basedpyright', 'langserver.index.js'), join(appData, 'npm', 'node_modules', 'pyright', 'langserver.index.js'))
    for (const p of ['/usr/local', '/opt/homebrew', join(h, '.npm-global')]) c.push(join(p, 'lib', 'node_modules', 'basedpyright', 'langserver.index.js'), join(p, 'lib', 'node_modules', 'pyright', 'langserver.index.js'))
    return c.find((p) => existsSync(p)) ?? null
  }

  /** Command that runs the server for (lang, root). Throws (shown in the status bar) when the program is missing. */
  async function commandFor(lang: Lang, root: string): Promise<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv; detail: string }> {
    if (lang === 'python') {
      const entry = (await setting('pyrightPath', '')) || pyrightEntry() || await (host.installPyright ? host.installPyright() : installPyright(pyrightPrefix(), findNode(), host.log))
      if (!entry) throw new Error(`basedpyright/Pyright not found on this ${process.platform} machine. Install it (needs Node.js 18+ with npm): npm i --prefix ${WIN ? '"%LOCALAPPDATA%\\orca-qt-lsp"' : '~/.local/share/orca-qt-lsp'} basedpyright@1.40.2`)
      const node = (await setting('nodePath', '')) || findNode()
      return { cmd: node, args: [entry, '--stdio'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detail: entry.includes('basedpyright') ? 'basedpyright' : 'pyright' }
    }
    if (lang === 'qml') {
      const qmlls = findQmlls(await setting('qmllsPath', ''), await setting('qtBin', ''))
      if (!qmlls) throw new Error('qmlls (Qt 6.4+) not found. Set "qmlls path" or "Qt bin folder" in the plugin Settings.')
      const args: string[] = []
      const builds = findBuildDirs(root, 'qml')
      for (const b of builds.slice(0, 1)) args.push('-b', b)
      // Qt's QML module folder next to qmlls (when qmlls lives outside the kit's bin)
      const qmlDir = join(dirname(dirname(qmlls)), 'qml')
      if (existsSync(qmlDir)) args.push('-I', qmlDir)
      return { cmd: qmlls, args, detail: builds[0] ? `build: ${builds[0].slice(root.length + 1) || '.'}` : 'no build folder yet (run CMake configure so qmlls can see the project modules)' }
    }
    const clangd = findClangd(await setting('clangdPath', ''))
    if (!clangd) throw new Error('clangd not found. Install LLVM or Qt Creator, or set "clangd path" in Settings.')
    const args = ['--background-index', '--clang-tidy=false', '--header-insertion=never', '--completion-style=detailed', '--log=error', '--pch-storage=memory']
    const cc = findBuildDirs(root, 'compile_commands')
    if (cc[0]) args.push(`--compile-commands-dir=${cc[0]}`)
    // clangd runs the compiler named in compile_commands.json to read its system include paths. Allow only
    // compilers from toolchain install folders, never one inside the opened project (a cloned repo could
    // point compile_commands.json at its own "compiler").
    const drivers = WIN
      ? ['C:/Qt/Tools/**/bin/*.exe', 'C:/Program Files/LLVM/bin/*.exe', 'C:/Program Files/Microsoft Visual Studio/**/bin/**/cl.exe',
          'C:/Program Files (x86)/Microsoft Visual Studio/**/bin/**/cl.exe', 'C:/msys64/*/bin/*.exe', 'C:/mingw*/bin/*.exe']
      : ['/usr/bin/*', '/usr/local/bin/*', '/opt/homebrew/bin/*', '/opt/homebrew/opt/llvm/bin/*', '/Library/Developer/CommandLineTools/usr/bin/*',
          '/Applications/Xcode*.app/Contents/Developer/Toolchains/**/bin/*', `${homedir()}/Qt/Tools/**/bin/*`]
    const extra = String(await setting('compilerGlobs', '')).split(/[;,\n]/).map((x) => x.trim()).filter(Boolean)
    args.push(`--query-driver=${[...drivers, ...extra].join(',')}`)
    return { cmd: clangd, args, detail: cc[0] ? `compile_commands: ${cc[0].slice(root.length + 1) || '.'}` : 'no compile_commands.json yet (run CMake configure with CMAKE_EXPORT_COMPILE_COMMANDS=ON)' }
  }

  // ---------- Server ----------
  async function serverFor(lang: Lang, root: string, file?: string): Promise<Server> {
    const existing = servers.get(key(lang, root))
    if (existing && !existing.client.exited) { await existing.ready; return existing }
    const id = key(lang, root)
    const pending = starting.get(id)
    if (pending) return pending
    const startup = startServer(lang, root, file)
    starting.set(id, startup)
    try { return await startup } finally { if (starting.get(id) === startup) starting.delete(id) }
  }
  async function startServer(lang: Lang, root: string, file?: string): Promise<Server> {
    const { cmd, args, env, detail } = await commandFor(lang, root)
    host.log(`spawn ${lang}: ${cmd} ${args.join(' ')} (root ${root})`)
    const client = new LspClient(cmd, args, lang === 'python' ? pluginDir() : root, env)
    client.log = (l) => host.log(`[${lang}] ${l}`)
    const srv: Server = { lang, root, client, ready: Promise.resolve(), open: new Map(), diagnostics: new Map(), legend: null, interpreter: null, detail, capabilities: {} }
    client.onExit = (code) => { host.log(`${lang} server exited (${code}) for ${root}`); if (servers.get(key(lang, root)) === srv) servers.delete(key(lang, root)) }

    const typeMode = String(await setting('typeCheckingMode', 'off')).trim() || 'off'
    if (lang === 'python') {
      srv.interpreter = (await interpretersFor(root, file))[0] ?? null
      host.log(`interpreter for ${root}: ${srv.interpreter ? `${srv.interpreter.path} [${srv.interpreter.source}]` : 'none'}`)
    }
    client.onRequest('workspace/configuration', (params: { items: { section?: string }[] }) =>
      params.items.map((it) => {
        if (lang !== 'python') return {}
        const py = srv.interpreter?.path
        // basedpyright 1.40 requests the root section and reads `.analysis` itself.
        // Returning only `basedpyright.analysis` silently leaves its default at
        // "recommended", producing Unknown/unused/type errors even with off set.
        const analysis = { typeCheckingMode: typeMode, diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true, autoImportCompletions: true,
          // Large Qt/Python repositories often keep packaged apps and additional
          // checkouts here. Explicit imports still resolve; avoid enumerating them
          // for workspace indexing before an interactive request can be answered.
          exclude: ['**/node_modules/**', '**/__pycache__/**', '**/.git/**', '**/.worktrees/**', '**/.venv/**', '**/venv/**', '**/build/**', '**/dist/**', '**/out/**'],
          ...(typeMode === 'off' ? { diagnosticSeverityOverrides: { reportMissingImports: 'error' } } : {}) }
        if (it.section === 'python') return { ...(py ? { pythonPath: py, defaultInterpreterPath: py } : {}), analysis }
        if (it.section === 'basedpyright' || it.section === 'pyright') return { analysis }
        if (it.section === 'python.analysis' || it.section === 'basedpyright.analysis') return analysis
        return {}
      }))
    client.onRequest('window/workDoneProgress/create', () => null)
    client.onRequest('client/registerCapability', () => null)
    client.onRequest('window/showMessageRequest', () => null)
    client.onRequest('workspace/semanticTokens/refresh', () => { host.post('lsp.refresh', { lang, root }); return null })
    client.onNotification('window/showMessage', (p: { message?: string }) => host.log(`[${lang}] ${p?.message ?? ''}`))
    client.onNotification('textDocument/publishDiagnostics', (p: { uri: string; version?: number; diagnostics: any[] }) => {
      let path: string
      try { path = fileURLToPath(p.uri) } catch { return }
      const out: DiagnosticsOutput = {
        version: p.version ?? -1,
        items: p.diagnostics.filter((d) => {
          const code = typeof d.code === 'object' ? d.code?.value : d.code
          // "off" is the quiet editor mode: syntax + missing imports. Also hide
          // server hint diagnostics and project-config overrides in this mode.
          return lang !== 'python' || typeMode !== 'off' || code == null || code === 'reportMissingImports'
        }).map((d) => ({ range: d.range, severity: d.severity ?? 1, message: d.message, source: d.source ?? SERVER_LABEL[lang], code: typeof d.code === 'object' ? d.code?.value : d.code }))
      }
      srv.diagnostics.set(norm(path), out)
      // Posted messages are limited to 256 KiB: push at most 300 diagnostics, each message cut to 500 chars
      const envelope = (items: DiagnosticsOutput['items']) => ({ path, version: out.version, items })
      host.post('lsp.diagnostics', JSON.parse(JSON.stringify(envelope(limitItems(out.items.slice(0, 300).map((d) => ({ ...d, message: String(d.message).slice(0, 500) })), envelope, POST_BUDGET)))))
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
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] }, contextSupport: true },
          references: {},
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          documentHighlight: {},
          rename: { prepareSupport: true },
          publishDiagnostics: { versionSupport: true },
          semanticTokens: { requests: { full: true, range: false }, tokenTypes: [], tokenModifiers: [], formats: ['relative'], multilineTokenSupport: false, overlappingTokenSupport: false }
        },
        workspace: { configuration: true, workspaceFolders: true, semanticTokens: { refreshSupport: true } }
      },
      initializationOptions: lang === 'cpp' ? { clangdFileStatus: false } : {}
    }, 60000).then((init: any) => {
      srv.capabilities = init?.capabilities ?? {}
      const legend = init?.capabilities?.semanticTokensProvider?.legend
      if (legend?.tokenTypes) srv.legend = { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers ?? [] }
      client.notify('initialized', {})
      if (lang === 'python') client.notify('workspace/didChangeConfiguration', { settings: {} })
    })
    servers.set(key(lang, root), srv)
    try { await srv.ready } catch (e) {
      if (servers.get(key(lang, root)) === srv) servers.delete(key(lang, root))
      srv.client.kill()
      throw e
    }
    host.log(`${lang} ready for ${root} (${detail})`)
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

  /** Project root of a file for `lang`: the (longest) Orca workspace containing it, then the project root inside it. */
  async function rootForFile(lang: Lang, path: string): Promise<string | null> {
    const hit = attachedRoots.get(`${lang}|${norm(path)}`)
    if (hit) return hit
    const { roots } = await host.roots()
    const p = norm(resolve(path))
    let best: string | null = null
    for (const w of [...roots, ...[...servers.values()].map((s) => s.root)]) {
      const r = resolve(w)
      if (p.startsWith(norm(r) + sep) && (!best || r.length > best.length)) best = r
    }
    if (!best) return null
    const root = projectRootFor(lang, path, best)
    attachedRoots.set(`${lang}|${norm(path)}`, root)
    return root
  }
  async function serverForPath(path: string): Promise<Server> {
    const lang = langOfPath(path)
    if (!lang) throw new Error(`Unsupported file type: ${path}`)
    const r = await rootForFile(lang, path)
    if (!r) throw new Error(`No workspace contains ${path}`)
    const srv = await serverFor(lang, r, path)
    if (!srv.open.has(norm(path))) {
      try {
        srv.client.notify('textDocument/didOpen', { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[lang](path), version: 0, text: readFileSync(path, 'utf8') } })
        srv.open.set(norm(path), 0)
      } catch { /* the server reads it from disk */ }
    }
    return srv
  }

  handle('lsp.attach', async (input: AttachInput): Promise<AttachOutput> => {
    const lang = input.language as Lang
    const listed = await host.roots(input.hints).catch(() => ({ focused: null, roots: [] as string[] }))
    const focused = listed.focused
    const known = [...servers.values()].map((s) => s.root)
    // Focused workspace first (a newly opened tab usually belongs to it), then workspaces with a server, then the rest.
    const roots = [focused, ...known, ...listed.roots.map((w) => resolve(w))]
      .filter((r, i, a): r is string => !!r && a.findIndex((x) => x && norm(x) === norm(r)) === i)
    // The editor sends a hash (large files exceed the plugin channel's 1 MiB limit); older versions send the full text.
    const h = input.hash ?? sha(input.text ?? '')
    // The editor sends the UTF-8 byte size (LF and CRLF variants): only hash files on disk with exactly that size.
    const sizes = [input.size, input.sizeCrlf].filter((s): s is number => typeof s === 'number').flatMap((s) => [s, s + 3]) // +3: BOM UTF-8
    const sizeSet = new Set(sizes)
    const ok = (p: string) => langOfPath(p) === lang && fileHash(p) === h
    const find = (r: string): string[] => {
      const cached = hashIndex.get(r)
      if (!cached || Date.now() - cached.at >= 300000) {
        // No index yet: scan and stop at the first match (no need to wait for a full scan of a large folder).
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
    // Not in the old index (file just created/edited): drop the cache and rescan everything.
    if (!wsRoot) {
      for (const r of roots) {
        if (Date.now() > deadline) break
        hashIndex.delete(r)
        hits = find(r)
        if (hits.length) { wsRoot = r; break }
      }
    }
    if (!wsRoot) {
      const scanned = roots.map((r) => `${r} (${[...(hashIndex.get(r)?.byHash.values() ?? [])].reduce((n, l) => n + l.length, 0)} file)`)
      host.log(`attach miss: lang=${lang} size=${input.size} roots=${scanned.join(' | ')}`)
      return { ok: false, path: null, candidates: 0, workspace: focused, server: null, message: `File not found (${roots.length} workspaces scanned).` }
    }
    // Nested workspaces: use the longest Orca workspace containing the file, then the language's project root.
    let ws = wsRoot
    for (const w of listed.roots) if (norm(hits[0]).startsWith(norm(resolve(w)) + sep) && resolve(w).length > ws.length) ws = resolve(w)
    const root = projectRootFor(lang, hits[0], ws)
    try {
      const srv = await serverFor(lang, root, hits[0])
      for (const p of hits) attachedRoots.set(`${lang}|${norm(p)}`, root)
      return { ok: true, path: hits[0], candidates: hits.length, workspace: root, server: `${SERVER_LABEL[lang]}${srv.detail ? ` (${srv.detail})` : ''}` }
    } catch (e) {
      return { ok: false, path: hits[0], candidates: hits.length, workspace: root, server: null, message: e instanceof Error ? e.message : String(e) }
    }
  })

  // Worker-side copy of each open file: frame inputs are limited to 64 KiB.
  const docs = new Map<string, string>()
  const sendFull = (srv: Server, path: string, text: string, version: number) => {
    if (srv.open.has(norm(path))) srv.client.notify('textDocument/didChange', { textDocument: { uri: uriOf(path), version }, contentChanges: [{ text }] })
    else srv.client.notify('textDocument/didOpen', { textDocument: { uri: uriOf(path), languageId: LANGUAGE_ID[srv.lang](path), version, text } })
    srv.open.set(norm(path), version)
    docs.set(norm(path), text)
  }
  /** lsp.open: `text` (small file), or no text -> read from disk (large file; editor content equals disk when opened). */
  handle('lsp.open', async ({ path, text, version }: DocInput) => {
    const srv = await serverForPath(path)
    sendFull(srv, path, text ?? readFileSync(path, 'utf8'), version)
    return { ok: true }
  })
  /** lsp.change: `edits` (offsets into the old content, UTF-16) applied to the copy; `text` = full content (older versions / small files). */
  handle('lsp.change', async ({ path, text, version, edits, expectLength }: DocInput) => {
    const srv = await serverForPath(path)
    let next = text
    if (next === undefined && edits) {
      const base = docs.get(norm(path))
      // No copy yet (worker just restarted): don't guess the content, ask the editor to resend the whole file
      if (base === undefined) return { ok: false, resync: true }
      let cur = base
      // Monaco: changes in one event use offsets into the content before the event; apply from last to first
      for (const e of [...edits].sort((a, b) => b.offset - a.offset)) cur = cur.slice(0, e.offset) + e.text + cur.slice(e.offset + e.length)
      next = cur
    }
    if (next === undefined) return { ok: false, resync: true }
    // Length mismatch = worker copy is wrong -> the editor resends the whole file (in chunks)
    if (edits && typeof expectLength === 'number' && next.length !== expectLength) return { ok: false, resync: true }
    sendFull(srv, path, next, version)
    return { ok: true }
  })

  /** Upload large files through the 64 KiB input lane, committing only the final chunk. */
  const uploads = new Map<string, string[]>()
  handle('lsp.upload', async ({ path, version, part, index, total }: { path: string; version: number; part: string; index: number; total: number }) => {
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

  handle('lsp.close', async ({ path }: { path: string }) => {
    docs.delete(norm(path))
    uploads.delete(norm(path))
    const lang = langOfPath(path)
    const srv = lang ? serverOf(lang, path) : null
    if (srv?.open.delete(norm(path))) srv.client.notify('textDocument/didClose', { textDocument: { uri: uriOf(path) } })
    if (srv && srv.open.size === 0) setTimeout(() => { if (srv.open.size === 0 && servers.get(key(srv.lang, srv.root)) === srv) stopServer(srv) }, 60000)
    return { ok: true }
  })

  function stopServer(srv: Server) {
    starting.delete(key(srv.lang, srv.root))
    servers.delete(key(srv.lang, srv.root))
    hashIndex.delete(srv.root)
    void srv.client.request('shutdown', null, 3000).catch(() => {}).finally(() => { srv.client.notify('exit', null); setTimeout(() => srv.client.kill(), 500) })
  }
  const workspaceRemoved = (path: string) => {
    for (const s of [...servers.values()]) if (norm(s.root) === norm(path) || norm(s.root).startsWith(norm(path) + sep)) stopServer(s)
  }

  const LIB_RE = /[\\/](site-packages|\.venv|venv|env|node_modules|typeshed-fallback|include|Qt[\\/]\d|mingw\d*_64|qml[\\/]Qt|QtQuick)[\\/]/i
  const isLibPath = (p: string, root: string) => !norm(p).startsWith(norm(root) + sep) || LIB_RE.test(p.slice(root.length)) || /[\\/](build|out|cmake-build-[^\\/]*)[\\/]/i.test(p.slice(root.length))

  const interactiveRequests = new Map<string, AbortController>()
  async function interactive<T>(input: PosInput, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const id = input.requestId ? `${norm(input.path)}|${input.requestId}` : null
    if (id) interactiveRequests.set(id, controller)
    try { return await run(controller.signal) }
    finally { if (id && interactiveRequests.get(id) === controller) interactiveRequests.delete(id) }
  }
  handle('lsp.cancel', async ({ path, requestId }: { path: string; requestId: string }) => {
    interactiveRequests.get(`${norm(path)}|${requestId}`)?.abort()
    return { ok: true }
  })
  handle('lsp.hover', (input: PosInput): Promise<HoverOutput> => interactive(input, async (signal) => {
    const { path, position } = input
    const srv = await serverForPath(path)
    const r: any = await srv.client.request('textDocument/hover', { textDocument: { uri: uriOf(path) }, position }, 15000, signal)
    if (!r) return { markdown: null, range: null }
    const c = r.contents
    const md = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x === 'string' ? x : '```' + (x.language ?? '') + '\n' + x.value + '\n```')).join('\n\n') : c?.kind === 'plaintext' ? '```\n' + c.value + '\n```' : c?.value ?? null
    return JSON.parse(JSON.stringify({ markdown: md ?? null, range: r.range ?? null }))
  }))

  /** Files the language server pointed at (go to definition): the only ones lsp.peek may read. */
  const peekable = new Set<string>()
  async function locationsOf(list: any[], srv: Server): Promise<Loc[]> {
    const wsRoots = [...(await host.roots().catch(() => ({ roots: [] as string[] }))).roots, srv.root].map((x) => resolve(x))
    const locations: Loc[] = []
    for (const l of list) {
      let p: string
      try { p = fileURLToPath(l.uri ?? l.targetUri) } catch { continue }
      const range = l.targetSelectionRange ?? l.range ?? l.targetRange
      if (!range?.start || !range?.end) continue
      peekable.add(norm(p))
      locations.push({ path: p, range, inWorkspace: !isLibPath(p, srv.root), openable: wsRoots.some((r) => norm(p).startsWith(norm(r) + sep)) })
    }
    return limitItems(locations, (locations) => ({ locations, truncated: true }))
  }
  handle('lsp.definition', (input: PosInput): Promise<DefinitionOutput> => interactive(input, async (signal) => {
    const { path, position } = input
    const srv = await serverForPath(path)
    let r: any = await srv.client.request('textDocument/definition', { textDocument: { uri: uriOf(path) }, position }, 15000, signal)
    // clangd: on a declaration (header) definition points to itself -> try declaration to jump between .h/.cpp
    if ((!r || (Array.isArray(r) && !r.length)) && srv.lang === 'cpp') r = await srv.client.request('textDocument/declaration', { textDocument: { uri: uriOf(path) }, position }).catch(() => null)
    const list = r ? (Array.isArray(r) ? r : [r]) : []
    const locations = await locationsOf(list, srv)
    if (input.intent === 'click') host.log(`[navigation] click ${path}:${position.line + 1}:${position.character + 1} -> ${locations.length} definitions`)
    return JSON.parse(JSON.stringify({ locations }))
  }))

  handle('lsp.references', async ({ path, position, includeDeclaration = true }: PosInput & { includeDeclaration?: boolean }): Promise<ReferencesOutput> => {
    const srv = await serverForPath(path)
    if (!srv.capabilities.referencesProvider) return { locations: [] }
    const r = await srv.client.request<any[]>('textDocument/references', { textDocument: { uri: uriOf(path) }, position, context: { includeDeclaration } })
    const locations = await locationsOf(r ?? [], srv)
    return { locations, truncated: locations.length < (r?.length ?? 0) }
  })

  const markdown = (v: any): string | undefined => (typeof v === 'string' ? v : v?.value)?.slice(0, 8000)
  handle('lsp.signatureHelp', async ({ path, position, trigger }: PosInput & { trigger?: string }): Promise<SignatureHelpOutput> => {
    const srv = await serverForPath(path)
    const empty: SignatureHelpOutput = { signatures: [], activeSignature: 0, activeParameter: 0 }
    if (!srv.capabilities.signatureHelpProvider) return empty
    const r = await srv.client.request<any>('textDocument/signatureHelp', { textDocument: { uri: uriOf(path) }, position,
      context: { triggerKind: trigger ? 2 : 1, triggerCharacter: trigger, isRetrigger: false } })
    if (!r) return empty
    const signatures = (r.signatures ?? []).slice(0, 50).map((s: any) => ({ label: String(s.label).slice(0, 16000), documentation: markdown(s.documentation),
      activeParameter: s.activeParameter, parameters: (s.parameters ?? []).map((p: any) => ({ label: p.label, documentation: markdown(p.documentation) })) }))
    return { ...empty, signatures: limitItems(signatures, (signatures) => ({ ...empty, signatures })), activeSignature: r.activeSignature ?? 0, activeParameter: r.activeParameter ?? 0 }
  })

  handle('lsp.documentSymbols', async ({ path }: { path: string }): Promise<DocumentSymbolsOutput> => {
    const srv = await serverForPath(path)
    if (!srv.capabilities.documentSymbolProvider) return { items: [] }
    const raw = await srv.client.request<any[]>('textDocument/documentSymbol', { textDocument: { uri: uriOf(path) } })
    const items: DocumentSymbol[] = []
    const visit = (list: any[], parent = '', depth = 0) => {
      if (depth > 100) return
      for (const s of list) {
        if (items.length >= 10000) return
        const range = s.range ?? s.location?.range
        if (!range) continue
        items.push({ name: String(s.name), detail: s.detail ?? '', kind: s.kind, range, selectionRange: s.selectionRange ?? range, containerName: s.containerName ?? parent, tags: s.tags })
        if (s.children) visit(s.children, s.name, depth + 1)
      }
    }
    visit(raw ?? [])
    const capped = limitItems(items, (items) => ({ items, truncated: true }))
    return { items: capped, truncated: capped.length < items.length }
  })

  handle('lsp.documentHighlights', async ({ path, position }: PosInput): Promise<DocumentHighlightsOutput> => {
    const srv = await serverForPath(path)
    if (!srv.capabilities.documentHighlightProvider) return { items: [] }
    const r = await srv.client.request<any[]>('textDocument/documentHighlight', { textDocument: { uri: uriOf(path) }, position })
    return { items: limitItems((r ?? []).map((h) => ({ range: h.range, kind: h.kind ?? 1 })), (items) => ({ items })) }
  })

  handle('lsp.prepareRename', async ({ path, position }: PosInput): Promise<PrepareRenameOutput> => {
    const srv = await serverForPath(path)
    if (!srv.capabilities.renameProvider) return { rejectReason: 'This language server does not support rename.' }
    if (!srv.capabilities.renameProvider.prepareProvider) return {}
    const r = await srv.client.request<any>('textDocument/prepareRename', { textDocument: { uri: uriOf(path) }, position })
    if (!r) return { rejectReason: 'This symbol cannot be renamed.' }
    if (r.defaultBehavior) return {}
    const range = r.range ?? r
    const line = docs.get(norm(path))?.split(/\r?\n/)[range.start.line]
    return { range, placeholder: r.placeholder ?? (range.start.line === range.end.line ? line?.slice(range.start.character, range.end.character) : undefined) }
  })

  handle('lsp.rename', async ({ path, position, newName, version }: PosInput & { newName: string; version: number }): Promise<RenameOutput> => {
    const srv = await serverForPath(path)
    const reject = (rejectReason: string): RenameOutput => ({ edits: [], rejectReason })
    if (!srv.capabilities.renameProvider) return reject('This language server does not support rename.')
    if (!newName?.trim()) return reject('Enter a non-empty name.')
    if (srv.open.get(norm(path)) !== version) return reject('The document changed. Try rename again.')
    const r = await srv.client.request<any>('textDocument/rename', { textDocument: { uri: uriOf(path) }, position, newName })
    if (srv.open.get(norm(path)) !== version) return reject('The document changed. Try rename again.')
    if (!r) return reject('This symbol cannot be renamed.')
    const edits: SourceEdit[] = []
    const add = (uri: string, changes: any[]) => {
      let target: string
      try { target = fileURLToPath(uri) } catch { return false }
      if (norm(resolve(target)) !== norm(resolve(path))) return false
      for (const e of changes) {
        if (!e.range || typeof e.newText !== 'string') return false
        edits.push({ range: e.range, text: e.newText })
      }
      return true
    }
    for (const [uri, changes] of Object.entries(r.changes ?? {})) if (!add(uri, changes as any[])) return reject('Rename also changes other files. Cross-file rename is not available yet; no changes were applied.')
    for (const change of r.documentChanges ?? []) {
      if (!change.textDocument || !Array.isArray(change.edits)) return reject('Rename requires file operations; no changes were applied.')
      if (change.textDocument.version != null && change.textDocument.version !== version) return reject('The document changed. Try rename again.')
      if (!add(change.textDocument.uri, change.edits)) return reject('Rename also changes other files. Cross-file rename is not available yet; no changes were applied.')
    }
    if (messageBytes({ edits }) > RESPONSE_BUDGET) return reject('This rename is too large; no changes were applied.')
    return { edits }
  })

  handle('lsp.completion', async ({ path, position, trigger }: PosInput & { trigger?: string }): Promise<CompletionOutput> => {
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
      if (it.insertTextFormat === 2) out.snippet = true
      if (it.additionalTextEdits?.length) out.additionalTextEdits = it.additionalTextEdits.map((e: any) => ({ range: e.range, text: e.newText }))
      return out
    })
    const capped = limitItems(items, (items) => ({ items, incomplete: true }))
    return JSON.parse(JSON.stringify({ items: capped, incomplete: capped.length < items.length || (Array.isArray(r) ? false : !!r?.isIncomplete) }))
  })

  handle('lsp.diagnostics', async ({ path }: { path: string }) => {
    const lang = langOfPath(path)
    const srv = lang ? serverOf(lang, path) : null
    const d = srv?.diagnostics.get(norm(path))
    if (!d) return { version: -1, items: [] }
    const envelope = (items: DiagnosticsOutput['items']) => ({ version: d.version, items })
    return envelope(limitItems(d.items.slice(0, 2000).map((x) => ({ ...x, message: String(x.message).slice(0, 500) })), envelope))
  })

  handle('lsp.serverInfo', async ({ path }: { path: string }) => {
    const srv = await serverForPath(path)
    return { lang: srv.lang, server: SERVER_LABEL[srv.lang], root: srv.root, detail: srv.detail }
  })

  /** Restart the file's server (e.g. after CMake configure created compile_commands.json / a build dir). */
  handle('lsp.restart', async ({ path }: { path: string }) => {
    const lang = langOfPath(path)
    const srv = lang ? serverOf(lang, path) : null
    if (srv) stopServer(srv)
    const fresh = await serverForPath(path)
    return { detail: fresh.detail }
  })

  handle('lsp.interpreters', async ({ path }: { path: string }) => {
    const srv = await serverForPath(path)
    if (srv.lang !== 'python') return { root: srv.root, current: null, list: [] }
    const list = await interpretersFor(srv.root, path)
    return JSON.parse(JSON.stringify({ root: srv.root, current: srv.interpreter, list }))
  })

  handle('lsp.setInterpreter', async ({ path, interpreter }: { path: string; interpreter: string | null }) => {
    const srv = await serverForPath(path)
    if (srv.lang !== 'python') return { current: null }
    const saved = await savedInterpreters()
    if (interpreter) saved[norm(srv.root)] = interpreter
    else delete saved[norm(srv.root)]
    await host.storageSet(SAVED_KEY, saved)
    srv.interpreter = (await interpretersFor(srv.root, path))[0] ?? null
    srv.client.notify('workspace/didChangeConfiguration', { settings: {} })
    host.log(`interpreter for ${srv.root} -> ${srv.interpreter?.path ?? 'none'} [${srv.interpreter?.source ?? '-'}]`)
    return JSON.parse(JSON.stringify({ current: srv.interpreter }))
  })

  handle('lsp.semanticTokens', async ({ path }: { path: string }) => {
    const srv = await serverForPath(path)
    if (!srv.legend) return { legend: null, data: [] }
    const r: any = await srv.client.request('textDocument/semanticTokens/full', { textDocument: { uri: uriOf(path) } }, 20000).catch(() => null)
    const data: number[] = Array.isArray(r?.data) ? r.data : []
    // ~1 MiB message limit: ~30k tokens (150k numbers, each <= 7 JSON chars) is enough for normal sources; generated files (resources_rc.py) lose the tail.
    const groups: number[][] = []
    for (let i = 0; i + 4 < data.length && i < 150_000; i += 5) groups.push(data.slice(i, i + 5))
    return { legend: srv.legend, data: limitItems(groups, (groups) => ({ legend: srv.legend, data: groups.flat() })).flat() }
  })

  /** Read-only content of a target file for peek / navigation. Source/stub/header files only. */
  handle('lsp.peek', async ({ path, line }: { path: string; line?: number }) => {
    // Only files the language server itself pointed at (go to definition), never an arbitrary path
    if (!peekable.has(norm(path))) return { text: '', lang: null }
    const lang = langOfPath(path) ?? 'cpp'
    // Messages < 1 MiB: small files are sent whole; large ones (e.g. PySide6/QtCore.pyi, 570 KB) send a window of lines
    // around `line`, with lines outside it left empty (line numbers stay correct so peek jumps to the right place).
    const LIMIT = 300_000
    let text: string
    const live = serverOf(lang, path)?.open.has(norm(path))
    try { text = (live ? docs.get(norm(path)) : undefined) ?? readFileSync(path, 'utf8') } catch { return { text: '', lang } }
    if (jsonBytes({ text, lang }) <= RESPONSE_BUDGET) return { text, lang }
    const lines = text.split('\n')
    const at = Math.max(0, Math.min(lines.length - 1, line ?? 0))
    let from = at, to = at, size = lines[at].length
    while (size < LIMIT - lines.length && (from > 0 || to < lines.length - 1)) {
      if (to < lines.length - 1) { to++; size += lines[to].length + 1 }
      if (from > 0 && size < LIMIT - lines.length) { from--; size += lines[from].length + 1 }
    }
    let windowText = lines.map((l, i) => (i >= from && i <= to ? l : '')).join('\n')
    while (jsonBytes({ text: windowText, lang, window: [from, to] }) > RESPONSE_BUDGET && from < to) {
      if (at - from > to - at) from++; else to--
      windowText = lines.map((l, i) => (i >= from && i <= to ? l : '')).join('\n')
    }
    if (jsonBytes({ text: windowText, lang, window: [from, to] }) > RESPONSE_BUDGET) return { text: '', lang, truncated: true }
    return { text: windowText, lang, window: [from, to] }
  })

  /** Open the definition in an Orca tab (file inside a workspace); outside a workspace the editor shows a peek. */
  handle('lsp.reveal', async ({ path, line }: { path: string; line: number }) => {
    const result = host.reveal ? await host.reveal(path, line) : { opened: false, reason: 'no-host' }
    host.log(`[navigation] reveal ${path}:${line} opened=${result.opened}${result.reason ? ` reason=${result.reason}` : ''}`)
    return result
  })

  return { handlers, workspaceRemoved, shutdown: () => { for (const s of [...servers.values()]) stopServer(s) } }
}
