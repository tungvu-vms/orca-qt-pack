// Worker cua Qt Developer Tools: quet du an, chay cong cu Qt trong terminal cua workspace, qmlformat khi luu.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_NAMES, ToolMissing, buildCommand, findPython, findTool, scanProject, type CommandContext } from './qt'
import type { ProjectInfo, QtAction } from './protocol'

interface Workspace { id: string; name: string; path: string; branch: string | null }

async function setting<T>(orca: OrcaWorkerApi, key: string, fallback: T): Promise<T> {
  try {
    const v = await orca.settings.get(key)
    return (v === undefined || v === null ? fallback : v) as T
  } catch { return fallback }
}

/** Workspace dang focus: readContext cho ten + branch, workspace.list cho id + duong dan. */
async function focusedWorkspace(orca: OrcaWorkerApi): Promise<Workspace | null> {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx) return null
  const { workspaces } = await orca.host.call('workspace.list', {})
  const local = workspaces.filter((w) => !w.hostId)
  const pool = local.length ? local : workspaces
  const match = pool.find((w) => w.name === ctx.displayName && (w.branch ?? '') === (ctx.branch ?? ''))
    ?? pool.find((w) => w.name === ctx.displayName)
  return match ? { id: match.id, name: match.name, path: match.path, branch: match.branch } : null
}

async function toolContext(orca: OrcaWorkerApi, root: string): Promise<Omit<CommandContext, 'path'>> {
  const qtBin = await setting(orca, 'qtBin', '')
  const tools: Record<string, string | null> = {}
  for (const t of TOOL_NAMES) tools[t] = findTool(t, qtBin)
  return {
    root,
    tools,
    binding: await setting(orca, 'binding', 'pyside6'),
    python: findPython(root, await setting(orca, 'python', '')),
    cmakeGenerator: await setting(orca, 'cmakeGenerator', 'Ninja'),
    cmakeBuildType: await setting(orca, 'cmakeBuildType', 'Debug')
  }
}

const TITLES: Record<QtAction, string> = {
  designer: 'Qt Designer', uic: 'uic', rcc: 'rcc', qmllint: 'qmllint', qmlformat: 'qmlformat',
  'qml-preview': 'QML preview', lupdate: 'lupdate', lrelease: 'lrelease', linguist: 'Linguist', open: 'open',
  'cmake-configure': 'CMake configure', 'cmake-build': 'CMake build', qmake: 'qmake', 'run-python': 'Run'
}

async function run(orca: OrcaWorkerApi, action: QtAction, path?: string): Promise<{ ok: boolean; message: string }> {
  const ws = await focusedWorkspace(orca)
  if (!ws) return { ok: false, message: 'Chưa chọn workspace nào trong Orca.' }
  if (action === 'open') {
    if (!path) return { ok: false, message: 'Thiếu file' }
    await orca.host.call('editor.open', { workspaceId: ws.id, path })
    return { ok: true, message: `Đã mở ${path}` }
  }
  let command: string | null
  try {
    command = buildCommand(action, { ...(await toolContext(orca, ws.path)), path })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (e instanceof ToolMissing) void orca.host.call('notifications.show', { title: 'Qt Tools', body: message }).catch(() => {})
    return { ok: false, message }
  }
  if (!command) return { ok: false, message: 'Hành động không có lệnh' }
  const title = path ? `${TITLES[action]}: ${path.split('/').pop()}` : TITLES[action]
  await orca.host.call('terminal.create', { workspaceId: ws.id, title, command })
  orca.log(`[${ws.name}] ${command}`)
  return { ok: true, message: `Đang chạy: ${command}` }
}

