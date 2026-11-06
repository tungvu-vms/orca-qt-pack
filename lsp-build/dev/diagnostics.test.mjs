import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { createCore } = await import(pathToFileURL(join(process.env.QT_LSP_TEST_DIR, 'core.js')))

test('default Python settings disable type noise without a project configuration', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qt-lsp-diagnostics-'))
  const path = join(root, 'main.py')
  const text = 'def run() -> int:\n    return 1\nrun()\nvalue: int = "wrong"\nimport a_missing_module_for_editor_test\n'
  writeFileSync(path, text)
  const settings = { pyrightPath: resolve('node_modules/basedpyright/langserver.index.js'), nodePath: process.execPath, projectEnvironments: 'off' }
  const core = createCore({ log() {}, post() {}, setting: async (k, fallback) => settings[k] ?? fallback,
    storageGet: async () => null, storageSet: async () => {}, roots: async () => ({ focused: root, roots: [root] }) })
  async function diagnostics(version) {
    for (let i = 0; i < 100; i++) {
      const d = await core.handlers['lsp.diagnostics']({ path })
      if (d.version === version && d.items.length) return d
      await new Promise((done) => setTimeout(done, 50))
    }
    assert.fail('language server did not publish diagnostics')
  }
  try {
    await core.handlers['lsp.open']({ path, text, version: 1 })
    const d = await diagnostics(1)
    assert(d.items.some((item) => item.code === 'reportMissingImports'), JSON.stringify(d))
    assert(!d.items.some((item) => ['reportAssignmentType', 'reportUnusedCallResult', 'reportUnknownVariableType'].includes(item.code)), JSON.stringify(d))
    await core.handlers['lsp.change']({ path, text: 'def broken(:\n', version: 2 })
    assert((await diagnostics(2)).items.some((item) => !item.code), 'syntax errors must remain visible')
    settings.typeCheckingMode = 'strict'
    await core.handlers['lsp.restart']({ path })
    await core.handlers['lsp.open']({ path, text, version: 3 })
    assert((await diagnostics(3)).items.some((item) => item.code === 'reportAssignmentType'), 'explicit strict checking must still work')
  } finally {
    core.shutdown()
    assert(root.startsWith(join(tmpdir(), 'qt-lsp-diagnostics-')))
    rmSync(root, { recursive: true, force: true })
  }
})
