// Pure logic (no Orca calls): find Qt tools, scan files, build command lines.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, delimiter, extname, basename, relative, sep } from 'node:path'
import type { QtAction, QtFile, QtFileKind } from './protocol'

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

export const TOOL_NAMES = ['designer', 'uic', 'rcc', 'qmllint', 'qmlformat', 'qml', 'lupdate', 'lrelease', 'linguist', 'qmake', 'cmake'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** Finds a tool: the Qt bin folder from settings first, then PATH, then C:\Qt\<newest version>\*\bin. */
export function findTool(name: string, qtBin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = []
  if (qtBin) candidates.push(qtBin)
  for (const p of (env.PATH ?? env.Path ?? '').split(delimiter)) if (p) candidates.push(p)
  candidates.push(...defaultQtBins())
  for (const dir of candidates) {
    const f = join(dir, name + EXE)
    if (existsSync(f)) return f
  }
  return null
}

function defaultQtBins(): string[] {
  const roots = IS_WIN ? ['C:\\Qt'] : [join(process.env.HOME ?? '', 'Qt'), '/opt/Qt']
  const out: string[] = []
  for (const root of roots) {
    let versions: string[] = []
    try { versions = readdirSync(root).filter((v) => /^\d+\.\d+/.test(v)) } catch { continue }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) {
      let kits: string[] = []
      try { kits = readdirSync(join(root, v)) } catch { continue }
      for (const k of kits) out.push(join(root, v, k, 'bin'))
    }
    out.push(join(root, 'Tools', 'CMake_64', 'bin'), join(root, 'Tools', 'Ninja'))
  }
  return out
}

/** The workspace's Python: .venv/venv if present. */
export function findPython(root: string, configured: string): string | null {
  if (configured) return configured
  for (const v of ['.venv', 'venv', 'env']) {
    const p = IS_WIN ? join(root, v, 'Scripts', 'python.exe') : join(root, v, 'bin', 'python')
    if (existsSync(p)) return p
  }
  return null
}

const KIND_BY_EXT: Record<string, QtFileKind> = {
  '.ui': 'ui', '.qrc': 'qrc', '.qml': 'qml', '.ts': 'ts', '.pro': 'pro', '.py': 'py'
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '__pycache__', '.venv', 'venv', 'env', '.orca', 'out', '.idea', '.vscode', 'site-packages'])

/** Scans the workspace for Qt files (limited file count and depth). A .ts file counts only if it is a Linguist file (<TS ...>). */
export function scanProject(root: string, limit = 400): { files: QtFile[]; truncated: boolean } {
  const files: QtFile[] = []
  let truncated = false
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > 8) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (files.length >= limit) { truncated = true; return }
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.') && !/^build[-_]/i.test(name) && !/^cmake-build-/i.test(name)) walk(full, depth + 1)
        continue
      }
      let kind: QtFileKind | undefined = name === 'CMakeLists.txt' ? 'cmake' : KIND_BY_EXT[extname(name).toLowerCase()]
      if (!kind) continue
      if (kind === 'ts' && !isLinguistTs(full)) continue
      if (kind === 'py' && !isQtEntry(full)) continue
      files.push({ kind, path: relative(root, full).split(sep).join('/') })
    }
  }
  walk(root, 0)
  const order: QtFileKind[] = ['cmake', 'pro', 'py', 'qml', 'ui', 'qrc', 'ts']
  files.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.path.localeCompare(b.path))
  return { files, truncated }
}