async function runAll(orca: OrcaWorkerApi, action: QtAction, kind: 'ui' | 'qrc' | 'qml' | 'ts'): Promise<string> {
  const ws = await focusedWorkspace(orca)
  if (!ws) return 'Chưa chọn workspace nào trong Orca.'
  const { files } = scanProject(ws.path)
  const targets = files.filter((f) => f.kind === kind)
  if (!targets.length) return `Không có file .${kind} nào trong ${ws.name}.`
  let ctx: Omit<CommandContext, 'path'>
  try { ctx = await toolContext(orca, ws.path) } catch (e) { return String(e) }
  const lines: string[] = []
  try {
    for (const f of targets) {
      const c = buildCommand(action, { ...ctx, path: f.path })
      if (c) lines.push(c)
    }
  } catch (e) { return e instanceof Error ? e.message : String(e) }
  const sepr = process.platform === 'win32' ? '; ' : ' && '
  await orca.host.call('terminal.create', { workspaceId: ws.id, title: `${TITLES[action]} (${targets.length} file)`, command: lines.join(sepr) })
  return `Đang chạy ${TITLES[action]} cho ${targets.length} file.`
}

/** qmlformat cho van ban dang luu. Phai xong duoi 2 giay, loi thi bo qua (luu nguyen ban). */
function formatQml(qmlformat: string, text: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'orca-qmlfmt-'))
  try {
    const file = join(dir, 'file.qml')
    writeFileSync(file, text, 'utf8')
    const out = execFileSync(qmlformat, [file], { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (!out || !out.trim()) return null
    // qmlformat tren Windows tra CRLF: giu kieu xuong dong cua file goc
    const lf = out.replace(/\r\n/g, '\n')
    return text.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  // qmlformat tim mot lan, lam lai khi setting doi
  let qmlformat: string | null | undefined
  let formatOnSave = true
  const refresh = async () => {
    qmlformat = findTool('qmlformat', await setting(orca, 'qtBin', ''))
    formatOnSave = await setting(orca, 'formatQmlOnSave', true)
  }
  void refresh()
  orca.settings.onDidChange(() => { void refresh() })

  orca.hooks.on('editor.save.before', (event, next) => {
    if (!formatOnSave || !qmlformat || !/\.qml$/i.test(event.path)) return undefined
    const formatted = formatQml(qmlformat, event.text)
    if (formatted === null || formatted === event.text) return undefined
    return next({ ...event, text: formatted })
  })

  orca.panels.handle('qt.scan', async (): Promise<ProjectInfo> => {
    const ws = await focusedWorkspace(orca)
    if (!ws) return { workspaceId: null, workspaceName: null, root: null, files: [], truncated: false, tools: {}, binding: '', python: null }
    const { files, truncated } = scanProject(ws.path)
    const ctx = await toolContext(orca, ws.path)
    return { workspaceId: ws.id, workspaceName: ws.name, root: ws.path, files, truncated, tools: ctx.tools, binding: ctx.binding, python: ctx.python }
  })
  orca.panels.handle('qt.run', async ({ action, path }) => run(orca, action, path))

  const msg = (r: { message: string }) => r.message
  orca.commands.register('qt.designer', async () => msg(await run(orca, 'designer')))
  orca.commands.register('qt.cmake.configure', async () => msg(await run(orca, 'cmake-configure')))
  orca.commands.register('qt.cmake.build', async () => msg(await run(orca, 'cmake-build')))
  orca.commands.register('qt.qmllint.all', async () => runAll(orca, 'qmllint', 'qml'))
  orca.commands.register('qt.uic.all', async () => runAll(orca, 'uic', 'ui'))
  orca.commands.register('qt.rcc.all', async () => runAll(orca, 'rcc', 'qrc'))
  orca.commands.register('qt.lupdate', async () => {
    const ws = await focusedWorkspace(orca)
    if (!ws) return 'Chưa chọn workspace nào trong Orca.'
    const pro = scanProject(ws.path).files.find((f) => f.kind === 'pro')
    return pro ? msg(await run(orca, 'lupdate', pro.path)) : runAll(orca, 'lupdate', 'ts')
  })
  orca.commands.register('qt.doctor', async () => {
    const qtBin = await setting(orca, 'qtBin', '')
    const lines = TOOL_NAMES.map((t) => `${t.padEnd(10)} ${findTool(t, qtBin) ?? '— không thấy'}`)
    const ws = await focusedWorkspace(orca).catch(() => null)
    if (ws) lines.push(`python     ${findPython(ws.path, await setting(orca, 'python', '')) ?? 'python (PATH)'}`)
    return lines.join('\n')
  })
}
