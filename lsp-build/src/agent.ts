// Qt LSP agent running on a remote host (over SSH): same core as the Orca worker, reads files and runs
// basedpyright/qmlls/clangd on the host that has the code. Talks over stdin/stdout, one JSON line per message:
//   in:   {"id":1,"m":"lsp.attach","p":{...}}      {"id":0,"m":"$hello","p":{"settings":{...}}}
//   out:  {"id":1,"r":...} | {"id":1,"e":"error"} | {"ev":"lsp.diagnostics","p":{...}} | {"log":"..."}
// Needs only Node >= 18; Orca is not required on this host.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createCore } from './core'
import { installPyright as installPyrightAt } from './pyright-install'
import { LANGUAGE_PROFILE, PLUGIN_ID } from './language-profile'

declare const __AGENT_VERSION__: string
declare const __LSP_LANGUAGE__: 'all' | 'python' | 'cpp' | 'qml'
export const AGENT_VERSION = __AGENT_VERSION__
const HOME = join(homedir(), '.orca-qt-lsp')
mkdirSync(HOME, { recursive: true })
process.env.QT_LSP_DIR ??= HOME

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const log = (m: string) => out({ log: m })

let settings: Record<string, unknown> = {}
const statePath = join(HOME, LANGUAGE_PROFILE === 'all' ? 'state.json' : `state-${PLUGIN_ID}.json`)
const readState = (): Record<string, unknown> => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return {} } }

/** Workspaces of an Orca installed on this host (if any): `orca worktree list --json`. Cached for 60 s. */
let orcaRoots: { at: number; list: string[] } = { at: 0, list: [] }
function orcaWorkspaces(): string[] {
  if (Date.now() - orcaRoots.at < 60000) return orcaRoots.list
  let list: string[] = []
  try {
    // Full path to Orca's own CLI, never a lookup through a shell (on Linux `orca` is usually the GNOME screen reader)
    const cli = process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
      : process.platform === 'darwin' ? '/Applications/Orca.app/Contents/Resources/bin/orca' : ''
    if (!cli || !existsSync(cli)) throw new Error('no orca')
    const r = spawnSync(cli, ['worktree', 'list', '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 << 20, windowsHide: true })
    const j = JSON.parse(r.stdout || '{}')
    list = (j.result?.worktrees ?? []).filter((w: any) => !w.hostId || w.hostId === 'local').map((w: any) => String(w.path))
  } catch { /* no Orca on this host */ }
  orcaRoots = { at: Date.now(), list }
  return list
}

/** Root folders on this host, in order: worker hints, previously used folders, settings, this host's Orca workspaces,
 *  and finally the home folder (breadth-first scan, stops early once the file is found). */
const usedRoots = new Set<string>((readState().roots as string[] | undefined) ?? [])
function rootsOf(hints?: string[]) {
  const fromSetting = String(settings.remoteRoots ?? '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
  const list = [...(hints ?? []), ...usedRoots, ...fromSetting, ...orcaWorkspaces(), homedir()].filter((r) => r && existsSync(r))
  return { focused: list[0] ?? null, roots: [...new Set(list)] }
}

const installPyright = (typeof __LSP_LANGUAGE__ === 'undefined' || __LSP_LANGUAGE__ === 'all' || __LSP_LANGUAGE__ === 'python') ? () => installPyrightAt(HOME, process.execPath, log) : undefined

const core = createCore({
  log,
  post: (ev, p) => out({ ev, p }),
  setting: async (k, fallback) => (settings[k] as any) ?? fallback,
  storageGet: async (k) => readState()[k],
  storageSet: async (k, v) => { const s = readState(); s[k] = v; writeFileSync(statePath, JSON.stringify(s)) },
  roots: async (hints) => rootsOf(hints),
  installPyright
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let identified = LANGUAGE_PROFILE === 'all'
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg: { id: number; m: string; p?: any }
  try { msg = JSON.parse(line) } catch { return }
  try {
    if (msg.m === '$hello') {
      if (LANGUAGE_PROFILE !== 'all' && (msg.p?.language !== LANGUAGE_PROFILE || msg.p?.pluginId !== PLUGIN_ID)) throw new Error('Remote agent language/profile identity mismatch')
      identified = true
      settings = msg.p?.settings ?? {}
      out({ id: msg.id, r: { version: AGENT_VERSION, platform: process.platform, node: process.version, home: HOME, language: LANGUAGE_PROFILE, pluginId: PLUGIN_ID } })
      return
    }
    if (!identified) throw new Error('Remote agent identity handshake required')
    if (msg.m === '$roots') {
      for (const r of msg.p?.roots ?? []) if (typeof r === 'string') usedRoots.add(r)
      const state = readState(); state.roots = [...usedRoots].slice(-30); writeFileSync(statePath, JSON.stringify(state))
      out({ id: msg.id, r: null }); return
    }
    const h = core.handlers[msg.m]
    if (!h) { out({ id: msg.id, e: `unknown method ${msg.m}` }); return }
    const r = await h(msg.p)
    if (msg.m === 'lsp.attach' && r?.ok && r.workspace) {
      usedRoots.add(r.workspace)
      const s = readState(); s.roots = [...usedRoots].slice(-30); writeFileSync(statePath, JSON.stringify(s))
    }
    out({ id: msg.id, r: r ?? null })
  } catch (e) {
    out({ id: msg.id, e: e instanceof Error ? e.message : String(e) })
  }
})
// SSH closed (Orca/worker exited) -> stop all servers
rl.on('close', () => { core.shutdown(); setTimeout(() => process.exit(0), 1500) })
log(`agent ${AGENT_VERSION} ready on ${process.platform} ${process.version}`)
