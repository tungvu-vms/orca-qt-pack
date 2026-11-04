// Agent Qt LSP chay tren may tu xa (qua SSH): cung loi voi worker Orca, doc file va chay
// basedpyright/qmlls/clangd tren may co code. Giao tiep stdin/stdout, moi tin mot dong JSON:
//   vao:  {"id":1,"m":"lsp.attach","p":{...}}      {"id":0,"m":"$hello","p":{"settings":{...}}}
//   ra:   {"id":1,"r":...} | {"id":1,"e":"loi"} | {"ev":"lsp.diagnostics","p":{...}} | {"log":"..."}
// Chi dung Node >= 18 co san; khong can Orca tren may nay.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createCore } from './core'
import { installPyright as installPyrightAt } from './pyright-install'

declare const __AGENT_VERSION__: string
export const AGENT_VERSION = __AGENT_VERSION__
const HOME = join(homedir(), '.orca-qt-lsp')
mkdirSync(HOME, { recursive: true })
process.env.QT_LSP_DIR ??= HOME

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const log = (m: string) => out({ log: m })

let settings: Record<string, unknown> = {}
const statePath = join(HOME, 'state.json')
const readState = (): Record<string, unknown> => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return {} } }

/** Workspace cua Orca cai tren chinh may nay (neu co): `orca worktree list --json`. Cache 60 s. */
let orcaRoots: { at: number; list: string[] } = { at: 0, list: [] }
function orcaWorkspaces(): string[] {
  if (Date.now() - orcaRoots.at < 60000) return orcaRoots.list
  let list: string[] = []
  try {
    const win = process.platform === 'win32'
    const r = spawnSync(win ? 'orca.cmd' : 'orca', ['worktree', 'list', '--json'], { encoding: 'utf8', shell: win, timeout: 15000, maxBuffer: 64 << 20, windowsHide: true })
    const j = JSON.parse(r.stdout || '{}')
    list = (j.result?.worktrees ?? []).filter((w: any) => !w.hostId || w.hostId === 'local').map((w: any) => String(w.path))
  } catch { /* may nay khong co Orca */ }
  orcaRoots = { at: Date.now(), list }
  return list
}

/** Thu muc goc cua may nay, theo thu tu: goi y tu worker, thu muc da dung, cau hinh, workspace Orca cua may nay,
 *  cuoi cung la thu muc home (quet theo chieu rong, dung som khi gap file). */
const usedRoots = new Set<string>((readState().roots as string[] | undefined) ?? [])
function rootsOf(hints?: string[]) {
  const fromSetting = String(settings.remoteRoots ?? '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
  const list = [...(hints ?? []), ...usedRoots, ...fromSetting, ...orcaWorkspaces(), homedir()].filter((r) => r && existsSync(r))
  return { focused: list[0] ?? null, roots: [...new Set(list)] }
}

const installPyright = () => installPyrightAt(HOME, process.execPath, log)

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
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg: { id: number; m: string; p?: any }
  try { msg = JSON.parse(line) } catch { return }
  try {
    if (msg.m === '$hello') {
      settings = msg.p?.settings ?? {}
      out({ id: msg.id, r: { version: AGENT_VERSION, platform: process.platform, node: process.version, home: HOME } })
      return
    }
    if (msg.m === '$roots') { for (const r of msg.p?.roots ?? []) usedRoots.add(r); return }
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
// SSH dong (Orca/worker thoat) -> dung moi server
rl.on('close', () => { core.shutdown(); setTimeout(() => process.exit(0), 1500) })
log(`agent ${AGENT_VERSION} ready on ${process.platform} ${process.version}`)