function head(file: string, bytes = 4096): string {
  try { return readFileSync(file, 'utf8').slice(0, bytes) } catch { return '' }
}
function isLinguistTs(file: string): boolean { return /<TS[\s>]/.test(head(file, 512)) }
/** Lists only .py files that are Qt app entry points (main.py / contains QApplication). */
function isQtEntry(file: string): boolean {
  const n = basename(file).toLowerCase()
  if (n === 'main.py' || n === '__main__.py' || n === 'app.py') return true
  return /\bQ(Gui)?Application\s*\(/.test(head(file, 16384))
}

/** Quotes one argument for the terminal's shell (PowerShell on Windows, sh elsewhere).
 *  PowerShell treats the typographic quotes ‘ ’ ‚ ‛ as single quotes too, so they are doubled as well;
 *  anything outside a plain safe set is always quoted. */
export function q(arg: string): string {
  if (IS_WIN) return /^[A-Za-z0-9_.\\/:=+-]+$/.test(arg) ? arg : `'${arg.replace(/['‘’‚‛]/g, (c) => c + c)}'`
  return /[^A-Za-z0-9_./:=+-]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg
}
const call = (exe: string) => (IS_WIN ? `& ${q(exe)}` : q(exe))

export interface CommandContext {
  root: string
  path?: string
  tools: Record<string, string | null>
  binding: string
  python: string | null
  cmakeGenerator: string
  cmakeBuildType: string
}

export class ToolMissing extends Error {}

function need(ctx: CommandContext, tool: ToolName): string {
  const t = ctx.tools[tool]
  if (!t) throw new ToolMissing(`${tool} not found. Set "Qt bin folder" in the plugin settings, or add Qt to PATH.`)
  return t
}
function needPath(ctx: CommandContext): string {
  if (!ctx.path) throw new Error('No file given')
  return ctx.path
}
function stem(p: string) { return p.replace(/\.[^./]+$/, '') }
function dirOf(p: string) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1) }
function pyModule(binding: string) { return binding === 'pyqt6' ? 'PyQt6' : binding === 'pyqt5' ? 'PyQt5' : 'PySide6' }

/** Builds the command line for an action. Returns null if the action needs no terminal (e.g. opening a file). */
export function buildCommand(action: QtAction, ctx: CommandContext): string | null {
  const py = ctx.python ?? 'python'
  switch (action) {
    case 'designer': return ctx.path ? `${call(need(ctx, 'designer'))} ${q(ctx.path)}` : call(need(ctx, 'designer'))
    case 'linguist': return `${call(need(ctx, 'linguist'))} ${q(needPath(ctx))}`
    case 'uic': {
      const p = needPath(ctx)
      if (ctx.binding === 'cpp') return `${call(need(ctx, 'uic'))} ${q(p)} -o ${q(dirOf(p) + 'ui_' + basename(stem(p)) + '.h')}`
      const out = dirOf(p) + 'ui_' + basename(stem(p)) + '.py'
      if (ctx.binding === 'pyside6') return `${call(need(ctx, 'uic'))} -g python ${q(p)} -o ${q(out)}`
      return `${call(py)} -m ${pyModule(ctx.binding)}.uic.pyuic ${q(p)} -o ${q(out)}`
    }
    case 'rcc': {
      const p = needPath(ctx)
      if (ctx.binding === 'cpp') return `${call(need(ctx, 'rcc'))} ${q(p)} -o ${q(dirOf(p) + 'qrc_' + basename(stem(p)) + '.cpp')}`
      const out = dirOf(p) + basename(stem(p)) + '_rc.py'
      if (ctx.binding === 'pyside6') return `${call(need(ctx, 'rcc'))} -g python ${q(p)} -o ${q(out)}`
      if (ctx.binding === 'pyqt5') return `${call(py)} -m PyQt5.pyrcc_main ${q(p)} -o ${q(out)}`
      // PyQt6 has no rcc: use Qt's rcc to generate Python, then adjust the import
      return `${call(need(ctx, 'rcc'))} -g python ${q(p)} -o ${q(out)}`
    }
    case 'qmllint': return `${call(need(ctx, 'qmllint'))} ${q(needPath(ctx))}`
    case 'qmlformat': return `${call(need(ctx, 'qmlformat'))} -i ${q(needPath(ctx))}`
    case 'qml-preview': return `${call(need(ctx, 'qml'))} ${q(needPath(ctx))}`
    case 'lupdate': return `${call(need(ctx, 'lupdate'))} ${q(needPath(ctx))}`
    case 'lrelease': return `${call(need(ctx, 'lrelease'))} ${q(needPath(ctx))}`
    case 'cmake-configure':
      return `${call(need(ctx, 'cmake'))} -S . -B build -G ${q(ctx.cmakeGenerator)} -DCMAKE_BUILD_TYPE=${ctx.cmakeBuildType} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`
    case 'cmake-build': return `${call(need(ctx, 'cmake'))} --build build --parallel`
    case 'qmake': {
      const p = needPath(ctx)
      return `${call(need(ctx, 'qmake'))} ${q(p)} -o build/Makefile`
    }
    case 'run-python': return `${call(py)} ${q(needPath(ctx))}`
    case 'open': return null
  }
}
