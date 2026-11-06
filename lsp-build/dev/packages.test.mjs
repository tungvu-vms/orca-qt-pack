import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const definitions = {
  python: {
    id: 'python-code-intelligence',
    forbidden: ['clangdPath', 'qtBin', 'qmllsPath'],
    grammar: /MagicPython/
  },
  cpp: {
    id: 'cpp-code-intelligence',
    forbidden: ['python', 'pyrightPath', 'qtBin', 'qmllsPath'],
    grammar: /tm-cpp\.tmLanguage/
  },
  qml: {
    id: 'qml-code-intelligence',
    forbidden: ['python', 'pyrightPath', 'clangdPath'],
    grammar: /tm-qml\.tmLanguage/
  }
}
for (const [lang, definition] of Object.entries(definitions))
  test(`${lang} installs alone with one editor and only its grammar family`, () => {
    const root = resolve(`../plugins/${lang}-lsp`)
    assert(
      existsSync(join(root, 'orca-plugin.json')),
      'the independent package must be built'
    )
    const manifest = JSON.parse(
      readFileSync(join(root, 'orca-plugin.json'), 'utf8')
    )
    assert.equal(manifest.id, definition.id)
    assert.equal(manifest.contributes.customEditors.length, 1)
    assert.equal(manifest.contributes.customEditors[0].id, `${lang}-lsp`)
    const keys = manifest.contributes.settings.map((x) => x.key)
    assert(!definition.forbidden.some((key) => keys.includes(key)))
    if (lang === 'cpp') {
      assert(keys.includes('compilationDatabase'))
      assert(manifest.contributes.customEditors[0].extensions.includes('.cppm'))
    }
    assert(
      manifest.capabilities.every((c) =>
        [
          'workspace:read',
          'workspace:write',
          'settings:own',
          'storage:own'
        ].includes(c.kind)
      )
    )
    const assets = readdirSync(join(root, 'editor/assets'))
    assert(assets.some((name) => definition.grammar.test(name)))
    if (lang !== 'python')
      assert(!assets.some((name) => /MagicPython|MagicRegExp/.test(name)))
    if (lang !== 'cpp')
      assert(!assets.some((name) => /tm-cpp|tm-c\.tmLanguage/.test(name)))
    if (lang !== 'qml')
      assert(!assets.some((name) => /tm-qml|tm-javascript/.test(name)))
    assert(existsSync(join(root, manifest.main)))
    assert(existsSync(join(root, 'worker/agent.mjs')))
    const worker = readFileSync(join(root, manifest.main), 'utf8')
    if (lang !== 'python')
      assert(
        !worker.includes('basedpyright/Pyright not found'),
        'non-Python workers must not include the Python launch adapter'
      )
    if (lang !== 'qml')
      assert(
        !worker.includes('qmlls (Qt 6.4+)'),
        'non-QML workers must not include the QML launch adapter'
      )
    if (lang !== 'cpp')
      assert(
        !worker.includes('clangd not found'),
        'non-C++ workers must not include the clangd launch adapter'
      )
    assert(existsSync(join(root, 'LICENSE')))
    assert(existsSync(join(root, 'THIRD_PARTY_NOTICES.txt')))
    assert.deepEqual(
      readdirSync(join(root, 'editor')).filter((x) => x.endsWith('.html')),
      [`${lang}.html`]
    )
  })
test('new packages do not modify the frozen legacy plugin', () => {
  assert.equal(
    execFileSync(
      'git',
      ['diff', '--name-only', 'HEAD', '--', 'plugins/qt-lsp'],
      { encoding: 'utf8' }
    ).trim(),
    ''
  )
})
