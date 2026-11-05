// Automatically picks the Python interpreter for a file, mirroring VS Code's selection order
// (Python Environments extension + python-environment-tools "PET"):
//
//   1. The user's saved choice for the project (VS Code: workspace state "venv:WORKSPACE_SELECTED";
//      skipped if the path no longer exists).
//   2. The plugin's "python" setting  (~ user-level python.defaultInterpreterPath).
//   3. .vscode/settings.json: python.defaultInterpreterPath (the default value "python" is ignored),
//      expanding ${workspaceFolder}/${env:X}; relative paths resolve from the project folder.
//   4. pyrightconfig.json / pyproject [tool.pyright|basedpyright]: venvPath + venv.
//   5. Project venvs (PET find.rs): at the project root check .venv, .conda, .virtualenv, venv and EVERY
//      direct subfolder that is a venv (has pyvenv.cfg). Project = deepest folder containing the file that has
//      pyproject.toml/setup.py/setup.cfg/pyrightconfig.json/.git or a child venv (like
//      "file belongs to the deepest project"). Several venvs: venvs directly in the project folder come before
//      deeper ones; otherwise: working before broken -> highest Python version -> name -> path
//      (VS Code does NOT prefer the name ".venv" and does not use modification time).
//   6. VIRTUAL_ENV only when it is inside the project.
//   7. Installed (global) Python: the highest version that runs (not PATH or py launcher order);
//      Microsoft Store stubs (WindowsApps) are skipped.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export type InterpreterSource = 'saved' | 'setting' | 'vscode' | 'pyright' | 'venv' | 'env' | 'global'
export interface Interpreter {
  /** Absolute path to python.exe / bin/python */
  path: string
  /** Display name, e.g. ".venv (3.14.7)" */
  label: string
  version: string | null
  source: InterpreterSource
  /** Venv folder (if it is a venv) */
  envDir: string | null
  /** Why it was chosen (shown in the tooltip) */
  reason?: string
}

const WIN = process.platform === 'win32'
const lower = (p: string) => (WIN ? p.toLowerCase() : p)
/** Executable of an env, in PET find_executable order. */
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
/** Version comparison: higher first; null last. */
function cmpVersionDesc(a: string | null, b: string | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
  return 0
}

const isEnvDir = (dir: string) => existsSync(join(dir, 'pyvenv.cfg')) || existsSync(join(dir, 'conda-meta'))
/** Environment folder of an interpreter path (…/env/bin/python, …/env/Scripts/python.exe, …/env/python.exe). */
const envDirOf = (exe: string): string | null => (isEnvDir(dirname(dirname(exe))) ? dirname(dirname(exe)) : isEnvDir(dirname(exe)) ? dirname(exe) : null)

/** Envs at the project root: well-known names + every direct subfolder that is an env (PET). */
function projectEnvs(root: string): string[] {
  const found = new Set<string>()
  for (const n of ['.venv', '.conda', '.virtualenv', 'venv']) if (isEnvDir(join(root, n))) found.add(join(root, n))
  let names: string[] = []
  try { names = readdirSync(root) } catch { /* unreadable */ }
  for (const n of names) {
    if (SKIP.has(n)) continue
    const full = join(root, n)
    try { if (statSync(full).isDirectory() && isEnvDir(full)) found.add(full) } catch { /* ignore */ }
  }
  return [...found]
}

/** Project of a file: the deepest folder (walking up from the file, not past `limit`) with a marker or a child env. */
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
      // Only an interpreter of a real environment (pyvenv.cfg / conda-meta next to it), never an arbitrary file
      if (existsSync(abs) && statSync(abs).isFile()) { if (envDirOf(abs)) return abs }
      else { const exe = isEnvDir(abs) ? envExe(abs) : null; if (exe) return exe }
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
    } catch { /* no pyproject */ }
  }
  if (!venv) return null
  const dir = resolve(root, venvPath ?? '.', venv)
  return isEnvDir(dir) ? envExe(dir) : null
}

