// Tu dong chon interpreter Python cho mot file, theo dung co che cua VS Code
// (extension Python Environments + python-environment-tools "PET"), nghien cuu 04/11/2026:
//
//   1. Lua chon nguoi dung da luu cho du an (VS Code: workspace state "venv:WORKSPACE_SELECTED";
//      duong dan khong con ton tai thi bo qua).
//   2. Setting "python" cua plugin  (~ python.defaultInterpreterPath o cap nguoi dung).
//   3. .vscode/settings.json: python.defaultInterpreterPath (bo qua gia tri mac dinh "python"),
//      mo rong ${workspaceFolder}/${env:X}, duong dan tuong doi tinh tu thu muc du an.
//   4. pyrightconfig.json / pyproject [tool.pyright|basedpyright]: venvPath + venv.
//   5. Venv cua du an (PET find.rs): tai goc du an kiem tra .venv, .conda, .virtualenv, venv va MOI
//      thu muc con 1 cap la venv (co pyvenv.cfg). Du an = thu muc sau nhat chua file co
//      pyproject.toml/setup.py/setup.cfg/pyrightconfig.json/.git hoac co venv con (giong
//      "file thuoc du an sau nhat"). Nhieu venv: venv nam ngay trong thu muc du an truoc venv long sau
//      hon; con lai: hoat dong truoc hong -> phien ban Python cao nhat -> ten -> duong dan
//      (VS Code KHONG uu tien ten ".venv", khong dung thoi gian sua).
//   6. VIRTUAL_ENV chi khi no nam trong du an.
//   7. Python cai dat (global): ban cao nhat dang chay duoc (khong theo thu tu PATH hay py launcher);
//      bo stub Microsoft Store (WindowsApps).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export type InterpreterSource = 'saved' | 'setting' | 'vscode' | 'pyright' | 'venv' | 'env' | 'global'
export interface Interpreter {
  /** Duong dan tuyet doi toi python.exe / bin/python */
  path: string
  /** Ten hien thi, vd ".venv (3.14.7)" */
  label: string
  version: string | null
  source: InterpreterSource
  /** Thu muc venv (neu la venv) */
  envDir: string | null
  /** Ly do duoc chon (hien trong tooltip) */
  reason?: string
}

const WIN = process.platform === 'win32'
const lower = (p: string) => (WIN ? p.toLowerCase() : p)
/** File chay cua env, theo thu tu PET find_executable. */
function envExe(envDir: string): string | null {
  const c = WIN
    ? [join(envDir, 'Scripts', 'python.exe'), join(envDir, 'bin', 'python.exe'), join(envDir, 'python.exe')]
    : [join(envDir, 'bin', 'python'), join(envDir, 'bin', 'python3')]
  return c.find((f) => existsSync(f)) ?? null
}
const SKIP = new Set(['.git', 'node_modules', '.tox', '__pycache__', 'bin', 'Scripts', '.mypy_cache', '.pytest_cache', '.orca'])
const PROJECT_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pyrightconfig.json', '.git']

function readJsonc(file: string): any {
  try {
    const text = readFileSync(file, 'utf8')
    let s = '', inStr = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1]
      if (inStr) { s += c; if (c === '\\') { s += n; i++ } else if (c === '"') inStr = false }
      else if (c === '"') { inStr = true; s += c }
      else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; s += '\n' }
      else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++ }
      else s += c
    }
    return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'))
  } catch { return null }
}

