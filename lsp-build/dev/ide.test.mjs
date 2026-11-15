import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { createCore } = await import(pathToFileURL(join(process.env.QT_LSP_TEST_DIR, 'core.js')))

test('Python IDE operations use the real language server and unsaved buffers', { timeout: 60000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qt-lsp-ide-'))
  const main = join(root, 'main.py'), helper = join(root, 'helper.py')
  const text = 'from helper import greet\n\nclass WindowModel:\n    def title(self, name: str) -> str:\n        return greet(name, 2)\n\ndef compute(value: int) -> int:\n    doubled = value * 2\n    return doubled\n\nresult = greet("Qt", 2)\nanswer = compute(21)\n'
  const helperText = 'def greet(name: str, count: int = 1) -> str:\n    return name * count\n\ndef discoverable_symbol() -> str:\n    return "Qt"\n'
  writeFileSync(main, text); writeFileSync(helper, helperText)
  writeFileSync(join(root, 'pyrightconfig.json'), '{"typeCheckingMode":"off"}')
  const settings = { pyrightPath: resolve('node_modules/basedpyright/langserver.index.js'), nodePath: process.execPath, projectEnvironments: 'off' }
  const posts = []
  const storage = new Map()
  const core = createCore({
    log() {}, post: (event, payload) => posts.push({ event, payload }),
    setting: async (key, fallback) => settings[key] ?? fallback,
    storageGet: async (k) => storage.get(k), storageSet: async (k, v) => { storage.set(k, v) },
    roots: async () => ({ focused: root, roots: [root] })
  })
  const call = (name, input) => {
    assert.equal(typeof core.handlers[name], 'function', `${name} must be implemented`)
    return core.handlers[name](input)
  }
  const pos = (line, word, offset = 1) => ({ line, character: text.split('\n')[line].indexOf(word) + offset })
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  try {
    await call('lsp.open', { path: main, text, version: 1 })
    await call('lsp.open', { path: helper, text: helperText, version: 1 })
    await t.test('references include the declaration and the caller in another file', async () => {
      const r = await call('lsp.references', { path: helper, position: { line: 0, character: 5 }, includeDeclaration: true })
      assert(r.locations.some((l) => samePath(l.path, helper)), JSON.stringify(r))
      assert(r.locations.some((l) => samePath(l.path, main) && l.range.start.line === 10), JSON.stringify(r))
      const peek = await call('lsp.peek', { path: main, line: 10 })
      assert.match(peek.text, /result = greet/)
      const blocked = await call('lsp.peek', { path: join(root, 'pyrightconfig.json') })
      assert.equal(blocked.text, '', 'arbitrary paths must remain unreadable')
    })
    await t.test('signature help returns the active parameter and typed signature', async () => {
      const r = await call('lsp.signatureHelp', { path: main, position: pos(10, '2', 0), trigger: ',' })
      assert(r.signatures.some((s) => /name: str/.test(s.label) && /count: int/.test(s.label)))
      assert.equal(r.activeParameter, 1)
      assert.deepEqual(r, JSON.parse(JSON.stringify(r)), 'Orca only accepts pure JSON values')
    })
    await t.test('document symbols keep the class/method hierarchy', async () => {
      const r = await call('lsp.documentSymbols', { path: main })
      assert(r.items.some((s) => s.name === 'WindowModel'))
      assert(r.items.some((s) => s.name === 'title' && s.containerName === 'WindowModel'))
      assert(r.items.some((s) => s.name === 'compute'))
    })
    await t.test('occurrences distinguish symbol ranges', async () => {
      const r = await call('lsp.documentHighlights', { path: main, position: pos(7, 'doubled') })
      assert.deepEqual(r.items.map((x) => x.range.start.line).sort(), [7, 8])
    })
    await t.test('F2 returns undoable edits for an unsaved local variable and never writes disk', async () => {
      const unsaved = text.replaceAll('doubled', 'intermediate')
      await call('lsp.change', { path: main, text: unsaved, version: 2 })
      const position = { line: 7, character: 7 }
      const prepared = await call('lsp.prepareRename', { path: main, position })
      assert.equal(prepared.placeholder, 'intermediate')
      const r = await call('lsp.rename', { path: main, position, newName: 'renamed_value', version: 2 })
      assert.equal(r.rejectReason, undefined)
      assert.equal(r.edits.length, 2)
      assert(r.edits.every((e) => e.text === 'renamed_value'))
      assert.equal(readFileSync(main, 'utf8'), text)
      const stale = await call('lsp.rename', { path: main, position, newName: 'stale_value', version: 1 })
      assert.match(stale.rejectReason, /changed|stale/i)
      assert.equal(stale.edits.length, 0)
    })
    await t.test('cross-file rename is rejected atomically', async () => {
      const r = await call('lsp.rename', { path: helper, position: { line: 0, character: 5 }, newName: 'welcome', version: 1 })
      assert.match(r.rejectReason, /other files|multiple files|cross-file/i)
      assert.deepEqual(r.edits, [])
      assert.equal(readFileSync(helper, 'utf8'), helperText)
    })
    await t.test('closing a discarded buffer drops its unsaved preview text', async () => {
      await call('lsp.change', { path: helper, text: helperText + '# discarded unsaved edit\n', version: 2 })
      const openPreview = await call('lsp.peek', { path: helper, line: 0 })
      assert.match(openPreview.text, /discarded unsaved edit/)
      await call('lsp.close', { path: helper })
      const closedPreview = await call('lsp.peek', { path: helper, line: 0 })
      assert.equal(closedPreview.text, helperText)
    })
    await t.test('completion includes the additional edit needed for a Python auto import', async () => {
      await call('lsp.change', { path: main, text: text + '\ndiscovera', version: 3 })
      const r = await call('lsp.completion', { path: main, position: { line: 13, character: 9 } })
      const item = r.items.find((it) => it.label === 'discoverable_symbol')
      assert(item, JSON.stringify(r))
      assert(item.additionalTextEdits?.some((edit) => edit.text.includes('discoverable_symbol')), JSON.stringify(item))
    })
    await t.test('real PySide6 stubs support definitions, parameter help and completion', {
      skip: !process.env.QT_LSP_TEST_PYTHON && 'Set QT_LSP_TEST_PYTHON to a trusted interpreter with PySide6 installed'
    }, async () => {
      const qt = join(root, 'widgets.py')
      const qtText = 'from PySide6.QtWidgets import QMainWindow\nwin = QMainWindow()\nwin.setWindowTitle("Qt")\n'
      writeFileSync(qt, qtText)
      settings.projectEnvironments = 'on'
      await call('lsp.open', { path: qt, text: qtText, version: 1 })
      await call('lsp.setInterpreter', { path: qt, interpreter: process.env.QT_LSP_TEST_PYTHON })
      let definition
      for (let attempt = 0; attempt < 40; attempt++) {
        definition = await call('lsp.definition', { path: qt, position: { line: 1, character: 10 } })
        if (definition.locations.length) break
        await new Promise((done) => setTimeout(done, 100))
      }
      assert(definition.locations.some((l) => /PySide6[\\/]QtWidgets\.pyi$/i.test(l.path)), JSON.stringify(definition))
      const signature = await call('lsp.signatureHelp', { path: qt, position: { line: 2, character: 19 } })
      assert(signature.signatures.some((s) => /str/.test(s.label) && /None/.test(s.label)), JSON.stringify(signature))
      await call('lsp.change', { path: qt, text: qtText + 'win.setWindowT', version: 2 })
      const completion = await call('lsp.completion', { path: qt, position: { line: 3, character: 14 } })
      assert(completion.items.some((it) => it.label === 'setWindowTitle'), JSON.stringify(completion))
      const target = definition.locations[0]
      const peek = await call('lsp.peek', { path: target.path, line: target.range.start.line })
      assert.match(peek.text.split('\n')[target.range.start.line], /QMainWindow/)
      assert(Buffer.byteLength(JSON.stringify(peek)) < 700000)
    })
  } finally {
    core.shutdown()
    assert(root.startsWith(join(tmpdir(), 'qt-lsp-ide-')))
    rmSync(root, { recursive: true, force: true })
  }
})
