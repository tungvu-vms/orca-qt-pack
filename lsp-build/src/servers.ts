// Per-language server setup: locating the program, command-line arguments, project root, workspace config.
//   Python  : basedpyright (preferred) / Pyright         — run with node
//   QML     : Qt's qmlls (C:\Qt\<version>\<kit>\bin)     — adds -b <build dir> to see the project's QML modules
//   C/C++   : clangd (Qt Creator, LLVM, PATH)            — --compile-commands-dir=<build dir> with compile_commands.json
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export type Lang = 'python' | 'qml' | 'cpp'
export const LANG_OF_EXT: Record<string, Lang> = {
  '.py': 'python', '.pyi': 'python', '.pyw': 'python',
  '.qml': 'qml',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp', '.c': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.inl': 'cpp', '.ipp': 'cpp', '.tpp': 'cpp', '.tcc': 'cpp', '.ixx': 'cpp', '.cppm': 'cpp'
}
export const EXTS_OF_LANG: Record<Lang, RegExp> = {
  python: /\.(py|pyi|pyw)$/i,
  qml: /\.qml$/i,
  cpp: /\.(cpp|cc|cxx|c\+\+|c|h|hpp|hh|hxx|inl|ipp|tpp|tcc|ixx|cppm)$/i
}
export const LANGUAGE_ID: Record<Lang, (path: string) => string> = {
  python: () => 'python',
  qml: () => 'qml',
  cpp: (p) => (/\.c$/i.test(p) ? 'c' : 'cpp')
}
export const SERVER_LABEL: Record<Lang, string> = { python: 'Pyright', qml: 'qmlls', cpp: 'clangd' }

const WIN = process.platform === 'win32'
const home = () => process.env.USERPROFILE ?? process.env.HOME ?? homedir()
const pathDirs = () => (process.env.PATH ?? process.env.Path ?? '').split(WIN ? ';' : ':').filter(Boolean)
const exe = (name: string) => (WIN ? `${name}.exe` : name)
const lower = (p: string) => (WIN ? p.toLowerCase() : p)

/** Bin folders of installed Qt versions, newest first (C:\Qt\6.12.0\mingw_64\bin, ~/Qt/...). */
export function qtBinDirs(extra?: string): string[] {
  const out: string[] = []
  if (extra) out.push(extra)
  const roots = WIN ? ['C:\\Qt', join(home(), 'Qt')] : [join(home(), 'Qt'), '/opt/Qt', '/usr/local/Qt']
  for (const root of roots) {
    let versions: string[] = []
    try { versions = readdirSync(root).filter((v) => /^\d+\.\d+/.test(v)) } catch { continue }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) {
      let kits: string[] = []
      try { kits = readdirSync(join(root, v)) } catch { continue }
      for (const k of kits) if (existsSync(join(root, v, k, 'bin'))) out.push(join(root, v, k, 'bin'))
    }
  }
  return out
}

function firstExisting(cands: string[]): string | null {
  for (const c of cands) if (c && existsSync(c)) return c
  return null
}

/** qmlls: setting > Qt bin dirs > PATH. */
export function findQmlls(configured: string, qtBin: string): string | null {
  if (configured && existsSync(configured)) return configured
  return firstExisting([...qtBinDirs(qtBin).map((d) => join(d, exe('qmlls'))), ...pathDirs().map((d) => join(d, exe('qmlls')))])
}

/** clangd: explicit setting > PATH > known LLVM/Qt Creator installations. */
export function findClangd(configured: string): string | null {
  if (configured) {
    if (!existsSync(configured) || !statSync(configured).isFile()) throw new Error(`Configured clangd was not found: ${configured}`)
    return configured
  }
  const c: string[] = pathDirs().map((d) => join(d, exe('clangd')))
  if (WIN) {
    for (const root of ['C:\\Qt', join(home(), 'Qt')]) c.push(join(root, 'Tools', 'QtCreator', 'bin', 'clang', 'bin', 'clangd.exe'))
    c.push('C:\\Program Files\\LLVM\\bin\\clangd.exe')
  } else {
    c.push('/Applications/Qt Creator.app/Contents/Resources/libexec/clang/bin/clangd', join(home(), 'Qt', 'Tools', 'QtCreator', 'libexec', 'qtcreator', 'clang', 'bin', 'clangd'), '/usr/bin/clangd', '/usr/local/bin/clangd', '/opt/homebrew/opt/llvm/bin/clangd')
  }
  try {
    const vsc = join(home(), '.vscode', 'extensions')
    for (const d of readdirSync(vsc).filter((n) => n.startsWith('llvm-vs-code-extensions.vscode-clangd'))) {
      const inst = join(vsc, d, 'install')
      for (const v of (existsSync(inst) ? readdirSync(inst) : [])) c.push(join(inst, v, `clangd_${v}`, 'bin', exe('clangd')))
    }
  } catch { /* none */ }
  return firstExisting(c)
}

