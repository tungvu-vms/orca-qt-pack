import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

test('explicit compilation database folders are resolved against the project and invalid paths fail', async () => {
  const out = join(process.env.QT_LSP_TEST_DIR, 'servers.mjs')
  await build({
    entryPoints: ['src/servers.ts'],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'warning'
  })
  const s = await import(pathToFileURL(out))
  const probeOut = join(process.env.QT_LSP_TEST_DIR, 'probe.mjs')
  await build({ entryPoints: ['src/probe-script.ts'], outfile: probeOut, bundle: true, format: 'esm', platform: 'node', logLevel: 'warning' })
  const { EXT_RE } = await import(pathToFileURL(probeOut))
  for (const extension of ['.cpp', '.c++', '.tpp', '.tcc', '.ixx', '.cppm']) assert(new RegExp(EXT_RE.cpp, 'i').test(`file${extension}`))
  assert.equal(typeof s.compilationDatabaseDir, 'function')
  const root = mkdtempSync(join(tmpdir(), 'cpp-database-'))
  try {
    mkdirSync(join(root, 'custom'))
    writeFileSync(join(root, 'custom', 'compile_commands.json'), '[]')
    assert.equal(s.compilationDatabaseDir(root, 'custom'), join(root, 'custom'))
    assert.equal(
      s.compilationDatabaseDir(join(root, 'other'), join(root, 'custom')),
      join(root, 'custom')
    )
    assert.throws(
      () => s.compilationDatabaseDir(root, 'missing'),
      /compilation|compile_commands/i
    )
    assert.throws(() => s.findClangd(join(root, 'missing-clangd')), /clangd/i)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const executable = join(
      bin,
      process.platform === 'win32' ? 'clangd.exe' : 'clangd'
    )
    writeFileSync(executable, 'not executed')
    const prior = process.env.PATH
    try {
      process.env.PATH = bin
      assert.equal(
        s.findClangd(''),
        executable,
        'PATH must take precedence over Qt Creator/other fallbacks'
      )
    } finally {
      process.env.PATH = prior
    }
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()))
    assert(basename(root).startsWith('cpp-database-'))
    rmSync(root, { recursive: true, force: true })
  }
})
