// Bundle source into a temporary directory; never write test artifacts into a plugin.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const scratch = mkdtempSync(join(tmpdir(), 'qt-lsp-tests-'))
try {
  await build({ entryPoints: ['src/core.ts', 'src/interpreters.ts', 'src/lsp-client.ts'], outdir: scratch, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning' })
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'dev/ide.test.mjs', 'dev/diagnostics.test.mjs', 'dev/lifecycle.test.mjs', 'dev/lsp-client.test.mjs', 'dev/transport.test.mjs', 'dev/interpreters.test.mjs', 'dev/worker.test.mjs'], {
    cwd: import.meta.dirname + '/..', stdio: 'inherit', env: { ...process.env, QT_LSP_TEST_DIR: scratch }
  })
  process.exitCode = result.status ?? 1
} finally {
  if (dirname(scratch) === resolve(tmpdir()) && basename(scratch).startsWith('qt-lsp-tests-')) rmSync(scratch, { recursive: true, force: true })
}
