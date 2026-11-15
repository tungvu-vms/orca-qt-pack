import { test } from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('disabled project environments exclude saved/PATH project Python without executing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qt-lsp-policy-'))
  const bin = join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
  mkdirSync(bin, { recursive: true })
  const python = join(bin, process.platform === 'win32' ? 'python.exe' : 'python3')
  writeFileSync(python, 'not executable; the test intercepts all execution')
  writeFileSync(join(root, '.venv', 'pyvenv.cfg'), 'version = 3.14.0\n')
  const originalExec = cp.execFileSync, originalPath = process.env.PATH
  const calls = []
  try {
    cp.execFileSync = (command) => { calls.push(command); return command === 'py' ? '' : '3.14.0' }
    syncBuiltinESMExports()
    process.env.PATH = bin
    const { discoverInterpreters } = await import(pathToFileURL(join(process.env.QT_LSP_TEST_DIR, 'interpreters.js')))
    const choices = discoverInterpreters(join(root, 'main.py'), root, { projectEnvs: false, saved: python })
    assert(!choices.some((it) => it.path === python), 'saved and PATH project interpreters must be excluded')
    assert(!calls.includes(python), 'version discovery must never execute a project Python')
  } finally {
    cp.execFileSync = originalExec; syncBuiltinESMExports(); process.env.PATH = originalPath
    assert(root.startsWith(join(tmpdir(), 'qt-lsp-policy-')))
    rmSync(root, { recursive: true, force: true })
  }
})
