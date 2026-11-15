import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('installing another language agent preserves scripts needed by an imminent startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-install-'))
  try {
    const installs = []
    for (const language of ['python', 'cpp', 'qml']) {
      const output = join(process.env.QT_LSP_TEST_DIR, `remote-${language}.mjs`)
      await build({
        entryPoints: ['src/remote.ts'],
        outfile: output,
        bundle: true,
        platform: 'node',
        format: 'esm',
        define: { __LSP_LANGUAGE__: JSON.stringify(language) },
        logLevel: 'warning'
      })
      const { RemoteAgent } = await import(pathToFileURL(output))
      const source = `// ${language} fixture agent`,
        agent = new RemoteAgent('local-fixture', 'unused', source, {})
      // Execute the actual install script locally with Node instead of connecting SSH.
      agent.run = async (_, script) => ({
        code: 0,
        out: (await promisify(execFile)(process.execPath, ['-e', script], {
          env: { ...process.env, USERPROFILE: home, HOME: home },
          encoding: 'utf8', windowsHide: true
        })).stdout,
        err: ''
      })
      installs.push(agent.install(), agent.install())
    }
    await Promise.all(installs)
    const dir = join(home, '.orca-qt-lsp'),
      sources = readdirSync(dir)
        .filter((n) => n.endsWith('.mjs'))
        .map((n) => readFileSync(join(dir, n), 'utf8'))
    assert.equal(
      sources.length,
      3,
      'a peer installer must not prune another language executable'
    )
    assert(sources.includes('// python fixture agent'))
    assert(sources.includes('// cpp fixture agent'))
    assert(sources.includes('// qml fixture agent'))
  } finally {
    assert.equal(dirname(home), resolve(tmpdir()))
    assert(basename(home).startsWith('agent-install-'))
    rmSync(home, { recursive: true, force: true })
  }
})