const BUILD_DIR_RE = /^(build|out|cmake-build-.*|build-.*|_build)$/i

/** Project build folders: where compile_commands.json (C++) or generated QML modules (QML) live.
 *  Searches the project root and well-known build folders, 2 levels deep; most recently modified first. */
export function findBuildDirs(root: string, want: 'compile_commands' | 'qml'): string[] {
  const hits: { dir: string; mtime: number }[] = []
  const check = (dir: string) => {
    try {
      if (want === 'compile_commands') {
        const f = join(dir, 'compile_commands.json')
        if (existsSync(f)) hits.push({ dir, mtime: statSync(f).mtimeMs })
      } else if (existsSync(join(dir, 'CMakeCache.txt')) || existsSync(join(dir, 'qmldir'))) {
        hits.push({ dir, mtime: statSync(dir).mtimeMs })
      }
    } catch { /* ignore */ }
  }
  if (want === 'compile_commands') check(root)
  let names: string[] = []
  try { names = readdirSync(root) } catch { return [] }
  for (const n of names) {
    if (!BUILD_DIR_RE.test(n)) continue
    const d = join(root, n)
    try { if (!statSync(d).isDirectory()) continue } catch { continue }
    check(d)
    // build/<preset or kit>/ (CMake presets, Qt Creator)
    try { for (const s of readdirSync(d)) { const sd = join(d, s); try { if (statSync(sd).isDirectory()) check(sd) } catch { /* */ } } } catch { /* */ }
  }
  return hits.sort((a, b) => b.mtime - a.mtime).map((h) => h.dir)
}

/** A configured database can live outside a CMake-style build directory. */
export function compilationDatabaseDir(root: string, configured: string): string | null {
  if (!configured.trim()) return findBuildDirs(root, 'compile_commands')[0] ?? null
  const folder = resolve(root, configured.trim()), file = join(folder, 'compile_commands.json')
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Compilation database missing: ${file}`)
  return folder
}

const PROJECT_MARKERS: Record<Lang, string[]> = {
  python: ['pyrightconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', '.git'],
  // QML/C++: CMake/qmake project (deepest CMakeLists.txt with project()), .qmlls.ini, compile_commands, .git
  qml: ['.qmlls.ini', 'CMakeLists.txt', '.git'],
  cpp: ['compile_commands.json', '.clangd', 'compile_flags.txt', 'CMakeLists.txt', '.git']
}

/** Project root of a file per language, not past `limit` (the workspace root).
 *  C++/QML: the HIGHEST CMakeLists.txt in the folder chain (the parent project that add_subdirectory()s the children). */
export function projectRootFor(lang: Lang, file: string, limit: string): string {
  const stop = lower(resolve(limit))
  const chain: string[] = []
  for (let dir = dirname(resolve(file)); lower(dir).startsWith(stop); ) {
    chain.push(dir)
    if (lower(dir) === stop) break
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  if (lang === 'python') {
    // Like VS Code/PET: a folder with a project marker or a child venv (pyvenv.cfg) is a project.
    const hasVenv = (d: string) => { try { return readdirSync(d).some((n) => existsSync(join(d, n, 'pyvenv.cfg'))) } catch { return false } }
    for (const d of chain) if (PROJECT_MARKERS.python.some((m) => existsSync(join(d, m))) || hasVenv(d)) return d
    return resolve(limit)
  }
  // Prefer the nearest dedicated config file (.qmlls.ini/.clangd/compile_commands); otherwise the highest contiguous CMakeLists.txt.
  const strong = lang === 'qml' ? ['.qmlls.ini'] : ['compile_commands.json', '.clangd', 'compile_flags.txt']
  for (const d of chain) if (strong.some((m) => existsSync(join(d, m)))) return d
  let top: string | null = null
  for (const d of chain) {
    if (existsSync(join(d, 'CMakeLists.txt')) || existsSync(join(d, `${d.split(/[\\/]/).pop()}.pro`))) top = d
    else if (top) break
  }
  if (top) return top
  for (const d of chain) if (existsSync(join(d, '.git'))) return d
  return resolve(limit)
}