function venvVersion(envDir: string): string | null {
  try {
    const cfg = readFileSync(join(envDir, 'pyvenv.cfg'), 'utf8')
    return /^\s*(?:version_info|version)\s*=\s*([\d.]+)/im.exec(cfg)?.[1] ?? null
  } catch { return null }
}
const versionCache = new Map<string, string | null>()
function runVersion(python: string): string | null {
  const k = lower(python)
  if (versionCache.has(k)) return versionCache.get(k)!
  let v: string | null = null
  try {
    v = execFileSync(python, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch { v = null }
  versionCache.set(k, v)
  return v
}
/** So sanh phien ban: cao hon dung truoc; null cuoi. */
function cmpVersionDesc(a: string | null, b: string | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
  return 0
}

const isEnvDir = (dir: string) => existsSync(join(dir, 'pyvenv.cfg')) || existsSync(join(dir, 'conda-meta'))

/** Env tai goc du an: ten quen thuoc + moi thu muc con 1 cap la env (PET). */
function projectEnvs(root: string): string[] {
  const found = new Set<string>()
  for (const n of ['.venv', '.conda', '.virtualenv', 'venv']) if (isEnvDir(join(root, n))) found.add(join(root, n))
  let names: string[] = []
  try { names = readdirSync(root) } catch { /* khong doc duoc */ }
  for (const n of names) {
    if (SKIP.has(n)) continue
    const full = join(root, n)
    try { if (statSync(full).isDirectory() && isEnvDir(full)) found.add(full) } catch { /* bo qua */ }
  }
  return [...found]
}

/** Du an cua file: thu muc sau nhat (tu thu muc file di len, khong vuot `limit`) co marker hoac co env con. */
export function projectRootFor(file: string, limit: string): string {
  let dir = dirname(resolve(file))
  const stop = lower(resolve(limit))
  while (lower(dir).startsWith(stop)) {
    if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m))) || projectEnvs(dir).length) return dir
    if (lower(dir) === stop) break
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return resolve(limit)
}

function vscodeInterpreter(root: string): string | null {
  for (let dir = root, i = 0; i < 6; i++) {
    const s = readJsonc(join(dir, '.vscode', 'settings.json'))
    const raw: string | undefined = s?.['python.defaultInterpreterPath'] ?? s?.['python.pythonPath']
    if (raw && raw !== 'python') {
      const p = raw.replace(/\$\{workspaceFolder\}/g, dir).replace(/\$\{env:([^}]+)\}/g, (_, k) => process.env[k] ?? '')
      const abs = isAbsolute(p) ? p : resolve(dir, p)
      if (existsSync(abs) && statSync(abs).isFile()) return abs
      const exe = envExe(abs)
      if (exe) return exe
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

function pyrightConfigInterpreter(root: string): string | null {
  const cfg = readJsonc(join(root, 'pyrightconfig.json'))
  let venvPath: string | undefined = cfg?.venvPath
  let venv: string | undefined = cfg?.venv
  if (!venv) {
    try {
      const toml = readFileSync(join(root, 'pyproject.toml'), 'utf8')
      const sec = /\[tool\.(?:based)?pyright\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? ''
      venvPath = /venvPath\s*=\s*"([^"]+)"/.exec(sec)?.[1] ?? venvPath
      venv = /^\s*venv\s*=\s*"([^"]+)"/m.exec(sec)?.[1]
    } catch { /* khong co pyproject */ }
  }
  if (!venv) return null
  return envExe(resolve(root, venvPath ?? '.', venv))
}

/** Python cai dat: py launcher, PATH, thu muc cai dat mac dinh; bo stub WindowsApps. */
function globalCandidates(): string[] {
  const out: string[] = []
  if (WIN) {
    try {
      const txt = execFileSync('py', ['-0p'], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of txt.split(/\r?\n/)) { const m = /([A-Za-z]:\\.*python\.exe)\s*$/i.exec(line.trim()); if (m) out.push(m[1]) }
    } catch { /* khong co py launcher */ }
    const base = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Programs', 'Python')
    try { for (const d of readdirSync(base)) out.push(join(base, d, 'python.exe')) } catch { /* khong co */ }
  }
  const names = WIN ? ['python.exe'] : ['python3', 'python']
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(WIN ? ';' : ':')) {
    if (!dir || /WindowsApps/i.test(dir)) continue
    for (const n of names) out.push(join(dir, n))
  }
  if (!WIN) out.push('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3')
  const seen = new Set<string>()
  return out.filter((p) => { const k = lower(p); if (seen.has(k) || !existsSync(p)) return false; seen.add(k); return true })
}

