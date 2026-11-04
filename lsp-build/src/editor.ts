// LSP editor for Orca (Python / QML / C++): Monaco + a language server via the plugin worker.
// Ctrl+Click / F12 = go to definition; hover = type + docs; Ctrl+Space = completion; red squiggles = errors.
// The language comes from the page's <html data-lang> (python.html / qml.html / cpp.html).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js'
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js'
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError.js'
import 'monaco-editor/esm/vs/editor/contrib/peekView/browser/peekView.js'
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/peek/referencesController.js'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'
import { installTextMate, semanticToken, textMateRules, type Lang } from './textmate'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { IConfigurationService } from 'monaco-editor/esm/vs/platform/configuration/common/configuration.js'
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import type { AttachOutput, CompletionOutput, DefinitionOutput, DiagnosticsOutput, HoverOutput, Pos } from './protocol'

declare const orca: import('orca/frame').OrcaFrameApi

const LANG = (document.documentElement.dataset.lang as Lang) || 'python'
const SERVER = { python: 'Pyright', qml: 'qmlls', cpp: 'clangd' }[LANG]
const MONACO_LANG = LANG

;(self as any).MonacoEnvironment = { getWorker: () => new (EditorWorker as any)() }

const statusEl = document.getElementById('status')!
const setStatus = (text: string, tone: 'ok' | 'warn' | 'err' | 'busy' = 'ok') => {
  statusEl.textContent = text
  statusEl.dataset.tone = tone
}
const req = <T>(name: string, input: unknown, timeoutMs = 20000) => orca.plugin.request(name as any, input as any, { timeoutMs }) as Promise<T>

// Show request errors in the status bar instead of swallowing them silently
const reportError = (e: unknown) => { setStatus('LSP error: ' + (e instanceof Error ? e.message : String(e)).slice(0, 200), 'err'); return null }

/** sha1 of the content (CRLF -> LF), hashed the same way the worker hashes files on disk. */
async function sha1Lf(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text.replace(/\r\n/g, '\n')))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const toPos = (p: monaco.Position): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 })
const toRange = (r: { start: Pos; end: Pos }) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1)