/** Installed Pythons: py launcher, PATH, default install folders; WindowsApps stubs are skipped. */
function globalCandidates(): string[] {
  const out: string[] = []
  if (WIN) {
    try {
      const txt = execFileSync('py', ['-0p'], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of txt.split(/\r?\n/)) { const m = /([A-Za-z]:\\.*python\.exe)\s*$/i.exec(line.trim()); if (m) out.push(m[1]) }
    } catch { /* no py launcher */ }
    const base = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Programs', 'Python')
    try { for (const d of readdirSync(base)) out.push(join(base, d, 'python.exe')) } catch { /* none */ }
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
 * Interpreters for `file` in workspace `root`; the first entry is the automatically selected one.
 * `projectRoot` (the file's project folder) is also reflected in each entry's properties (envDir).
 */
export function discoverInterpreters(file: string, root: string, opts: { saved?: string; setting?: string; projectEnvs?: boolean } = {}): Interpreter[] {
  const useProject = opts.projectEnvs !== false
  const project = projectRootFor(file, root)
  const list: Interpreter[] = []
  const seen = new Set<string>()
  const insideRoot = (p: string) => {
    const r = lower(resolve(root)), abs = lower(resolve(p))
    if (abs === r || abs.startsWith(r + sep)) return true
    // Resolve aliases into the workspace, but preserve lexical checks for venv symlinks out of it.
    try { const realRoot = lower(realpathSync(root)), real = lower(realpathSync(p)); return real === realRoot || real.startsWith(realRoot + sep) } catch { return false }
  }
  const make = (path: string, source: InterpreterSource, reason: string): Interpreter | null => {
    const key = lower(resolve(path))
    if (seen.has(key) || !existsSync(path)) return null
    seen.add(key)
    const envDir = dirname(dirname(path))
    const isVenv = isEnvDir(envDir) || isEnvDir(dirname(path))
    const dir = isEnvDir(envDir) ? envDir : isEnvDir(dirname(path)) ? dirname(path) : null
    if (!useProject && (dir || insideRoot(path))) return null
    // Never execute a file from the project just to read its version (a cloned repo could ship any "python");
    // project environments get their version from pyvenv.cfg only. Installed Pythons outside the project may run.
    const inProject = insideRoot(path)
    const version = (dir && venvVersion(dir)) || (inProject ? null : runVersion(path))
    const name = dir ? (lower(dir).startsWith(lower(project) + (WIN ? '\\' : '/')) ? dir.slice(project.length + 1).replace(/\\/g, '/') : basename(dir)) : `Python ${version ?? ''}`.trim()
    return { path: resolve(path), label: isVenv ? `${name}${version ? ` (${version})` : ''}` : `${name} (global)`, version, source, envDir: dir, reason }
  }
  const add = (path: string | null | undefined, source: InterpreterSource, reason: string) => {
    if (!path) return
    const it = make(path, source, reason)
    if (it) list.push(it)
  }

  add(opts.saved, 'saved', 'you selected it for this project')
  add(opts.setting, 'setting', 'plugin setting "Python interpreter"')
  if (useProject) add(vscodeInterpreter(project), 'vscode', 'python.defaultInterpreterPath in .vscode/settings.json')
  if (useProject) add(pyrightConfigInterpreter(project), 'pyright', 'venvPath/venv in pyrightconfig/pyproject')

  // Project venvs: directly in the project folder first; then venvs of parent folders (up to the workspace root).
  const levels: string[] = []
  for (let dir = project; lower(dir).startsWith(lower(resolve(root))); ) {
    levels.push(dir)
    if (lower(dir) === lower(resolve(root))) break
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const [i, dir] of useProject ? levels.entries() : []) {
    const envs = projectEnvs(dir)
      .map((d) => ({ d, exe: envExe(d) }))
      .map((x) => ({ ...x, version: venvVersion(x.d) }))
      // working before broken -> highest version -> name -> path (VS Code's sortEnvironments)
      .sort((a, b) => (Number(!a.exe) - Number(!b.exe)) || cmpVersionDesc(a.version, b.version) || basename(a.d).localeCompare(basename(b.d)) || a.d.localeCompare(b.d))
    for (const e of envs) if (e.exe) add(e.exe, 'venv', i === 0 ? (envs.length > 1 ? `project venv (${envs.length} venvs: highest Python version chosen)` : 'project venv') : 'parent folder venv')
  }
  const active = process.env.VIRTUAL_ENV
  if (useProject && active && lower(resolve(active)).startsWith(lower(project))) add(envExe(active), 'env', 'active VIRTUAL_ENV')

  const globals = globalCandidates()
    .filter((p) => !insideRoot(p) && !envDirOf(p))
    .map((p) => ({ p, v: runVersion(p) }))
    .filter((x) => x.v)
    .sort((a, b) => cmpVersionDesc(a.v, b.v))
  for (const g of globals) add(g.p, 'global', 'no venv: using the highest installed Python')
  return list
}
