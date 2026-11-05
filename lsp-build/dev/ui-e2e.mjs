// Runs the actual built editor against the real shared core in Chromium.
// The Orca document bridge is the only simulated boundary; product code has no test hooks.
import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const equalDraft = (actual, expected, label) => {
  if (actual === expected) return
  let at = 0
  while (at < Math.min(actual.length, expected.length) && actual[at] === expected[at]) at++
  assert.fail(`${label}: lengths ${actual.length}/${expected.length}, first difference ${at}: ${JSON.stringify(actual.slice(at, at + 50))}/${JSON.stringify(expected.slice(at, at + 50))}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'qt-lsp-ui-'))
const project = join(scratch, 'project')
mkdirSync(project)
// Optional read-only performance run against a real project. The bridge's session
// stays in memory; the source project is never written to by this harness.
const realFile = process.env.QT_LSP_UI_FILE
const path = realFile ? resolve(realFile) : join(project, 'main.py')
const largeMode = process.env.QT_LSP_LARGE_UI === '1' || process.argv.includes('--large')
const evictionMode = process.argv.includes('--stress-files')
const stressMode = process.argv.includes('--stress') || evictionMode
const baseText = 'from helper import greet\n\nclass WindowModel:\n    def title(self, name: str) -> str:\n        return greet(name, 2)\n\ndef compute(value: int) -> int:\n    doubled = value * 2\n    return doubled\n\nresult = greet("Qt", 2)\nanswer = compute(21)\n'
const text = realFile ? readFileSync(path, 'utf8') : baseText + (largeMode ? ('# Tiếng Việt 漢字 😀 ' + 'padding '.repeat(12) + '\n').repeat(2400) + 'tail_result = greet("large", 2)\n' : '') + (stressMode ? '\nimport helper\n' + Array.from({ length: 80 }, (_, i) => `helper.target_${i}()\n`).join('') : '')
if (!realFile) writeFileSync(path, text)
const helperPath = join(project, 'helper.py')
writeFileSync(helperPath, 'def greet(name: str, count: int = 1) -> str:\n    return name * count\n' + ('#' + 'x'.repeat(998) + '\n').repeat(1798) + 'greet("last")\n\ndef discoverable_symbol() -> str:\n    return "Qt"\n')
writeFileSync(helperPath, readFileSync(helperPath, 'utf8') + '\nclass DemoSettings:\n    pass\n')
if (stressMode) writeFileSync(helperPath, readFileSync(helperPath, 'utf8') + Array.from({ length: 80 }, (_, i) => `\ndef target_${i}() -> int:\n    return ${i}\n`).join(''))
if (evictionMode) {
  const tail = Array.from({ length: 80 }, (_, i) => `import target_${i}\ntarget_${i}.go()\n`).join('')
  writeFileSync(path, baseText + '\n' + tail)
  for (let i = 0; i < 80; i++) writeFileSync(join(project, `target_${i}.py`), `def go() -> int:\n    return ${i}\n` + ('#' + 'x'.repeat(998) + '\n').repeat(1800))
}
const documentText = evictionMode ? readFileSync(path, 'utf8') : text
writeFileSync(join(project, 'pyrightconfig.json'), '{}')
const out = join(scratch, 'core.mjs')
await build({ entryPoints: ['src/core.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm' })
const { createCore } = await import(pathToFileURL(out))
const config = { pyrightPath: resolve('node_modules/basedpyright/langserver.index.js'), nodePath: process.execPath, projectEnvironments: 'off' }
if (realFile) { config.python = process.env.QT_LSP_TEST_PYTHON; config.projectEnvironments = 'on' }
const calls = [], reveals = [], errors = []
let delayRename = false, failNextChange = false
let releaseInitialOpen, releaseFirstUpload, heldFirstUpload = false
const coreHost = { log() {}, post() {}, setting: async (k, fallback) => config[k] ?? fallback,
  storageGet: async () => null, storageSet: async () => {}, roots: async () => ({ focused: realFile ? process.env.QT_LSP_UI_ROOT : project, roots: [realFile ? process.env.QT_LSP_UI_ROOT : project] }),
  reveal: async (path, line) => { reveals.push({ path, line }); return { opened: true, line } }
}
let core = createCore(coreHost)
const assets = resolve('../plugins/qt-lsp/editor')
const bridge = `<script>
const listeners = new Map();
const settingsListeners = new Set();
window.__publish = (name, payload) => listeners.get(name)?.(payload);
window.__session = { value: ${JSON.stringify(documentText)}, readOnly: false, change(value) { this.value = value }, onReplace() { return {dispose(){}} }, flush: async () => {}, dispose() {} };
window.orca = { document: {session: async () => window.__session}, on() { return {dispose(){}} },
  settings: {
    async get(key) { return key === 'pythonDiagnostics' ? JSON.parse(localStorage.getItem(key) ?? 'true') : undefined },
    async set(key, value) { localStorage.setItem(key, JSON.stringify(value)); for (const fn of settingsListeners) fn({key}) },
    onDidChange(fn) { settingsListeners.add(fn); return {dispose() {settingsListeners.delete(fn)}} }
  },
  plugin: {on(name, fn) {listeners.set(name, fn); return {dispose(){}}},
    async request(name, input) {
      if(name === 'lsp.definition' && window.__rateLimitDefinitions > 0) {
        window.__rateLimitDefinitions--;
        window.__blockedDefinitionId = input.requestId;
        throw Object.assign(new Error('too many messages'), {code:'rate_limited',retryAfterMs:window.__rateLimitDelay ?? 50});
      }
      const json = value => value === null || ['string','number','boolean'].includes(typeof value) || (typeof value === 'object' && Object.values(value).every(json));
      if (!json(input)) throw new Error('The Orca bridge requires pure JSON input');
      const bytes = value => {
        if(value === null || typeof value === 'boolean') return 1;
        if(typeof value === 'number') return 8;
        if(typeof value === 'string') return new TextEncoder().encode(value).length;
        if(Array.isArray(value)) return 8 + value.reduce((sum,item) => sum + 4 + bytes(item),0);
        return Object.entries(value).reduce((sum,[key,item]) => sum + 4 + bytes(key) + bytes(item),0);
      };
      if(bytes({orca:1,kind:'req',id:1,method:'plugin.request',params:{name,input,timeoutMs:20000}}) > 65536) throw new Error('message too large');
      const r = await fetch('/api', {method:'POST', body:JSON.stringify({name, input})}); const out = await r.json(); if(out.error) throw new Error(out.error); return out.result;
    }
  }
};
</script>`
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api') {
      let body = ''; for await (const chunk of req) body += chunk
      const { name, input } = JSON.parse(body)
      const record = { name, input }; calls.push(record)
      let result
      if (name === 'lsp.hostChoice') result = { project: 'UI test', chosen: 'local', hosts: [] }
      else if (name === 'lsp.change' && input.edits && failNextChange) {
        failNextChange = false
        await new Promise((done) => setTimeout(done, 250))
        result = { ok: false, resync: true }
      }
      else {
        result = await core.handlers[name](input)
        if (name === 'lsp.open' && largeMode) await new Promise((done) => { releaseInitialOpen = done })
        if (name === 'lsp.upload' && largeMode && !heldFirstUpload) {
          heldFirstUpload = true
          await new Promise((done) => { releaseFirstUpload = done })
        }
        if (name === 'lsp.rename' && delayRename) await new Promise((done) => setTimeout(done, 700))
      }
      record.result = result
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result })); return
    }
    if (req.url === '/' || req.url === '/python.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(assets, 'python.html'), 'utf8').replace('<head>', '<head>' + bridge)); return
    }
    const file = resolve(assets, '.' + decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(assets + (process.platform === 'win32' ? '\\' : '/'))) { res.writeHead(403).end(); return }
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)] ?? 'application/octet-stream'
    res.setHeader('Content-Type', mime); res.end(readFileSync(file))
  } catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: e.message })) }
})
let browser, page
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const executablePath = process.env.QT_LSP_BROWSER ?? [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].find(existsSync)
  assert(executablePath, 'Set QT_LSP_BROWSER to an installed Chromium/Chrome/Edge executable')
  browser = await chromium.launch({ executablePath, headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  page.on('pageerror', (e) => errors.push(e.stack ?? e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction((name) => document.getElementById('status').textContent.includes(name), path.split(/[\\/]/).at(-1), { timeout: 30000 })
  // Use the editor's native keyboard commands throughout; positioning uses Ctrl+G.
  const go = async (line, column = 1) => {
    await page.locator('.quick-input-widget').waitFor({ state: 'hidden' })
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+g')
    const input = page.locator('.quick-input-widget input[type=text]')
    await input.waitFor({ state: 'visible' })
    await input.fill(`:${line}:${column}`)
    await page.keyboard.press('Enter')
    await page.locator('.quick-input-widget').waitFor({ state: 'hidden' })
    await page.waitForTimeout(100)
  }
  if (stressMode) {
    const profiler = await page.context().newCDPSession(page)
    await profiler.send('Performance.enable')
    const heap = async () => {
      await profiler.send('HeapProfiler.collectGarbage')
      return (await profiler.send('Performance.getMetrics')).metrics.find((x) => x.name === 'JSHeapUsedSize').value
    }
    await page.locator('#interp:not([hidden])').waitFor()
    const baseline = await heap()
    for (let i = 0; i < 80; i++) {
      const expression = evictionMode ? `target_${i}.go()` : `helper.target_${i}()`
      const line = documentText.split('\n').findIndex((line) => line === expression)
      await go(line + 1, 1)
      await page.mouse.move(1, 1)
      const before = calls.length
      await page.keyboard.down('Control')
      await page.locator('.view-lines .view-line').filter({ hasText: expression }).getByText(evictionMode ? 'go' : `target_${i}`, { exact: true }).hover()
      for (let wait = 0; wait < 100 && !calls.slice(before).some((c) => c.name === 'lsp.peek' && c.result); wait++) await page.waitForTimeout(20)
      await page.locator('.goto-definition-link').first().waitFor({ state: 'visible' })
      await page.keyboard.up('Control')
      if ((i + 1) % 20 === 0) console.log(JSON.stringify({ previews: i + 1, retainedMiB: Math.round(((await heap()) - baseline) / 1048576) }))
    }
    await page.mouse.move(1, 1)
    await page.waitForTimeout(200)
    const retained = (await heap()) - baseline
    assert(retained < 16 * 1048576, `80 distinct previews retained ${(retained / 1048576).toFixed(1)} MiB; preview storage must remain bounded`)
    if (evictionMode) {
      const line = documentText.split('\n').findIndex((line) => line === 'target_0.go()')
      await go(line + 1, 11)
      await page.keyboard.press('F12')
      for (let i = 0; i < 100 && !reveals.length; i++) await page.waitForTimeout(20)
      assert(reveals.some((r) => r.path.endsWith('target_0.py') && r.line === 1), 'a previously evicted target must still open correctly')
      console.log('PASS preview eviction: navigation can return to an older target')
    }
    console.log('PASS sustained navigation: preview memory remains bounded')
  } else if (realFile) {
    await page.locator('#interp:not([hidden])').waitFor({ timeout: 15000 })
    const word = process.env.QT_LSP_UI_SYMBOL
    assert(word && process.env.QT_LSP_UI_ROOT && process.env.QT_LSP_TEST_PYTHON, 'real-file mode needs UI_ROOT, UI_SYMBOL and TEST_PYTHON')
    const lines = text.split('\n')
    const positions = process.env.QT_LSP_UI_ALL_POSITIONS === '1' ? lines.flatMap((line, i) => line.includes(word) ? [i] : []) : [lines.findLastIndex((line) => line.includes(word))]
    assert(positions.length && positions.every((line) => line >= 0), 'symbol must exist in the requested file')
    for (const line of positions) for (let run = 1; run <= (positions.length === 1 ? 3 : 1); run++) {
      const column = lines[line].indexOf(word) + 2
      await go(line + 1, column)
      const symbol = page.locator('.view-lines .view-line').filter({ hasText: lines[line].trim() }).getByText(word, { exact: true })
      await page.mouse.move(1, 1)
      const before = reveals.length, started = Date.now()
      await symbol.click({ modifiers: ['Control'] })
      for (let i = 0; i < 300 && reveals.length === before; i++) await page.waitForTimeout(50)
      assert.equal(reveals.length, before + 1, 'real-project Ctrl+Click must resolve')
      console.log(JSON.stringify({ run, sourceLine: line + 1, action: 'Ctrl+Click', symbol: word, ms: Date.now() - started, target: reveals.at(-1).path, targetLine: reveals.at(-1).line }))
    }
  } else if (largeMode) {
    for (let i = 0; i < 100 && !releaseInitialOpen; i++) await page.waitForTimeout(30)
    assert(releaseInitialOpen, 'initial open must be pending')
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\n# typed during initialization\n')
    // Compare the actual editor draft; native input can apply newline/indent
    // behavior differently across Chromium versions on the Windows runner.
    const initialDraft = await page.evaluate(() => window.__session.value)
    assert(initialDraft.includes('# typed during initialization'))
    releaseInitialOpen()
    for (let i = 0; i < 100 && !releaseFirstUpload; i++) await page.waitForTimeout(30)
    assert(releaseFirstUpload, 'initial upload must be pending')
    await page.keyboard.insertText('# typed during chunk upload\n')
    await page.waitForTimeout(250)
    releaseFirstUpload()
    for (let i = 0; i < 200 && !calls.some((c) => c.name === 'lsp.diagnostics' && c.result); i++) await page.waitForTimeout(30)
    await page.locator('#interp:not([hidden])').waitFor({ timeout: 10000 })
    assert(!await page.locator('#status').innerText().then((s) => s.includes('message too large')), 'large files must finish initialization')
    await go(text.split('\n').length - 1, 17)
    await page.keyboard.press('F12')
    for (let i = 0; i < 200 && !reveals.length; i++) await page.waitForTimeout(50)
    assert(reveals.some((r) => r.path.toLowerCase().endsWith('helper.py')), 'definition at the end of a 2400-line file must resolve')
    assert(calls.some((c) => c.name === 'lsp.open' && c.input.text === undefined), 'large initial opens must read disk rather than send the entire file')
    const upload = calls.filter((c) => c.name === 'lsp.upload')
    assert(upload.length > 1 && upload.at(-1).result?.ok, 'edits made while opening must be uploaded in small chunks')
    equalDraft(upload.map((c) => c.input.part).join(''), initialDraft, 'initial upload snapshot')
    await core.handlers['lsp.references']({ path: helperPath, position: { line: 0, character: 5 }, includeDeclaration: true })
    const synced = await core.handlers['lsp.peek']({ path, line: 0 })
    equalDraft(synced.text, await page.evaluate(() => window.__session.value), 'typing during a chunk upload must reach the worker after the upload commits')
    console.log('PASS 2400+ lines: initialize under the 64 KiB request limit and navigate from the end')
    for (let attempt = 0; attempt < 5; attempt++) {
      await go(text.split('\n').length - 1, 1)
      const previous = reveals.length
      const symbol = page.locator('.view-lines .view-line').filter({ hasText: 'tail_result' }).getByText('greet', { exact: true })
      await page.mouse.move(1, 1)
      await symbol.click({ modifiers: ['Control'] })
      for (let i = 0; i < 50 && reveals.length === previous; i++) await page.waitForTimeout(30)
      assert.equal(reveals.length, previous + 1, `Ctrl+Click attempt ${attempt + 1} must open exactly one definition without waiting for hover`)
    }
    console.log('PASS Ctrl+Click: five consecutive clicks in a large file open exactly one target each')
    const previous = reveals.length
    await go(text.split('\n').length - 1, 17)
    await page.mouse.move(1, 1)
    await page.evaluate(() => { window.__rateLimitDefinitions = 1 })
    await page.keyboard.press('F12')
    for (let i = 0; i < 50 && reveals.length === previous; i++) await page.waitForTimeout(30)
    assert.equal(reveals.length, previous + 1, 'navigation must retry a transient bridge rate limit')
    console.log('PASS navigation: transient rate limits are retried')
    await go(text.split('\n').length - 1, 1)
    await page.mouse.move(1, 1)
    await page.evaluate(() => { window.__rateLimitDefinitions = 1; window.__rateLimitDelay = 600 })
    await page.keyboard.down('Control')
    await page.locator('.view-lines .view-line').filter({ hasText: 'tail_result' }).getByText('greet', { exact: true }).hover()
    await page.waitForFunction(() => window.__rateLimitDefinitions === 0)
    // Moving to a different symbol cancels the native link provider's old lookup.
    const blockedDefinitionId = await page.evaluate(() => window.__blockedDefinitionId)
    await page.locator('.view-lines .view-line').filter({ hasText: 'tail_result' }).getByText('tail_result', { exact: true }).hover()
    await page.mouse.move(1, 1)
    await page.keyboard.up('Control')
    await page.waitForTimeout(750)
    assert(!calls.some((c) => c.name === 'lsp.definition' && c.input.requestId === blockedDefinitionId), 'a cancelled hover must not be retried after rate-limit backoff')
    console.log('PASS cancellation: moving away prevents obsolete definition requests from being retried')
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+End')
    const pasted = '\n' + ('# thêm tiếng Việt 😀 ' + 'x'.repeat(200) + '\n').repeat(400) + 'fresh_result = greet("new", 2)\n'
    console.log('Checking a Unicode paste larger than the 64 KiB bridge limit...')
    await page.evaluate((text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, pasted)
    const beforePaste = upload.length
    for (let i = 0; i < 200; i++) {
      const parts = calls.filter((c) => c.name === 'lsp.upload')
      if (parts.length > beforePaste && parts.at(-1).result?.ok && parts.at(-1).input.index === parts.at(-1).input.total - 1) break
      await page.waitForTimeout(50)
    }
    const parts = calls.filter((c) => c.name === 'lsp.upload').slice(beforePaste)
    assert(parts.length > 1 && parts.at(-1).input.index === parts.at(-1).input.total - 1)
    assert.equal(parts.map((c) => c.input.part).join(''), await page.evaluate(() => window.__session.value))
    console.log('PASS large edits: initialization keystrokes and a Unicode paste upload without exceeding 64 KiB')
  } else {
  // Signature help through the VS Code shortcut.
  await go(11, 22)
  await page.keyboard.press('Control+Shift+Space')
  await page.locator('.parameter-hints-widget.visible').waitFor({ timeout: 15000 })
  assert.match(await page.locator('.parameter-hints-widget').innerText(), /count.*int/)
  await page.keyboard.press('Escape')
  console.log('PASS Ctrl+Shift+Space: typed parameter hints')

  await go(7, 6)
  await page.keyboard.press('Control+Shift+o')
  await page.locator('.quick-input-widget').waitFor({ state: 'visible' })
  await page.keyboard.type('title')
  await page.getByRole('option').filter({ hasText: 'title' }).first().waitFor()
  await page.keyboard.press('Enter')
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' })
  console.log('PASS Ctrl+Shift+O: class/method symbols')

  await go(11, 12)
  await page.keyboard.press('Shift+F12')
  await page.locator('.peekview-widget').waitFor({ state: 'visible', timeout: 15000 })
  assert.match(await page.locator('.peekview-widget').innerText(), /helper\.py|main\.py/)
  const preview = page.locator('.peekview-widget .monaco-editor textarea').first()
  await preview.waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.peekview-widget .monaco-editor textarea')?.hasAttribute('readonly'))
  const previewText = await page.locator('.peekview-widget .view-lines').innerText()
  await preview.focus()
  await page.keyboard.type('MUST_NOT_EDIT')
  assert.equal(await page.locator('.peekview-widget .view-lines').innerText(), previewText)
  assert.equal(await page.evaluate(() => window.__session.value), text)
  await page.keyboard.press('Escape')
  console.log('PASS Shift+F12: cross-file references with read-only previews')
  assert(calls.some((c) => c.name === 'lsp.peek' && c.input.line === 1800), 'distant references in the same 2000-line bucket must load their own window')
  writeFileSync(helperPath, readFileSync(helperPath, 'utf8').replace('greet("last")', 'greet("fresh")'))
  await go(11, 12)
  await page.keyboard.press('Shift+F12')
  await page.locator('.peekview-widget').waitFor({ state: 'visible' })
  const refresh = calls.filter((c) => c.name === 'lsp.peek' && c.input.line === 1800).at(-1)
  assert(refresh?.result.text.includes('greet("fresh")'), 'new reference requests must refresh cached previews')
  await page.keyboard.press('Escape')
  console.log('PASS large references: distant windows and refreshed target content')

  await go(8, 7)
  await page.keyboard.press('F2')
  const renameInput = page.locator('.rename-box input')
  await renameInput.waitFor({ state: 'visible' })
  await renameInput.fill('renamed_value')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__session.value.includes('return renamed_value'))
  assert.equal((await page.evaluate(() => window.__session.value.match(/renamed_value/g))).length, 2)
  assert.equal(readFileSync(path, 'utf8'), text, 'F2 must not write disk')
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !window.__session.value.includes('renamed_value'))
  assert.equal(await page.evaluate(() => window.__session.value), text)
  console.log('PASS F2 + Ctrl+Z: semantic rename and single-step undo')

  delayRename = true
  await go(8, 7)
  await page.keyboard.press('F2')
  await renameInput.waitFor({ state: 'visible' })
  await renameInput.fill('must_not_apply')
  const previous = calls.filter((c) => c.name === 'lsp.rename').length
  await page.keyboard.press('Enter')
  for (let i = 0; i < 50 && calls.filter((c) => c.name === 'lsp.rename').length === previous; i++) await page.waitForTimeout(20)
  await page.keyboard.type('#')
  await page.waitForTimeout(800)
  assert(!await page.evaluate(() => window.__session.value.includes('must_not_apply')))
  await page.keyboard.press('Control+z')
  await page.waitForFunction((text) => window.__session.value === text, text)
  delayRename = false
  console.log('PASS stale F2: typing during a pending rename keeps the newer text')

  // A function imported by another file must not be partially renamed.
  await go(11, 12)
  await page.keyboard.press('F2')
  await renameInput.waitFor({ state: 'visible' })
  await renameInput.fill('welcome')
  await page.keyboard.press('Enter')
  await page.getByText(/Rename also changes other files/).first().waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => window.__session.value), text)
  await page.keyboard.press('Escape')
  console.log('PASS cross-file F2: rejected without partial edits')

  // Keyboard navigation is enough to exercise the existing definition opener too.
  await go(11, 12)
  await page.keyboard.press('F12')
  for (let i = 0; i < 30 && !reveals.length; i++) await page.waitForTimeout(100)
  assert(reveals.some((r) => r.path.toLowerCase().endsWith('helper.py') && r.line === 1))
  console.log('PASS F12: opens the selected definition at the correct line')

  await page.keyboard.press('F1')
  await page.locator('.quick-input-widget').waitFor({ state: 'visible' })
  await page.keyboard.type('Rename Symbol')
  await page.getByRole('option').filter({ hasText: 'Rename Symbol' }).first().waitFor()
  await page.keyboard.press('Escape')
  console.log('PASS F1: editor command palette exposes rename')

  await go(13, 1)
  await page.keyboard.type('discovera')
  await page.keyboard.press('Control+Space')
  const suggestion = page.locator('.suggest-widget .monaco-list-row').filter({ hasText: 'discoverable_symbol' }).first()
  await suggestion.waitFor({ state: 'visible' })
  await suggestion.click()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__session.value.includes('import greet, discoverable_symbol') || /from helper import discoverable_symbol/.test(window.__session.value))
  assert.match(await page.evaluate(() => window.__session.value), /discoverable_symbol/)
  console.log('PASS Ctrl+Space: accepting a completion inserts its Python import')

  // A recovery snapshot includes edits typed while the failed change is pending.
  // Those edits must be consumed once rather than replayed after the full upload.
  const previousChanges = calls.filter((c) => c.name === 'lsp.change').length
  failNextChange = true
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('# FIRST')
  for (let i = 0; i < 50 && calls.filter((c) => c.name === 'lsp.change').length === previousChanges; i++) await page.waitForTimeout(20)
  assert.equal(failNextChange, false, 'the failed request must be in flight')
  await page.keyboard.type(' SECOND')
  await page.waitForTimeout(700)
  const snapshot = await core.handlers['lsp.peek']({ path, line: 12 })
  assert.equal(snapshot.text, await page.evaluate(() => window.__session.value))
  assert.equal((snapshot.text.match(/SECOND/g) ?? []).length, 1)
  console.log('PASS recovery: pending keystrokes are not duplicated after resync')

  const diagnostic = { path, version: 100, items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, severity: 1, message: 'Visible syntax problem for diagnostics toggle' }] }
  await page.evaluate((d) => window.__publish('lsp.diagnostics', d), diagnostic)
  await page.locator('.squiggly-error').first().waitFor({ state: 'visible' })
  const toggleDiagnostics = async () => {
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('F1')
    const input = page.locator('.quick-input-widget input[type=text]')
    await input.fill('>Python: Toggle Diagnostics')
    await page.getByRole('option').filter({ hasText: 'Python: Toggle Diagnostics' }).first().waitFor({ timeout: 5000 })
    await page.keyboard.press('Enter')
  }
  await toggleDiagnostics()
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('diagnostics off'))
  await page.locator('.squiggly-error').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.squiggly-error').count(), 0)
  assert.equal(await page.evaluate(() => localStorage.getItem('pythonDiagnostics')), 'false')
  await page.evaluate((d) => window.__publish('lsp.diagnostics', d), diagnostic)
  assert.equal(await page.locator('.squiggly-error').count(), 0, 'new server pushes must remain hidden')
  await toggleDiagnostics()
  await page.locator('.squiggly-error').first().waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => localStorage.getItem('pythonDiagnostics')), 'true')
  console.log('PASS diagnostics: F1 toggle clears markers, persists choice and restores diagnostics')
  // An idle Orca worker can restart while this frame still has unsaved text.
  const unsavedClass = '\n'.repeat(10) + 'from helper import DemoSettings\n\ninstance = DemoSettings()\n'
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(unsavedClass)
  await page.waitForTimeout(350)
  const warmReveals = reveals.length
  await go(13, 15)
  await page.keyboard.press('F12')
  for (let i = 0; i < 100 && reveals.length === warmReveals; i++) await page.waitForTimeout(20)
  assert.equal(reveals.length, warmReveals + 1, 'the unsaved class must resolve before restart')
  core.shutdown(); core = createCore(coreHost)
  await go(13, 1)
  await page.mouse.move(1, 1)
  const restartedReveals = reveals.length
  await page.locator('.view-lines .view-line').filter({ hasText: 'instance = DemoSettings()' }).getByText('DemoSettings', { exact: true }).click({ modifiers: ['Control'] })
  for (let i = 0; i < 100 && reveals.length === restartedReveals; i++) await page.waitForTimeout(20)
  assert.equal(reveals.length, restartedReveals + 1, 'class navigation must restore unsaved text after worker restart')
  assert.equal(await page.evaluate(() => window.__session.value), unsavedClass)
  assert.equal(readFileSync(path, 'utf8'), text, 'navigation recovery must not save the draft')
  console.log('PASS class Ctrl+Click: an idle worker restart resynchronizes the unsaved editor before lookup')
  }

  assert.deepEqual(errors, [], 'no uncaught browser errors')
  const capture = process.env.QT_LSP_UI_SHOT
  if (capture) await page.screenshot({ path: capture })
  console.log('All editor keyboard checks passed.')
} catch (e) {
  console.error('Recent RPCs:', calls.slice(-15).map((c) => ({ name: c.name, position: c.input?.position, version: c.input?.version, resync: c.result?.resync, locations: c.result?.locations?.length, rejectReason: c.result?.rejectReason })))
  console.error('Browser errors:', errors)
  if (page && !page.isClosed()) {
    console.error('Visible text:', (await page.locator('body').innerText()).slice(-2500))
    mkdirSync('dist-test', { recursive: true })
    await page.screenshot({ path: 'dist-test/ui-failure.png' })
  }
  throw e
} finally {
  await browser?.close()
  core.shutdown()
  await new Promise((done) => server.close(done))
  assert(scratch.startsWith(join(tmpdir(), 'qt-lsp-ui-')))
  rmSync(scratch, { recursive: true, force: true })
}
