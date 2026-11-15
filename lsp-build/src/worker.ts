// Orca worker for Qt LSP: runs the core (core.ts) for files on this machine, and forwards to an agent on another
// host over SSH (remote.ts) when the file open in Orca lives there (SSH workspace, paired machine...).
// As automatic as possible: file not found locally -> probe every host in ~/.ssh/config (read-only, in parallel);
// the host that has the file runs the agent and is remembered for the project; the ⇄ status bar button changes the host per project.
// Paths on another host are tagged "@<host>:<path>" so the editor can use them like ordinary paths.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from './core'
import { RemoteAgent, findSsh, isValidHost } from './remote'
import { EXT_RE, PROBE_SKIP } from './probe-script'
import type { AttachInput, AttachOutput } from './protocol'
import { limitItems, POST_BUDGET } from './transport'
import { assertSupportedInput, LANGUAGE_PROFILE, PLUGIN_ID } from './language-profile'

const WIN = process.platform === 'win32'
const norm = (p: string) => (WIN ? p.toLowerCase() : p)
const isLocal = (w: { hostId: string | null }) => !w.hostId || w.hostId === 'local'
const HERE = dirname(fileURLToPath(import.meta.url))

/** "@host:C:\x\y.py" <-> { host, path } */
const REMOTE_RE = /^@([^:]+):(.*)$/s
const tag = (host: string, p: string) => `@${host}:${p}`
const untag = (p: string): { host: string; path: string } | null => { const m = REMOTE_RE.exec(p); return m && isValidHost(m[1]) ? { host: m[1], path: m[2] } : null }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Hosts in ~/.ssh/config (wildcard * ? patterns skipped). auto=true: only hosts safe to try automatically - skips
 *  ProxyCommand hosts (e.g. cloudflared may open a browser login), Git hosts (github...), and keeps one alias per target. */
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
      if (isValidHost(n)) out.push(n)
    }
  }
  return [...new Set(out)]
}

/** The `orca` CLI shipped with the running Orca (resources/bin), then the default install location. Linux: never use
 *  `orca` from PATH (usually the GNOME screen reader). */