/**
 * Danh sach interpreter cho `file` trong workspace `root`; phan tu dau la interpreter duoc tu chon.
 * `projectRoot` (thu muc du an cua file) cung duoc tra ve qua thuoc tinh cua tung muc (envDir).
 */
export function discoverInterpreters(file: string, root: string, opts: { saved?: string; setting?: string } = {}): Interpreter[] {
  const project = projectRootFor(file, root)
  const list: Interpreter[] = []
  const seen = new Set<string>()
  const make = (path: string, source: InterpreterSource, reason: string): Interpreter | null => {
    const key = lower(resolve(path))
    if (seen.has(key) || !existsSync(path)) return null
    seen.add(key)
    const envDir = dirname(dirname(path))
    const isVenv = isEnvDir(envDir) || isEnvDir(dirname(path))
    const dir = isEnvDir(envDir) ? envDir : isEnvDir(dirname(path)) ? dirname(path) : null
    const version = (dir && venvVersion(dir)) || runVersion(path)
    const name = dir ? (lower(dir).startsWith(lower(project) + (WIN ? '\\' : '/')) ? dir.slice(project.length + 1).replace(/\\/g, '/') : basename(dir)) : `Python ${version ?? ''}`.trim()
    return { path: resolve(path), label: isVenv ? `${name}${version ? ` (${version})` : ''}` : `${name} (global)`, version, source, envDir: dir, reason }
  }
  const add = (path: string | null | undefined, source: InterpreterSource, reason: string) => {
    if (!path) return
    const it = make(path, source, reason)
    if (it) list.push(it)
  }

  add(opts.saved, 'saved', 'bạn đã chọn cho dự án này')
  add(opts.setting, 'setting', 'setting "Python interpreter" của plugin')
  add(vscodeInterpreter(project), 'vscode', 'python.defaultInterpreterPath trong .vscode/settings.json')
  add(pyrightConfigInterpreter(project), 'pyright', 'venvPath/venv trong pyrightconfig/pyproject')

  // Venv cua du an: ngay trong thu muc du an truoc; roi venv cua thu muc cha (toi goc workspace).
  const levels: string[] = []
  for (let dir = project; lower(dir).startsWith(lower(resolve(root))); ) {
    levels.push(dir)
    if (lower(dir) === lower(resolve(root))) break
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const [i, dir] of levels.entries()) {
    const envs = projectEnvs(dir)
      .map((d) => ({ d, exe: envExe(d) }))
      .map((x) => ({ ...x, version: venvVersion(x.d) }))
      // hoat dong truoc hong -> phien ban cao nhat -> ten -> duong dan (sortEnvironments cua VS Code)
      .sort((a, b) => (Number(!a.exe) - Number(!b.exe)) || cmpVersionDesc(a.version, b.version) || basename(a.d).localeCompare(basename(b.d)) || a.d.localeCompare(b.d))
    for (const e of envs) if (e.exe) add(e.exe, 'venv', i === 0 ? (envs.length > 1 ? `venv trong dự án (${envs.length} venv: chọn bản Python cao nhất)` : 'venv trong dự án') : 'venv của thư mục cha')
  }
  const active = process.env.VIRTUAL_ENV
  if (active && lower(resolve(active)).startsWith(lower(project))) add(envExe(active), 'env', 'VIRTUAL_ENV đang kích hoạt')

  const globals = globalCandidates()
    .map((p) => ({ p, v: runVersion(p) }))
    .filter((x) => x.v)
    .sort((a, b) => cmpVersionDesc(a.v, b.v))
  for (const g of globals) add(g.p, 'global', 'không có venv: dùng Python cài đặt bản cao nhất')
  return list
}