// Follow the Orca theme, the same way Orca themes its own editor (plugin-monaco-theme.ts):
// syntax colors from Monaco vs/vs-dark; background/text/line numbers/cursor/selection/popups from --orca-* variables.
// The frame only receives --orca-* variables, not the plugin theme's tokenColors, so syntax colors stay built-in.
const probe = document.createElement('span')
function cssColor(name: string): string | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw) return null
  probe.style.color = ''
  probe.style.color = raw
  if (!probe.style.color) return null
  if (!probe.isConnected) { probe.style.display = 'none'; document.body.append(probe) }
  const m = getComputedStyle(probe).color.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const [r, g, b, a = '1'] = m[1].split(/[ ,/]+/).filter(Boolean)
  const hex = (v: string | number) => Math.round(Math.min(255, Math.max(0, Number(v)))).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${Number(a) < 1 ? hex(Number(a) * 255) : ''}`
}
const withAlpha = (hexColor: string, alpha: number) => hexColor.slice(0, 7) + Math.round(alpha * 255).toString(16).padStart(2, '0')
let themeSeq = 0

function applyTheme() {
  const dark = document.documentElement.classList.contains('dark')
  const bg = cssColor('--orca-background')
  const fg = cssColor('--orca-foreground')
  if (!bg || !fg || bg.length > 7) {
    const name = `orca-lsp-`+(++themeSeq)
    monaco.editor.defineTheme(name, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: textMateRules(dark ? 'dark' : 'light'), colors: {} })
    monaco.editor.setTheme(name)
    return
  }
  const muted = cssColor('--orca-muted-foreground') ?? fg
  const ring = cssColor('--orca-ring') ?? fg
  const accent = cssColor('--orca-accent')
  const popover = cssColor('--orca-popover')
  const popoverFg = cssColor('--orca-popover-foreground')
  const border = cssColor('--orca-border')
  const colors: Record<string, string> = {
    'editor.background': bg,
    'editor.foreground': fg,
    'editorGutter.background': bg,
    'editorLineNumber.foreground': muted,
    'editorLineNumber.activeForeground': fg,
    'editorCursor.foreground': ring,
    'editor.selectionBackground': withAlpha(ring, 0.3),
    'editor.inactiveSelectionBackground': withAlpha(ring, 0.15),
    'editorStickyScroll.background': bg,
    'peekViewEditor.background': bg,
    'peekViewResult.background': popover ?? bg
  }
  if (accent) colors['editor.lineHighlightBackground'] = accent.slice(0, 7)
  if (popover) {
    for (const k of ['editorWidget.background', 'editorSuggestWidget.background', 'editorHoverWidget.background', 'peekViewTitle.background']) colors[k] = popover
  }
  if (popoverFg) for (const k of ['editorWidget.foreground', 'editorSuggestWidget.foreground', 'editorHoverWidget.foreground']) colors[k] = popoverFg
  if (border) for (const k of ['editorWidget.border', 'editorSuggestWidget.border', 'editorHoverWidget.border', 'peekView.border']) colors[k] = border
  const name = `orca-lsp-${++themeSeq}`
  monaco.editor.defineTheme(name, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: textMateRules(dark ? 'dark' : 'light'), colors })
  monaco.editor.setTheme(name)
  document.body.style.background = bg
}

async function main() {
  // TextMate grammar + Dark+/Light+ theme (as in VS Code); on failure keep Monaco's built-in tokenizer.
  const textMate = installTextMate(LANG)
  const session = await orca.document.session<string>({ debounceMs: 300 })
  await textMate
  const container = document.getElementById('editor')!
  // Unique URI per load: avoids clashing on 'inmemory://model/1' when the frame reloads.
  const mainUri = monaco.Uri.from({ scheme: 'orca-doc', path: '/' + Date.now() + '-' + Math.random().toString(36).slice(2) + ({ python: '.py', qml: '.qml', cpp: '.cpp' } as const)[LANG] })
  const model = monaco.editor.getModel(mainUri) ?? monaco.editor.createModel(session.value, MONACO_LANG, mainUri)
  model.setEOL(session.value.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
  applyTheme()
  orca.on('theme', () => applyTheme())
  const editor = monaco.editor.create(container, {
    model,
    automaticLayout: true,
    readOnly: session.readOnly,
    fontFamily: 'Consolas, "Cascadia Code", ui-monospace, monospace',
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: LANG === 'python' ? 4 : 4,
    insertSpaces: true,
    renderWhitespace: 'selection',
    definitionLinkOpensInPeek: false,
    gotoLocation: { multipleDefinitions: 'goto' }
  })
  // Orca keeps no undo history for custom editors: Monaco handles Ctrl+Z itself.

  let applyingOutside = false
  editor.onDidChangeModelContent(() => {
    if (applyingOutside) return
    session.change(model.getValue())
  })
  session.onReplace((text) => {
    applyingOutside = true
    const view = editor.saveViewState()
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
    if (view) editor.restoreViewState(view)
    applyingOutside = false
  })
  // Do not register 'editor.flush' here: session() already handles Orca saves.
  // Registering it too sends the edit twice at once -> conflict -> "Failed to save the file".

  // --- Host holding the project's code (bottom left): automatic, or pick an SSH host for this project ---
  const hostBtn = document.getElementById('host') as HTMLButtonElement
  const pickerEl = document.getElementById('picker')!
  const pickerFilter = document.getElementById('picker-filter') as HTMLInputElement
  const pickerList = document.getElementById('picker-list')!
  const showHost = (host: string | null, auto: boolean) => {
    hostBtn.hidden = false
    hostBtn.textContent = host ? `⇄ ${host}` : '⇄ This machine'
    hostBtn.title = (host ? `This project's code is on ${host} (SSH)` : 'Code is on the machine running Orca') + (auto ? ' — auto-detected' : ' — selected') + '\nClick to change the host for this project'
  }
  type HostChoice = { project: string; chosen: string | null; hosts: string[] }
  hostBtn.onclick = async () => {
    const c = await req<HostChoice>('lsp.hostChoice', null, 15000).catch(reportError)
    if (!c) return
    const items: { id: string | null; label: string; hint: string }[] = [
      { id: null, label: 'Automatic', hint: 'Search this machine, then every host in ~/.ssh/config; remember the host that has the file' },
      { id: 'local', label: 'This machine', hint: 'Only search the machine running Orca' },
      ...c.hosts.map((h) => ({ id: h, label: h, hint: 'SSH' }))
    ]
    let sel = Math.max(0, items.findIndex((i) => i.id === c.chosen))
    pickerFilter.value = ''
    pickerFilter.placeholder = `Host with the code of "${c.project}" — type to filter, or type user@host and press Enter`
    const render = () => {
      const q = pickerFilter.value.trim().toLowerCase()
      const shown = items.filter((i) => !q || `${i.label} ${i.hint}`.toLowerCase().includes(q))
      if (q && !shown.some((i) => i.label.toLowerCase() === q)) shown.push({ id: pickerFilter.value.trim(), label: pickerFilter.value.trim(), hint: 'Use this SSH host' })
      sel = Math.min(sel, Math.max(0, shown.length - 1))
      pickerList.replaceChildren(...shown.map((i, n) => {
        const row = document.createElement('div')
        row.className = 'pk' + (n === sel ? ' sel' : '')
        const b = document.createElement('b'); b.textContent = (i.id === c.chosen ? '✓ ' : '') + i.label
        const s = document.createElement('small'); s.textContent = i.hint
        row.append(b, s)
        row.onclick = () => void pick(i.id)
        return row
      }))
      return shown
    }
    const pick = async (id: string | null) => {
      pickerEl.hidden = true
      pickerFilter.onkeydown = null; pickerFilter.oninput = null
      setStatus(id && id !== 'local' ? `Connecting to ${id}…` : 'Searching for the file again…', 'busy')
      const r = await req<{ ok: boolean; error?: string }>('lsp.setHost', { host: id }, 120000).catch(reportError)
      if (r && !r.ok) { setStatus(r.error ?? 'Could not connect', 'err'); return }
      location.reload()
    }
    pickerEl.hidden = false
    render()
    pickerFilter.oninput = () => { sel = 0; render() }
    pickerFilter.onkeydown = (ev) => {
      const shown = render()
      if (ev.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); render(); ev.preventDefault() }
      else if (ev.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); ev.preventDefault() }
      else if (ev.key === 'Enter') { if (shown[sel]) void pick(shown[sel].id); ev.preventDefault() }
      else if (ev.key === 'Escape') { pickerEl.hidden = true; ev.preventDefault() }
    }
    pickerFilter.focus()
  }
  void req<HostChoice>('lsp.hostChoice', null, 15000).then((c) => showHost(c.chosen && c.chosen !== 'local' ? c.chosen : null, !c.chosen)).catch(() => showHost(null, true))

  // --- connect to the worker ---
  setStatus('Looking for the file in the workspace…', 'busy')
  // Send a hash instead of the whole file: the plugin channel is limited to ~1 MiB per message (a 19 MB resources_rc.py fails with "message too large").
  const lfText = model.getValue().replace(/\r\n/g, '\n')
  const lfBytes = new TextEncoder().encode(lfText).length
  const lineBreaks = (lfText.match(/\n/g) ?? []).length
  const att = await req<AttachOutput>('lsp.attach', { language: LANG, hash: await sha1Lf(lfText), size: lfBytes, sizeCrlf: lfBytes + lineBreaks }, 90000).catch((e) => ({ ok: false, path: null, candidates: 0, workspace: null, server: null, message: String(e) }) as AttachOutput)
  if (!att.path) { setStatus(att.message ?? 'Could not attach LSP', 'err'); return }
  const path = att.path
  // File on another host (via SSH): the worker returns the path as "@<host>:<path>"
  const remoteHost = /^@([^:]+):/.exec(path)?.[1]
  const rel = att.workspace ? path.slice(att.workspace.length + 1).replace(/\\/g, '/') : path
  showHost(remoteHost ?? null, true)
  if (!att.ok) { setStatus(`${rel}: ${att.message}`, 'err'); return }
  setStatus(`${SERVER} • ${rel}${att.server && att.server.includes('(') ? ' • ' + att.server.slice(att.server.indexOf('(') + 1, -1) : ''}${att.candidates > 1 ? ` • ⚠ ${att.candidates} files with identical content, may be the wrong one` : ''}`, att.candidates > 1 ? 'warn' : 'ok')

  let version = 1
  // Small file: send the content; large file: the worker reads it from disk (on open, editor content = disk content).
  const SMALL = 400_000
  const openText = model.getValue()
  await req('lsp.open', openText.length <= SMALL ? { path, text: openText, version } : { path, version })
  /** Resend the whole content in chunks (when the worker's copy is out of sync). */
  const resyncFull = async () => {
    const t = model.getValue()
    const v = ++version
    if (t.length <= SMALL) { await req('lsp.change', { path, text: t, version: v }); return }
    const CH = 300_000
    const total = Math.ceil(t.length / CH)
    for (let i = 0; i < total; i++) await req('lsp.upload', { path, version: v, part: t.slice(i * CH, (i + 1) * CH), index: i, total }, 60000)
  }

  const semEmitter = new monaco.Emitter<void>()

  // --- Interpreter: shown in the status bar, click to pick (like VS Code's "Select Interpreter") ---
  type Interp = { path: string; label: string; version: string | null; source: string; envDir: string | null }
  const SOURCE_LABEL: Record<string, string> = { saved: 'selected', setting: 'setting', vscode: '.vscode', pyright: 'pyrightconfig', venv: 'project venv', env: 'activated', global: 'installed' }
  const interpBtn = document.getElementById('interp') as HTMLButtonElement
  const picker = document.getElementById('picker')!
  const filterEl = document.getElementById('picker-filter') as HTMLInputElement
  const listEl = document.getElementById('picker-list')!
  let interps: Interp[] = []
  let current: Interp | null = null
  let selIndex = 0
  const showInterp = () => {
    interpBtn.hidden = false
    interpBtn.textContent = current ? `🐍 ${current.label}` : '🐍 Select interpreter'
    interpBtn.title = current ? `${current.path}\nWhy: ${(current as any).reason ?? SOURCE_LABEL[current.source] ?? current.source}\nClick to change (or Ctrl+Shift+P → Python: Select Interpreter)` : 'Python not found: click to select'
  }
  const loadInterps = async () => {
    const r = await req<{ current: Interp | null; list: Interp[] }>('lsp.interpreters', { path }, 30000).catch(reportError)
    if (!r) return
    interps = r.list
    current = r.current
    showInterp()
  }
  const renderPicker = () => {
    const q = filterEl.value.trim().toLowerCase()
    const shown = [{ path: '', label: 'Select automatically', version: null, source: 'auto', envDir: null } as Interp, ...interps]
      .filter((i) => !q || `${i.label} ${i.path}`.toLowerCase().includes(q))
    selIndex = Math.min(selIndex, Math.max(0, shown.length - 1))
    listEl.replaceChildren(...shown.map((i, n) => {
      const row = document.createElement('div')
      row.className = 'pk' + (n === selIndex ? ' sel' : '')
      row.setAttribute('role', 'option')
      const isCur = !!current && i.path.toLowerCase() === current.path.toLowerCase()
      row.innerHTML = ''
      const b = document.createElement('b'); b.textContent = (isCur ? '✓ ' : '') + i.label
      const s = document.createElement('small'); s.textContent = i.path || 'Like VS Code: selected → .vscode → project venv (highest Python) → highest installed Python'
      const t = document.createElement('i'); t.textContent = i.source === 'auto' ? '' : (SOURCE_LABEL[i.source] ?? i.source)
      row.append(b, s, t)
      row.onclick = () => choose(i)
      return row
    }))
    return shown
  }
  const closePicker = () => { picker.hidden = true; editor.focus() }
  const choose = async (i: Interp) => {
    closePicker()
    setStatus('Switching interpreter…', 'busy')
    const r = await req<{ current: Interp | null }>('lsp.setInterpreter', { path, interpreter: i.path || null }, 30000).catch(reportError)
    if (!r) return
    current = r.current
    showInterp()
    setStatus(`${SERVER} • ${rel} • ${current ? current.label : 'no interpreter'}`, 'ok')
    semEmitter.fire()
  }
  interpBtn.onclick = async () => {
    await loadInterps()
    filterEl.placeholder = 'Select a Python interpreter (type to filter)…'
    filterEl.oninput = () => { selIndex = 0; renderPicker() }
    filterEl.onkeydown = interpKeys
    filterEl.value = ''
    selIndex = 0
    picker.hidden = false
    renderPicker()
    filterEl.focus()
  }
  filterEl.oninput = () => { selIndex = 0; renderPicker() }
  const interpKeys = (e: KeyboardEvent) => {
    const shown = renderPicker()
    if (e.key === 'ArrowDown') { selIndex = Math.min(selIndex + 1, shown.length - 1); renderPicker(); e.preventDefault() }
    else if (e.key === 'ArrowUp') { selIndex = Math.max(selIndex - 1, 0); renderPicker(); e.preventDefault() }
    else if (e.key === 'Enter') { if (shown[selIndex]) void choose(shown[selIndex]); e.preventDefault() }
    else if (e.key === 'Escape') { closePicker(); e.preventDefault() }
  }
  filterEl.onkeydown = interpKeys
  const restartServer = async () => {
    setStatus(`Restarting ${SERVER}…`, 'busy')
    const r = await req<{ detail: string }>('lsp.restart', { path }, 90000).catch(reportError)
    if (!r) return
    await resyncFull()
    setStatus(`${SERVER} • ${rel} • ${r.detail}`, 'ok')
    if (LANG !== 'python') { interpBtn.textContent = `⚙ ${SERVER}`; interpBtn.title = `${r.detail}\nClick to restart ${SERVER} (after a CMake configure)` }
    semEmitter.fire()
  }
  editor.addAction({ id: 'qt-lsp.restart', label: `${SERVER}: Restart Language Server`, run: () => restartServer() })
  if (LANG === 'python') {
    editor.addAction({ id: 'qt-lsp.selectInterpreter', label: 'Python: Select Interpreter', run: () => interpBtn.click() })
    void loadInterps()
  } else {
    // QML / C++: button shows server + build dir; click = restart the server (e.g. after generating compile_commands.json)
    interpBtn.hidden = false
    interpBtn.textContent = `⚙ ${SERVER}`
    interpBtn.onclick = () => restartServer()
    void req<{ detail: string }>('lsp.serverInfo', { path }).then((i) => { interpBtn.title = `${i.detail}\nClick to restart ${SERVER} (after a CMake configure)` }).catch(() => {})
  }
  // Batch changes per Monaco event and send them as edits (not the whole file): large files stay under the message limit.
  // Per event, offsets refer to the content before that event; events are sent in order so the worker applies them in sequence.
  type Edit = { offset: number; length: number; text: string }
  let pendingEvents: Edit[][] = []
  let pendingBytes = 0
  let sending: Promise<void> = Promise.resolve()
  let changeTimer: ReturnType<typeof setTimeout> | undefined
  model.onDidChangeContent((ev) => {
    const edits = ev.changes.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }))
    pendingEvents.push(edits)
    pendingBytes += edits.reduce((n, e) => n + e.text.length, 0)
    clearTimeout(changeTimer)
    changeTimer = setTimeout(() => { void flushChange() }, 200)
  })
  const sendPending = async () => {
    const events = pendingEvents
    const big = pendingBytes > 400_000
    pendingEvents = []
    pendingBytes = 0
    if (!events.length) return
    // Large paste/replace (e.g. file reload): resend the whole file in chunks
    if (big) { await resyncFull(); return }
    for (const edits of events) {
      const r = await req<{ ok: boolean; resync?: boolean }>('lsp.change', { path, edits, version: ++version, expectLength: undefined }).catch(() => ({ ok: false, resync: true }))
      if (!r.ok) { await resyncFull(); return }
    }
  }
  const flushChange = async () => {
    if (changeTimer) { clearTimeout(changeTimer); changeTimer = undefined }
    sending = sending.then(sendPending, sendPending)
    await sending
  }
  window.addEventListener('beforeunload', () => { void req('lsp.close', { path }) })

  // Only serve this editor's model (library peek models have their own URIs).
  const isMine = (m: monaco.editor.ITextModel) => m === model

  monaco.languages.registerHoverProvider(MONACO_LANG, {
    async provideHover(m, position) {
      if (!isMine(m)) return null
      await flushChange()
      const h = await req<HoverOutput>('lsp.hover', { path, position: toPos(position) }).catch(reportError)
      if (!h?.markdown) return null
      return { contents: [{ value: h.markdown }], range: h.range ? toRange(h.range) : undefined }
    }
  })

  // Definitions:
  //  - same file: Monaco jumps within the editor;
  //  - another file in the workspace: open an Orca tab for it (Orca cannot select a line yet, so the line is shown in the status bar);
  //  - libraries (site-packages, typeshed): open a read-only model and show a peek inside this editor.
  monaco.languages.registerDefinitionProvider(MONACO_LANG, {
    async provideDefinition(m, position) {
      if (!isMine(m)) return null
      await flushChange()
      const d = await req<DefinitionOutput>('lsp.definition', { path, position: toPos(position) }).catch(reportError)
      if (!d?.locations.length) return null
      const out: monaco.languages.Location[] = []
      for (const loc of d.locations) {
        if (sameFile(loc.path, path)) { out.push({ uri: model.uri, range: toRange(loc.range) }); continue }
        // Monaco needs a real model for every target (even when we open an Orca tab ourselves), otherwise "Model not found".
        // Openable as an Orca tab (file in the workspace, including the project's venv/site-packages) -> orca-ws; otherwise peek
        const toTab = loc.openable ?? loc.inWorkspace
        const scheme = toTab ? 'orca-ws' : 'orca-lib'
        // Large files only send a window of lines: one model per ~2000-line region (query w=) so jumps elsewhere still have content
        const uri = monaco.Uri.from({ scheme, path: '/' + loc.path.replace(/\\/g, '/'), query: `w=${Math.floor(loc.range.start.line / 2000)}` })
        let target = monaco.editor.getModel(uri)
        if (!target) {
          const r = await req<{ text?: string }>('lsp.peek', { path: loc.path, line: loc.range.start.line }).catch(() => null)
          const peekLang = /\.pyi?$/i.test(loc.path) ? 'python' : /\.qml$/i.test(loc.path) ? 'qml' : 'cpp'
          target = monaco.editor.getModel(uri) ?? monaco.editor.createModel(r?.text ?? '', peekLang, uri)
          if (peekLang !== LANG) void installTextMate(peekLang as Lang)
        }
        if (toTab) pendingReveal = loc
        out.push({ uri, range: toRange(loc.range) })
      }
      return out
    }
  })
  let pendingReveal: { path: string; range: { start: Pos } } | null = null

  // The standalone editor cannot open other models: intercept to open an Orca tab (workspace) or a peek (library).
  const editorService = (editor as any)._codeEditorService
  if (editorService?.openCodeEditor) {
    const original = editorService.openCodeEditor.bind(editorService)
    editorService.openCodeEditor = async (input: any, source: any, sideBySide: any) => {
      const target = input.resource as monaco.Uri
      if (target.toString() === model.uri.toString()) return original(input, source, sideBySide)
      if (target.scheme === 'orca-ws' && pendingReveal) {
        const loc = pendingReveal
        pendingReveal = null
        const r = await req<{ opened: boolean; rel?: string }>('lsp.reveal', { path: loc.path, line: loc.range.start.line + 1 }).catch(reportError)
        if (r?.opened) { setStatus(`Opened ${r.rel}, line ${loc.range.start.line + 1}`, 'ok'); return null }
        // Could not open a tab (e.g. older Orca, outside the workspace): peek in place
        editor.trigger('lsp', 'editor.action.peekDefinition', null)
        return null
      }
      if (target.scheme === 'orca-lib') {
        editor.trigger('lsp', 'editor.action.peekDefinition', null)
        return null
      }
      return null
    }
  }
  // Semantic tokens (basedpyright): color classes/functions/variables/modules by meaning, like Pylance in VS Code.
  // The legend given to Monaco is a list of theme selectors; each server token is mapped to one of them.
  const semLegendTokens: string[] = ['']
  const semIndex = new Map<string, number>([['', 0]])
  const semIndexOf = (token: string) => {
    let i = semIndex.get(token)
    if (i === undefined) { i = semLegendTokens.length; semLegendTokens.push(token); semIndex.set(token, i) }
    return i
  }
  for (const t of ['entity.name.namespace', 'entity.name.type', 'support.class', 'entity.name.function', 'variable', 'variable.parameter', 'variable.other.constant', 'variable.language', 'support.function', 'support.type']) semIndexOf(t)
  // Standalone Monaco disables semantic tokens by default (theme.semanticHighlighting=false): enable via configuration.
  // 'editor.semanticHighlighting' is read from configurationService, not from the editor options.
  try {
    const cfg = StandaloneServices.get(IConfigurationService) as any
    cfg.updateValues([['editor.semanticHighlighting', { enabled: true }]])
  } catch (e) { console.warn('[qt-lsp] cannot enable semantic highlighting', e) }
  monaco.languages.registerDocumentSemanticTokensProvider(MONACO_LANG, {
    onDidChange: semEmitter.event,
    getLegend: () => ({ tokenTypes: semLegendTokens, tokenModifiers: [] }),
    async provideDocumentSemanticTokens(m) {
      if (!isMine(m)) return null
      await flushChange()
      const r = await req<{ legend: { tokenTypes: string[]; tokenModifiers: string[] } | null; data: number[] }>('lsp.semanticTokens', { path }).catch(() => null)
      if (!r?.legend || !r.data.length) return null
      const out = new Uint32Array(r.data.length)
      for (let i = 0; i < r.data.length; i += 5) {
        const type = r.legend.tokenTypes[r.data[i + 3]] ?? ''
        const mods = r.legend.tokenModifiers.filter((_, b) => r.data[i + 4] & (1 << b))
        out[i] = r.data[i]; out[i + 1] = r.data[i + 1]; out[i + 2] = r.data[i + 2]
        out[i + 3] = semIndexOf(semanticToken(type, mods))
        out[i + 4] = 0
      }
      return { data: out }
    },
    releaseDocumentSemanticTokens() {}
  })
  // The legend can gain new tokens at runtime: tell Monaco to refetch after the first pass.
  setTimeout(() => semEmitter.fire(), 1500)
  orca.plugin.on('lsp.diagnostics' as any, () => semEmitter.fire())

  monaco.languages.registerCompletionItemProvider(MONACO_LANG, {
    triggerCharacters: LANG === 'cpp' ? ['.', '>', ':', '"', '<', '/'] : LANG === 'qml' ? ['.', ':'] : ['.', '(', ',', ' '],
    async provideCompletionItems(m, position, context) {
      if (!isMine(m)) return { suggestions: [] }
      await flushChange()
      const c = await req<CompletionOutput>('lsp.completion', { path, position: toPos(position), trigger: context.triggerCharacter }).catch(reportError)
      const word = m.getWordUntilPosition(position)
      const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      // clangd/qmlls return a textEdit range (e.g. replacing the whole "->"): use it when present
      const rangeOf = (r?: { start: Pos; end: Pos }) => (r ? toRange(r) : wordRange)
      return {
        incomplete: c?.incomplete,
        suggestions: (c?.items ?? []).map((it) => ({
          label: it.label,
          kind: lspKind(it.kind),
          detail: it.detail,
          documentation: it.documentation ? { value: it.documentation } : undefined,
          insertText: it.insertText ?? it.label,
          sortText: it.sortText,
          filterText: it.filterText,
          range: rangeOf(it.range)
        }))
      }
    }
  })

  orca.plugin.on('lsp.diagnostics' as any, (p: any) => {
    if (!sameFile(p.path, path)) return
    applyDiagnostics(p as DiagnosticsOutput)
  })
  function applyDiagnostics(d: DiagnosticsOutput) {
    monaco.editor.setModelMarkers(model, SERVER, d.items.map((x) => ({
      ...toRangeObj(x.range),
      severity: x.severity === 1 ? monaco.MarkerSeverity.Error : x.severity === 2 ? monaco.MarkerSeverity.Warning : x.severity === 3 ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Hint,
      message: x.message,
      source: x.source ?? SERVER,
      code: x.code !== undefined ? String(x.code) : undefined
    })))
    const errs = d.items.filter((x) => x.severity === 1).length
    const warns = d.items.filter((x) => x.severity === 2).length
    if (statusEl.dataset.tone !== 'err') setStatus(`${SERVER} • ${rel} • ${errs} errors, ${warns} warnings`, errs ? 'warn' : 'ok')
  }
  void req<DiagnosticsOutput>('lsp.diagnostics', { path }).then(applyDiagnostics).catch(() => {})
  editor.focus()
}

const toRangeObj = (r: { start: Pos; end: Pos }) => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 })
const sameFile = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const shortName = (p: string) => p.split(/[\\/]/).pop()

function lspKind(k: number): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module,
    10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference,
    19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter
  }
  return map[k] ?? K.Text
}

main().catch((e) => setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'err'))
