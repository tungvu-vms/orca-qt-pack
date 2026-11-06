// Language-specific process discovery and launch configuration; no server is started here.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { installPyright } from './pyright-install'
import {
  findBuildDirs,
  findClangd,
  findQmlls,
  compilationDatabaseDir,
  type Lang
} from './servers'
declare const __LSP_LANGUAGE__: Lang | 'all'
const WIN = process.platform === 'win32'
export interface AdapterContext {
  setting<T>(key: string, fallback: T): Promise<T>
  pluginDir(): string
  log(message: string): void
  installPyright?(): Promise<string | null>
}
function findNode(): string {
  const exe = WIN ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(
    WIN ? ';' : ':'
  ))
    if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  for (const c of WIN
    ? ['C:\\Program Files\\nodejs\\node.exe']
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'])
    if (existsSync(c)) return c
  return process.execPath
}
/** Where basedpyright is auto-installed on this machine: %LOCALAPPDATA%orca-qt-lsp (Windows), ~/.local/share/orca-qt-lsp (macOS/Linux). */
function pyrightPrefix(): string {
  const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return join(
    process.env.LOCALAPPDATA ??
      (WIN ? join(h, 'AppData', 'Local') : join(h, '.local', 'share')),
    'orca-qt-lsp'
  )
}
function pyrightEntry(pluginDir: () => string): string | null {
  const h = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const local =
    process.env.LOCALAPPDATA ??
    (WIN ? join(h, 'AppData', 'Local') : join(h, '.local', 'share'))
  const appData =
    process.env.APPDATA ?? (WIN ? join(h, 'AppData', 'Roaming') : undefined)
  const c = [
    join(pluginDir(), 'server', 'pyright', 'langserver.index.js'),
    join(
      local,
      'orca-qt-lsp',
      'node_modules',
      'basedpyright',
      'langserver.index.js'
    )
  ]
  if (appData)
    c.push(
      join(
        appData,
        'npm',
        'node_modules',
        'basedpyright',
        'langserver.index.js'
      ),
      join(appData, 'npm', 'node_modules', 'pyright', 'langserver.index.js')
    )
  for (const p of ['/usr/local', '/opt/homebrew', join(h, '.npm-global')])
    c.push(
      join(p, 'lib', 'node_modules', 'basedpyright', 'langserver.index.js'),
      join(p, 'lib', 'node_modules', 'pyright', 'langserver.index.js')
    )
  return c.find((p) => existsSync(p)) ?? null
}

/** Command that runs the server for (lang, root). Throws (shown in the status bar) when the program is missing. */
export async function serverCommand(
  lang: Lang,
  root: string,
  context: AdapterContext
): Promise<{
  cmd: string
  args: string[]
  env?: NodeJS.ProcessEnv
  detail: string
}> {
  const { setting } = context
  if (
    lang === 'python' &&
    (typeof __LSP_LANGUAGE__ === 'undefined' ||
      __LSP_LANGUAGE__ === 'all' ||
      __LSP_LANGUAGE__ === 'python')
  ) {
    const entry =
      (await setting('pyrightPath', '')) ||
      pyrightEntry(context.pluginDir) ||
      (await (context.installPyright
        ? context.installPyright()
        : installPyright(pyrightPrefix(), findNode(), context.log)))
    if (!entry)
      throw new Error(
        `basedpyright/Pyright not found on this ${process.platform} machine. Install it (needs Node.js 18+ with npm): npm i --prefix ${WIN ? '"%LOCALAPPDATA%\\orca-qt-lsp"' : '~/.local/share/orca-qt-lsp'} basedpyright@1.40.2`
      )
    const node = (await setting('nodePath', '')) || findNode()
    return {
      cmd: node,
      args: [entry, '--stdio'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detail: entry.includes('basedpyright') ? 'basedpyright' : 'pyright'
    }
  }
  if (
    lang === 'qml' &&
    (typeof __LSP_LANGUAGE__ === 'undefined' ||
      __LSP_LANGUAGE__ === 'all' ||
      __LSP_LANGUAGE__ === 'qml')
  ) {
    const qmlls = findQmlls(
      await setting('qmllsPath', ''),
      await setting('qtBin', '')
    )
    if (!qmlls)
      throw new Error(
        'qmlls (Qt 6.4+) not found. Set "qmlls path" or "Qt bin folder" in the plugin Settings.'
      )
    const args: string[] = []
    const builds = findBuildDirs(root, 'qml')
    for (const b of builds.slice(0, 1)) args.push('-b', b)
    // Qt's QML module folder next to qmlls (when qmlls lives outside the kit's bin)
    const qmlDir = join(dirname(dirname(qmlls)), 'qml')
    if (existsSync(qmlDir)) args.push('-I', qmlDir)
    return {
      cmd: qmlls,
      args,
      detail: builds[0]
        ? `build: ${builds[0].slice(root.length + 1) || '.'}`
        : 'no build folder yet (run CMake configure so qmlls can see the project modules)'
    }
  }
  if (
    lang !== 'cpp' ||
    !(
      typeof __LSP_LANGUAGE__ === 'undefined' ||
      __LSP_LANGUAGE__ === 'all' ||
      __LSP_LANGUAGE__ === 'cpp'
    )
  )
    throw new Error('Unsupported language adapter')
  const clangd = findClangd(await setting('clangdPath', ''))
  if (!clangd)
    throw new Error(
      'clangd not found. Install LLVM or Qt Creator, or set "clangd path" in Settings.'
    )
  const args = [
    '--background-index',
    '--clang-tidy=false',
    '--header-insertion=never',
    '--completion-style=detailed',
    '--log=error',
    '--pch-storage=memory'
  ]
  const cc = compilationDatabaseDir(
    root,
    await setting('compilationDatabase', '')
  )
  if (cc) args.push(`--compile-commands-dir=${cc}`)
  // clangd runs the compiler named in compile_commands.json to read its system include paths. Allow only
  // compilers from toolchain install folders, never one inside the opened project (a cloned repo could
  // point compile_commands.json at its own "compiler").
  const drivers = WIN
    ? [
        'C:/Qt/Tools/**/bin/*.exe',
        'C:/Program Files/LLVM/bin/*.exe',
        'C:/Program Files/Microsoft Visual Studio/**/bin/**/cl.exe',
        'C:/Program Files (x86)/Microsoft Visual Studio/**/bin/**/cl.exe',
        'C:/msys64/*/bin/*.exe',
        'C:/mingw*/bin/*.exe'
      ]
    : [
        '/usr/bin/*',
        '/usr/local/bin/*',
        '/opt/homebrew/bin/*',
        '/opt/homebrew/opt/llvm/bin/*',
        '/Library/Developer/CommandLineTools/usr/bin/*',
        '/Applications/Xcode*.app/Contents/Developer/Toolchains/**/bin/*',
        `${homedir()}/Qt/Tools/**/bin/*`
      ]
  const extra = String(await setting('compilerGlobs', ''))
    .split(/[;,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
  args.push(`--query-driver=${[...drivers, ...extra].join(',')}`)
  return {
    cmd: clangd,
    args,
    detail: cc
      ? `compile_commands: ${cc}`
      : 'no compile_commands.json (configure your build system, use .clangd or compile_flags.txt)'
  }
}