function orcaCli(): string | null {
  const exe = WIN ? 'orca.exe' : 'orca'
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath
  const c = [
    process.env.ORCA_CLI_COMMAND,
    res && join(res, 'bin', exe),
    WIN ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', exe) : '/Applications/Orca.app/Contents/Resources/bin/orca',
    WIN ? undefined : join(homedir(), 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca')
  ]
  return c.find((p): p is string => !!p && existsSync(p)) ?? null
}
const CLI = orcaCli()
let cliLog: (m: string) => void = () => {}

/** Open the file as an Orca tab at `line` (1-based) in workspace `wsPath` and focus that tab. */
function cliOpen(file: string, wsPath: string, line: number): Promise<boolean> {
  if (!CLI) return Promise.resolve(false)
  const args = ['file', 'open', file, '--line', String(Math.max(1, line)), '--worktree', `path:${wsPath}`, '--focus', '--json']
  return new Promise((done) => {
    // The plugin worker runs with a trimmed environment (no APPDATA/LOCALAPPDATA on Windows, XDG... on Linux):
    // the CLI needs them to find the running Orca's metadata file.
    const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    if (WIN) {
      env.APPDATA ??= join(h, 'AppData', 'Roaming')
      env.LOCALAPPDATA ??= join(h, 'AppData', 'Local')
      env.USERPROFILE ??= h
    } else env.HOME ??= h
    execFile(CLI, args, { timeout: 15000, windowsHide: true, env }, (err, stdout) => {
      let ok = false
      try { ok = JSON.parse(stdout).ok === true } catch { /* */ }
      if (!ok) cliLog(`orca file open failed: ${CLI} ${args.join(' ')} -> ${(err?.message ?? '').slice(0, 200)} ${stdout.slice(0, 300)}`)
      done(ok)
    })
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  cliLog = (m) => orca.log(m)
  orca.log(`orca cli: ${CLI ?? 'not found'}`)
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
      // Outside every workspace (stdlib, typeshed...): Orca cannot open a tab -> the editor shows a peek
      if (!ws) return { opened: false, reason: 'outside' }
      const rel = resolve(path).slice(resolve(ws.path).length + 1).split(/[\\/]/).join('/')
      // `orca file open --line` opens the tab with the cursor on the line (the plugin's editor.open has no line)
      if (await cliOpen(resolve(path), ws.path, line)) return { opened: true, line, rel }
      await orca.host.call('editor.open', { workspaceId: ws.id, path: rel })
      return { opened: true, line: 1, rel }
    }
  })

  // ---------- other hosts over SSH ----------
  const agents = new Map<string, RemoteAgent>()
  let agentSource: string | null = null
  let cfg = { sshPath: '', remoteRoots: '', remoteNode: '', projectEnvironments: 'on', typeCheckingMode: 'off', compilationDatabase: '' }
  const loadCfg = async () => {
    const [sshPath, remoteRoots, remoteNode, projectEnvironments, typeCheckingMode, compilationDatabase] = await Promise.all([
      setting('sshPath', ''), setting('remoteRoots', ''), setting('remoteNode', ''),
      setting('projectEnvironments', 'on'), setting('typeCheckingMode', 'off'), setting('compilationDatabase', '')
    ])
    cfg = { sshPath: String(sshPath), remoteRoots: String(remoteRoots), remoteNode: String(remoteNode), projectEnvironments: String(projectEnvironments), typeCheckingMode: String(typeCheckingMode), compilationDatabase: String(compilationDatabase) }
  }
  let cfgReady = loadCfg()
  try {
    (orca.settings as any).onDidChange?.((change: { key?: string }) => {
      // This setting only controls frame markers; preserve remote unsaved buffers.
      if (change?.key === 'pythonDiagnostics') return
      cfgReady = cfgReady.then(loadCfg)
      for (const a of agents.values()) a.stop()
      agents.clear()
    })
  } catch { /* older Orca versions have no onDidChange */ }
  const extraHosts = async () => String(await setting('remoteHosts', '')).split(/[\s,;]+/).map((s) => s.trim()).filter(isValidHost)

  function remoteFor(host: string): RemoteAgent {
    let a = agents.get(host)
    if (!a) {
      agentSource ??= readFileSync(join(HERE, 'agent.mjs'), 'utf8')
      a = new RemoteAgent(host, findSsh(cfg.sshPath), agentSource, { remoteRoots: cfg.remoteRoots, remoteNode: cfg.remoteNode, projectEnvironments: cfg.projectEnvironments, typeCheckingMode: cfg.typeCheckingMode, compilationDatabase: cfg.compilationDatabase })
      a.log = (l) => orca.log(l)
      a.onEvent = (ev, p: any) => {
        // Agent events carry remote paths: tag them with the host before posting to the editor
        if (p && typeof p.path === 'string') p = { ...p, path: tag(host, p.path) }
        if (p?.items) p = { ...p, items: limitItems(p.items, (items) => ({ ...p, items }), POST_BUDGET) }
        orca.panels.post(ev as any, p)
      }
      agents.set(host, a)
    }
    return a
  }
  async function agentFor(host: string): Promise<RemoteAgent> {
    let pending: Promise<void>
    do { pending = cfgReady; await pending } while (pending !== cfgReady)
    const a = remoteFor(host)
    await a.start()
    return a
  }

  /** Paths of Orca workspaces that point to other hosts (SSH...): hints for where the remote host should search. */
  async function remoteHints(): Promise<string[]> {
    const { workspaces } = await orca.host.call('workspace.list', {}).catch(() => ({ workspaces: [] as { path: string; hostId: string | null }[] }))
    return workspaces.filter((w) => !isLocal(w)).map((w) => w.path)
  }

  // Only tag FILE paths (attach result, locations, peek); interpreter paths (python.exe) stay untagged
  // because the editor sends that value back to the agent as-is.
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

  // ---------- Host per project (the ⇄ button in the editor status bar) ----------
  // Key = name of the focused Orca workspace. Value: SSH host name, 'local', or absent (automatic).
  const PROJECT_HOSTS = 'projectHosts'
  const NO_PROJECT = '(no workspace)'
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
    assertSupportedInput('lsp.attach', input)
    await cfgReady
    const key = await projectKey()
    const chosen = (await projectHosts())[key]
    if (chosen === 'local') return local.handlers['lsp.attach'](input)
    // Project already has a host (picked manually or found earlier): go straight there
    if (chosen) {
      try {
        const r = await attachOn(chosen, input, await remoteHints())
        if (r.path) return r
        // The old host no longer has the file (host changed, project deleted): forget it and search again
        await rememberHost(key, null)
      } catch (e) {
        return { ok: false, path: null, candidates: 0, workspace: null, server: null, message: `${chosen}: ${errText(e)} — press ⇄ at the bottom to pick another host.` }
      }
    }
    const res: AttachOutput = await local.handlers['lsp.attach'](input)
    if (res.path) return res
    if (String(await setting('autoFindRemote', 'on')).trim().toLowerCase() === 'off') {
      return { ...res, message: 'File not found on this machine. Automatic search on SSH hosts is off: press ⇄ at the bottom to pick the host for this project.' }
    }
    // Tiny files (an empty __init__.py) match on almost any host: never guess the host from them
    if ((input.size ?? 0) < 64) {
      return { ...res, message: 'File not found on this machine and too small to identify on another one: press ⇄ at the bottom to pick its host.' }
    }

    // Automatic: probe every known SSH host (Settings + ~/.ssh/config) at once with a read-only script (installs nothing);
    // only the host that has the file runs the agent and is remembered for this project. Hosts needing a password / offline are skipped (BatchMode).
    const hosts = [...new Set([...(await extraHosts()), ...sshConfigHosts(true)])].slice(0, 40)
    if (!hosts.length) {
      return { ...res, message: 'File not found on this machine, and ~/.ssh/config has no hosts. If the code is on another host: press ⇄ at the bottom and type user@host.' }
    }
    const hints = await remoteHints()
    const sizes = [input.size, input.sizeCrlf].filter((s): s is number => typeof s === 'number').flatMap((s) => [s, s + 3])
    const roots = cfg.remoteRoots.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
    const q = { hash: input.hash ?? '', sizes, ext: EXT_RE[input.language], hints, roots, skip: PROBE_SKIP, ms: 25000,
      stateFile: LANGUAGE_PROFILE === 'all' ? 'state.json' : `state-${PLUGIN_ID}.json` }
    const errors: string[] = []
    const found = await new Promise<{ host: string; root: string } | null>((done) => {
      let left = hosts.length
      let settled = false
      for (const host of hosts) {
        void remoteFor(host).probe(q).then(
          (hit) => { if (hit && !settled) { settled = true; done({ host, root: hit.root }) } else if (!hit) errors.push(`${host}: not found`) },
          (e) => { errors.push(`${host}: ${errText(e).slice(0, 80)}`) }
        ).finally(() => { if (--left === 0 && !settled) { settled = true; done(null) } })
      }
    })
    if (found) {
      orca.log(`project "${key}" -> ${found.host} (auto-found in ${found.root})`)
      try {
        const r = await attachOn(found.host, input, [found.root, ...hints])
        // Only remember when the project is known (focused workspace); otherwise search again next time
        if (r.path) { if (key !== NO_PROJECT) await rememberHost(key, found.host); return r }
      } catch (e) {
        return { ...res, message: `Found the file on ${found.host} but could not run the agent: ${errText(e)}` }
      }
    }
    orca.log(`attach miss on ${hosts.length} hosts: ${errors.join('; ')}`)
    return { ...res, message: `File not found on this machine or on ${hosts.length} SSH hosts (${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}). Press ⇄ at the bottom to pick a host.` }
  }

  /** All other handlers: a host-tagged path is forwarded to that host's agent. */
  const route = (name: string) => async (input: any) => {
    assertSupportedInput(name, input)
    const target = input && typeof input.path === 'string' ? untag(input.path) : null
    if (!target) return local.handlers[name](input)
    if (name === 'lsp.reveal') return { opened: false, reason: 'remote' }
    const a = await agentFor(target.host)
    const out = tagPaths(target.host, await a.call(name, { ...input, path: target.path }))
    // Remote host: Orca cannot open a tab for that file via the plugin -> the editor shows a peek instead
    if ((name === 'lsp.definition' || name === 'lsp.references') && out?.locations) for (const l of out.locations) { l.inWorkspace = false; l.openable = false }
    if (out?.locations) {
      const capped = limitItems(out.locations, (locations) => ({ ...out, locations, truncated: true }))
      if (capped.length < out.locations.length) { out.locations = capped; out.truncated = true }
    }
    return out
  }

  orca.panels.handle('lsp.attach', (input) => attach(input as unknown as AttachInput) as any)
  for (const name of Object.keys(local.handlers)) if (name !== 'lsp.attach') orca.panels.handle(name, route(name) as any)

  /** ⇄ button: the project's current host + suggested hosts. */
  orca.panels.handle('lsp.hostChoice', async () => {
    const key = await projectKey()
    const map = await projectHosts()
    const hosts = [...new Set([...(await extraHosts()), ...Object.values(map).filter((h) => h !== 'local'), ...sshConfigHosts(false)])]
    return { project: key, chosen: map[key] ?? null, hosts } as any
  })
  orca.panels.handle('lsp.setHost', async (input) => {
    const host = ((input as { host?: string | null } | null)?.host ?? '').trim() || null
    if (host && host !== 'local' && !isValidHost(host)) return { ok: false, error: `Invalid SSH host: ${host}` } as any
    const key = await projectKey()
    await rememberHost(key, host)
    orca.log(`project "${key}" -> ${host ?? 'automatic'} (manual choice)`)
    // Check the connection right away to report errors early (SSH key, Node...)
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

export function deactivate(): void { /* child processes (servers, ssh) exit on their own when the worker stops */ }
