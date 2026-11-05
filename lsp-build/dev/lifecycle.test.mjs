import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { createCore } = await import(pathToFileURL(join(process.env.QT_LSP_TEST_DIR, 'core.js')))

test('concurrent editor initialization starts one language server per project', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qt-lsp-startup-'))
  const path = join(root, 'main.py'), logs = []
  writeFileSync(path, 'value = 42\n')
  const settings = { pyrightPath: resolve('node_modules/basedpyright/langserver.index.js'), nodePath: process.execPath, projectEnvironments: 'off' }
  const core = createCore({ log: (line) => logs.push(line), post() {}, setting: async (k, fallback) => settings[k] ?? fallback,
    storageGet: async () => null, storageSet: async () => {}, roots: async () => ({ focused: root, roots: [root] }) })
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => core.handlers['lsp.serverInfo']({ path })))
    assert(results.every((r) => r.server === 'Pyright'))
    assert.equal(logs.filter((line) => line.startsWith('spawn python:')).length, 1, 'parallel calls must share the pending startup')
  } finally {
    core.shutdown()
    assert(root.startsWith(join(tmpdir(), 'qt-lsp-startup-')))
    rmSync(root, { recursive: true, force: true })
  }
})

test('restart during initialization starts a replacement rather than reusing the stopped startup', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qt-lsp-restart-')), path = join(root, 'main.py')
  writeFileSync(path, 'value = 42\n')
  const entry = join(root, 'slow.mjs')
  writeFileSync(entry, `
    let buffer = Buffer.alloc(0);
    const send = msg => { const body = JSON.stringify(msg); process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body); };
    process.stdin.on('data', data => { buffer = Buffer.concat([buffer,data]); for (;;) {
      const head = buffer.indexOf('\\r\\n\\r\\n'); if(head < 0) return;
      const size = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,head).toString())[1]); if(buffer.length < head+4+size) return;
      const msg = JSON.parse(buffer.subarray(head+4,head+4+size)); buffer = buffer.subarray(head+4+size);
      if(msg.method === 'exit') process.exit(0);
      if(msg.method === 'initialize') { process.stderr.write('INITIALIZING\\n'); setTimeout(() => send({jsonrpc:'2.0',id:msg.id,result:{capabilities:{}}}),400); }
      else if(msg.id) send({jsonrpc:'2.0',id:msg.id,result:null});
    }});
  `)
  const logs = []
  let initializing
  const waiting = new Promise((done) => { initializing = done })
  const config = { pyrightPath: entry, nodePath: process.execPath, projectEnvironments: 'off' }
  const core = createCore({ log: (line) => { logs.push(line); if (line.includes('INITIALIZING')) initializing() }, post() {},
    setting: async (k, fallback) => config[k] ?? fallback, storageGet: async () => null, storageSet: async () => {},
    roots: async () => ({ focused: root, roots: [root] }) })
  try {
    const original = core.handlers['lsp.serverInfo']({ path }).catch((e) => e)
    await waiting
    const replacement = await core.handlers['lsp.restart']({ path })
    assert.equal(typeof replacement.detail, 'string')
    assert.equal(logs.filter((line) => line.startsWith('spawn python:')).length, 2)
    await original
  } finally { core.shutdown(); assert(root.startsWith(join(tmpdir(), 'qt-lsp-restart-'))); rmSync(root, { recursive: true, force: true }) }
})
