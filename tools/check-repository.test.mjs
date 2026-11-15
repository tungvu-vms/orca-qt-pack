import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { auditRepository } from './check-repository.mjs'

test('repository audit rejects artifacts and credential files without reading their contents', () => {
  const problems = auditRepository(process.cwd(), ['lsp-build/node_modules/pkg/index.js', '_scratch/notes.md', 'lsp-build/dist-test/shot.png', 'local/.env', 'backup.pfx', '.orca/state.json'])
  assert.equal(problems.length, 6)
  assert(problems.every(p => /artifact|credential/.test(p.reason)))
})
test('repository audit permits plugin bundles, license notices, examples and screenshots', () => {
  assert.deepEqual(auditRepository(process.cwd(), ['plugins/qt-lsp/editor/assets/editor.js', 'plugins/qt-icons/icons/key.svg', 'LICENSE', '.env.example', 'docs/panel-files.png']), [])
})
test('repository audit catches broken local Markdown links and accepts external links', () => {
  const root = mkdtempSync(join(tmpdir(), 'qt-repo-audit-'))
  try {
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'README.md'), '[Guide](docs/guide.md#build) [Website](https://example.com) [Install](orca://plugins/demo)')
    assert.deepEqual(auditRepository(root, ['README.md']).map(p => p.reason), ['missing link target: docs/guide.md'])
    writeFileSync(join(root, 'docs/guide.md'), '# Build\n')
    assert.deepEqual(auditRepository(root, ['README.md', 'docs/guide.md']), [])
  } finally {
    assert.equal(dirname(root), resolve(tmpdir())); assert(basename(root).startsWith('qt-repo-audit-'))
    rmSync(root, { recursive: true, force: true })
  }
})
