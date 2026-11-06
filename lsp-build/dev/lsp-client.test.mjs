import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

test('file cancellation interrupts CPU-bound analysis and cleans up its scoped folder', { timeout: 8000 }, async () => {
  const fixture = join(scratch, 'busy-server.mjs')
  writeFileSync(fixture, `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    const name = process.argv.find(x => x.startsWith('--cancellationReceive=file:'))?.split('file:')[1];
    const folder = name ? path.join(os.tmpdir(),'python-languageserver-cancellation',name) : '';
    let buffer=Buffer.alloc(0), interrupted=false;
    const send = msg => { const body=JSON.stringify(msg); process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body); };
    process.stdin.on('data',data=>{buffer=Buffer.concat([buffer,data]);for(;;){const head=buffer.indexOf('\\r\\n\\r\\n');if(head<0)return;
      const size=Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,head).toString())[1]);if(buffer.length<head+4+size)return;
      const msg=JSON.parse(buffer.subarray(head+4,head+4+size));buffer=buffer.subarray(head+4+size);
      if(msg.method==='busy'){interrupted=false;const until=Date.now()+3000;while(Date.now()<until){if(folder&&fs.existsSync(path.join(folder,'cancellation-'+msg.id+'.tmp'))){interrupted=true;break;}}send({jsonrpc:'2.0',id:msg.id,result:{interrupted}});}
      else if(msg.id)send({jsonrpc:'2.0',id:msg.id,result:{interrupted,folder}});
    }});
  `)
  const client = new LspClient(process.execPath, [fixture], scratch, undefined, { fileCancellation: true })
  let folder
  try {
    const info = await client.request('status', {}, 1000); folder = info.folder
    assert(folder, 'client must configure the file-cancellation argument')
    const controller = new AbortController(), pending = client.request('busy', {}, 5000, controller.signal)
    setTimeout(() => controller.abort(), 60)
    await assert.rejects(pending, { name: 'AbortError' })
    const status = await client.request('status', {}, 1000)
    assert.equal(status.interrupted, true, 'the busy server must observe cancellation before reading stdin again')
    await assert.rejects(client.request('busy', {}, 60), /timed out/)
    assert.equal((await client.request('status', {}, 1000)).interrupted, true)
  } finally { client.kill() }
  for (let i = 0; i < 30 && existsSync(folder); i++) await new Promise(done => setTimeout(done, 20))
  assert(!existsSync(folder), 'server exit must remove only its own cancellation folder')
})

test('real basedpyright starts its background analyzer with file cancellation', { timeout: 12000 }, async () => {
  const client = new LspClient(process.execPath, [resolve('node_modules/basedpyright/langserver.index.js'), '--stdio'], scratch, undefined, { fileCancellation: true })
  const logs = []
  client.onNotification('window/logMessage', p => logs.push(p.message))
  client.onRequest('workspace/configuration', () => [{}])
  try {
    await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(scratch).href, capabilities: {} })
    client.notify('initialized', {})
    client.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(join(scratch, 'background.py')).href, languageId: 'python', version: 1, text: 'answer = 42\n' } })
    for (let i = 0; i < 100 && !logs.some(line => /Background analysis.*started/i.test(line)); i++) await new Promise(done => setTimeout(done, 50))
    assert(logs.some(line => /Background analysis.*started/i.test(line)), JSON.stringify(logs))
    console.log(logs.filter(line => /Background analysis.*started/i.test(line)).join('\n'))
  } finally { client.kill() }
})
