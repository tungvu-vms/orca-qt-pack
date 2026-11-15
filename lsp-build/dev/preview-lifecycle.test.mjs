import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('closing a reference group releases a preview that arrives after disposal', async () => {
  const outfile = join(process.env.QT_LSP_TEST_DIR, 'references.mjs')
  const plugins = existsSync('monaco-workarounds.mjs') ? [(await import('../monaco-workarounds.mjs')).monacoWorkarounds] : []
  await build({ entryPoints: ['node_modules/monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/referencesModel.js'], outfile, bundle: true, platform: 'node', format: 'esm', plugins })
  const { FileReferences } = await import(pathToFileURL(outfile))
  const uri = { toString: () => 'file:///preview.py' }
  const group = new FileReferences({}, uri)
  group.children.push({ uri })
  let release, disposed = 0
  const pending = group.resolve({ createModelReference: () => new Promise((done) => { release = done }) })
  group.dispose()
  release({ object: {}, dispose: () => { disposed++ } })
  await pending
  assert.equal(disposed, 1, 'late references must be disposed rather than cached in a closed group')
  assert.equal(group._previews.size, 0)
  const active = new FileReferences({}, uri)
  active.children.push({ uri })
  let releasedDuplicates = 0
  const resolver = { createModelReference: async () => ({ object: {}, dispose: () => { releasedDuplicates++ } }) }
  await Promise.all([active.resolve(resolver), active.resolve(resolver)])
  active.dispose()
  assert.equal(releasedDuplicates, 2, 'concurrent resolutions must release both the cached and duplicate reference')
})
