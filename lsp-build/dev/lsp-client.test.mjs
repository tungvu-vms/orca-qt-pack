import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const scratch = process.env.QT_LSP_TEST_DIR
const { LspClient } = await import(pathToFileURL(join(scratch, 'lsp-client.js')))

test('aborting an obsolete hover cancels the language-server request immediately', { timeout: 7000 }, async () => {
  const fixture = join(scratch, 'slow-server.mjs')
  writeFileSync(fixture, `
    let buffer = Buffer.alloc(0), cancelled = 0;
    const send = msg => { const body = JSON.stringify(msg); process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body); };
    process.stdin.on('data', data => {
      buffer = Buffer.concat([buffer,data]);
      for (;;) {
        const head = buffer.indexOf('\\r\\n\\r\\n'); if(head < 0) return;
        const size = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,head).toString())[1]);
        if(buffer.length < head+4+size) return;
        const msg = JSON.parse(buffer.subarray(head+4,head+4+size)); buffer = buffer.subarray(head+4+size);
        if(msg.method === '$/cancelRequest') { cancelled++; continue; }
        if(msg.method === 'textDocument/hover') continue;
        send({jsonrpc:'2.0',id:msg.id,result:{cancelled}});
      }
    });
  `)
  const client = new LspClient(process.execPath, [fixture], scratch)
  try {
    const controller = new AbortController()
    const pending = client.request('textDocument/hover', {}, 5000, controller.signal)
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    const state = await client.request('status', {}, 1000)
    assert.equal(state.cancelled, 1, 'cancellation must reach the server')
  } finally { client.kill() }
})
