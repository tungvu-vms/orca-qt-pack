// Editor LSP cho Orca (Python / QML / C++): Monaco + language server qua worker cua plugin.
// Ctrl+Click / F12 = di toi dinh nghia; re chuot = kieu + tai lieu; Ctrl+Space = goi y; gach do = loi.
// Ngon ngu lay tu <html data-lang> cua trang (python.html / qml.html / cpp.html).
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

// Hien loi yeu cau len thanh trang thai thay vi nuot im lang
const reportError = (e: unknown) => { setStatus('Lỗi LSP: ' + (e instanceof Error ? e.message : String(e)).slice(0, 200), 'err'); return null }

/** sha1 cua noi dung (CRLF -> LF), cung cach worker bam file tren dia. */
async function sha1Lf(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text.replace(/\r\n/g, '\n')))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const toPos = (p: monaco.Position): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 })
const toRange = (r: { start: Pos; end: Pos }) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1)

// Theme theo Orca, giong cach Orca tu dung cho editor cua no (plugin-monaco-theme.ts):
// mau cu phap cua Monaco vs/vs-dark, con nen/chu/so dong/con tro/vung chon/popup lay tu bien --orca-*.
// Frame chi nhan bien --orca-*, khong nhan tokenColors cua theme plugin, nen mau cu phap giu ban dung san.
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
  // Grammar TextMate + theme Dark+/Light+ (giong VS Code); loi thi giu tokenizer co san cua Monaco.
  const textMate = installTextMate(LANG)
  const session = await orca.document.session<string>({ debounceMs: 300 })
  await textMate
  const container = document.getElementById('editor')!
  // URI rieng moi lan nap: tranh trung 'inmemory://model/1' khi frame nap lai.
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
  // Orca khong giu undo cho custom editor: Monaco tu lo Ctrl+Z.

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
  // Khong dang ky 'editor.flush' o day: session() da tu xu ly khi Orca luu.
  // Dang ky them lam gui ban sua 2 lan cung luc -> xung dot -> "Failed to save the file".

  // --- noi voi worker ---
  setStatus('Đang tìm file trong workspace…', 'busy')
  // Gui ma bam thay cho ca file: kenh plugin gioi han ~1 MiB/tin (file resources_rc.py 19 MB se loi "message too large").
  const lfText = model.getValue().replace(/\r\n/g, '\n')
  const lfBytes = new TextEncoder().encode(lfText).length
  const lineBreaks = (lfText.match(/\n/g) ?? []).length
  const att = await req<AttachOutput>('lsp.attach', { language: LANG, hash: await sha1Lf(lfText), size: lfBytes, sizeCrlf: lfBytes + lineBreaks }, 90000).catch((e) => ({ ok: false, path: null, candidates: 0, workspace: null, server: null, message: String(e) }) as AttachOutput)
  if (!att.path) { setStatus(att.message ?? 'Không gắn được LSP', 'err'); return }
  const path = att.path
  const rel = att.workspace ? path.slice(att.workspace.length + 1).replace(/\\/g, '/') : path
  if (!att.ok) { setStatus(`${rel}: ${att.message}`, 'err'); return }
  setStatus(`${SERVER} • ${rel}${att.server && att.server.includes('(') ? ' • ' + att.server.slice(att.server.indexOf('(') + 1, -1) : ''}${att.candidates > 1 ? ` • ⚠ ${att.candidates} file trùng nội dung, có thể nhận nhầm` : ''}`, att.candidates > 1 ? 'warn' : 'ok')

  let version = 1
  // File nho: gui noi dung; file lon: worker doc tu dia (luc mo, noi dung editor = noi dung tren dia).
  const SMALL = 400_000
  const openText = model.getValue()
  await req('lsp.open', openText.length <= SMALL ? { path, text: openText, version } : { path, version })
  /** Gui lai ca noi dung theo doan (khi ban sao cua worker lech). */
  const resyncFull = async () => {
    const t = model.getValue()
    const v = ++version
    if (t.length <= SMALL) { await req('lsp.change', { path, text: t, version: v }); return }
    const CH = 300_000
    const total = Math.ceil(t.length / CH)
    for (let i = 0; i < total; i++) await req('lsp.upload', { path, version: v, part: t.slice(i * CH, (i + 1) * CH), index: i, total }, 60000)
  }

  const semEmitter = new monaco.Emitter<void>()

  // --- Interpreter: hien o thanh trang thai, bam de chon (giong "Select Interpreter" cua VS Code) ---
  type Interp = { path: string; label: string; version: string | null; source: string; envDir: string | null }
  const SOURCE_LABEL: Record<string, string> = { saved: 'đã chọn', setting: 'setting', vscode: '.vscode', pyright: 'pyrightconfig', venv: 'venv dự án', env: 'đang kích hoạt', global: 'cài đặt' }
  const interpBtn = document.getElementById('interp') as HTMLButtonElement
  const picker = document.getElementById('picker')!
  const filterEl = document.getElementById('picker-filter') as HTMLInputElement
  const listEl = document.getElementById('picker-list')!
  let interps: Interp[] = []
  let current: Interp | null = null
  let selIndex = 0
  const showInterp = () => {
    interpBtn.hidden = false
    interpBtn.textContent = current ? `🐍 ${current.label}` : '🐍 Chọn interpreter'
    interpBtn.title = current ? `${current.path}\nVì sao: ${(current as any).reason ?? SOURCE_LABEL[current.source] ?? current.source}\nBấm để đổi (hoặc Ctrl+Shift+P → Python: Select Interpreter)` : 'Không tìm thấy Python: bấm để chọn'
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
    const shown = [{ path: '', label: 'Tự động chọn', version: null, source: 'auto', envDir: null } as Interp, ...interps]
      .filter((i) => !q || `${i.label} ${i.path}`.toLowerCase().includes(q))
    selIndex = Math.min(selIndex, Math.max(0, shown.length - 1))
    listEl.replaceChildren(...shown.map((i, n) => {
      const row = document.createElement('div')
      row.className = 'pk' + (n === selIndex ? ' sel' : '')
      row.setAttribute('role', 'option')
      const isCur = !!current && i.path.toLowerCase() === current.path.toLowerCase()
      row.innerHTML = ''
      const b = document.createElement('b'); b.textContent = (isCur ? '✓ ' : '') + i.label
      const s = document.createElement('small'); s.textContent = i.path || 'Như VS Code: đã chọn → .vscode → venv của dự án (bản Python cao nhất) → Python cài đặt cao nhất'
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
    setStatus('Đang đổi interpreter…', 'busy')
    const r = await req<{ current: Interp | null }>('lsp.setInterpreter', { path, interpreter: i.path || null }, 30000).catch(reportError)
    if (!r) return
    current = r.current
    showInterp()
    setStatus(`${SERVER} • ${rel} • ${current ? current.label : 'không có interpreter'}`, 'ok')
    semEmitter.fire()
  }
  interpBtn.onclick = async () => {
    await loadInterps()
    filterEl.value = ''
    selIndex = 0
    picker.hidden = false
    renderPicker()
    filterEl.focus()
  }
  filterEl.oninput = () => { selIndex = 0; renderPicker() }
  filterEl.onkeydown = (e) => {
    const shown = renderPicker()
    if (e.key === 'ArrowDown') { selIndex = Math.min(selIndex + 1, shown.length - 1); renderPicker(); e.preventDefault() }
    else if (e.key === 'ArrowUp') { selIndex = Math.max(selIndex - 1, 0); renderPicker(); e.preventDefault() }
    else if (e.key === 'Enter') { if (shown[selIndex]) void choose(shown[selIndex]); e.preventDefault() }
    else if (e.key === 'Escape') { closePicker(); e.preventDefault() }
  }
  const restartServer = async () => {
    setStatus(`Đang khởi động lại ${SERVER}…`, 'busy')
    const r = await req<{ detail: string }>('lsp.restart', { path }, 90000).catch(reportError)
    if (!r) return
    await resyncFull()
    setStatus(`${SERVER} • ${rel} • ${r.detail}`, 'ok')
    if (LANG !== 'python') { interpBtn.textContent = `⚙ ${SERVER}`; interpBtn.title = `${r.detail}\nBấm để khởi động lại ${SERVER} (sau khi CMake configure)` }
    semEmitter.fire()
  }
  editor.addAction({ id: 'qt-lsp.restart', label: `${SERVER}: Restart Language Server`, run: () => restartServer() })
  if (LANG === 'python') {
    editor.addAction({ id: 'qt-lsp.selectInterpreter', label: 'Python: Select Interpreter', run: () => interpBtn.click() })
    void loadInterps()
  } else {
    // QML / C++: nut hien server + build dir; bam = khoi dong lai server (vd sau khi tao compile_commands.json)
    interpBtn.hidden = false
    interpBtn.textContent = `⚙ ${SERVER}`
    interpBtn.onclick = () => restartServer()
    void req<{ detail: string }>('lsp.serverInfo', { path }).then((i) => { interpBtn.title = `${i.detail}\nBấm để khởi động lại ${SERVER} (sau khi CMake configure)` }).catch(() => {})
  }
  // Gom thay doi theo tung su kien Monaco, gui dang edits (khong gui ca file): file lon van duoi gioi han tin.
  // Moi su kien: offset tinh tren noi dung truoc su kien; gui theo thu tu de worker ap dung lan luot.
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
    // Dan/thay the lon (vd. reload file): gui lai ca file theo doan
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

  // Chi phuc vu model cua editor nay (model peek cua thu vien co uri rieng).
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

  // Dinh nghia:
  //  - cung file: Monaco nhay ngay trong editor;
  //  - file khac trong workspace: mo tab Orca o file do (Orca chua cho chon dong, nen hien dong o thanh trang thai);
  //  - thu vien (site-packages, typeshed): mo model chi doc va hien peek ngay trong editor nay.
  monaco.languages.registerDefinitionProvider(MONACO_LANG, {
    async provideDefinition(m, position) {
      if (!isMine(m)) return null
      await flushChange()
      const d = await req<DefinitionOutput>('lsp.definition', { path, position: toPos(position) }).catch(reportError)
      if (!d?.locations.length) return null
      const out: monaco.languages.Location[] = []
      for (const loc of d.locations) {
        if (sameFile(loc.path, path)) { out.push({ uri: model.uri, range: toRange(loc.range) }); continue }
        // Monaco can mot model that cho moi dich den (ke ca khi minh tu mo tab Orca), neu khong se "Model not found".
        const scheme = loc.inWorkspace ? 'orca-ws' : 'orca-lib'
        const uri = monaco.Uri.from({ scheme, path: '/' + loc.path.replace(/\\/g, '/') })
        let target = monaco.editor.getModel(uri)
        if (!target) {
          const r = await req<{ text?: string }>('lsp.peek', { path: loc.path }).catch(() => null)
          const peekLang = /\.pyi?$/i.test(loc.path) ? 'python' : /\.qml$/i.test(loc.path) ? 'qml' : 'cpp'
          target = monaco.editor.getModel(uri) ?? monaco.editor.createModel(r?.text ?? '', peekLang, uri)
          if (peekLang !== LANG) void installTextMate(peekLang as Lang)
        }
        if (loc.inWorkspace) pendingReveal = loc
        out.push({ uri, range: toRange(loc.range) })
      }
      return out
    }
  })
  let pendingReveal: { path: string; range: { start: Pos } } | null = null

  // Editor standalone khong tu mo model khac: chan lai de mo tab Orca (workspace) hoac peek (thu vien).
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
        setStatus(r?.opened ? `Đã mở ${r.rel}, định nghĩa ở dòng ${loc.range.start.line + 1}` : `Không mở được ${shortName(loc.path)}`, r?.opened ? 'ok' : 'err')
        return null
      }
      if (target.scheme === 'orca-lib') {
        editor.trigger('lsp', 'editor.action.peekDefinition', null)
        return null
      }
      return null
    }
  }
  // Semantic tokens (basedpyright): to mau lop/ham/bien/module theo y nghia, giong Pylance trong VS Code.
  // Legend gui cho Monaco la danh sach selector cua theme; moi token server duoc doi sang selector do.
  const semLegendTokens: string[] = ['']
  const semIndex = new Map<string, number>([['', 0]])
  const semIndexOf = (token: string) => {
    let i = semIndex.get(token)
    if (i === undefined) { i = semLegendTokens.length; semLegendTokens.push(token); semIndex.set(token, i) }
    return i
  }
  for (const t of ['entity.name.namespace', 'entity.name.type', 'support.class', 'entity.name.function', 'variable', 'variable.parameter', 'variable.other.constant', 'variable.language', 'support.function', 'support.type']) semIndexOf(t)
  // Monaco standalone tat semantic tokens mac dinh (theme.semanticHighlighting=false): bat qua cau hinh.
  // 'editor.semanticHighlighting' doc tu configurationService, khong phai tuy chon cua editor.
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
  // Legend co the them token moi trong luc chay: bao Monaco lay lai sau lan dau.
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
      // clangd/qmlls tra range cua textEdit (vd thay ca "->"): dung range do neu co
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
    if (statusEl.dataset.tone !== 'err') setStatus(`${SERVER} • ${rel} • ${errs} lỗi, ${warns} cảnh báo`, errs ? 'warn' : 'ok')
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

main().catch((e) => setStatus(`Lỗi: ${e instanceof Error ? e.message : String(e)}`, 'err'))
