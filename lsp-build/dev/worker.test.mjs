import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('SSH forwarding waits for policy reload and caps references after adding the host', async () => {
  const scratch = process.env.QT_LSP_TEST_DIR
  globalThis.__qtRemote = { instances: [] }
  const outfile = join(scratch, 'worker.mjs')
  await build({ entryPoints: ['src/worker.ts'], outfile, bundle: true, format: 'esm', platform: 'node', plugins: [{
    name: 'ssh-boundary', setup(b) {
      b.onResolve({ filter: /^\.\/remote$/ }, () => ({ path: 'remote', namespace: 'ssh-boundary' }))
      b.onLoad({ filter: /.*/, namespace: 'ssh-boundary' }, () => ({ contents: `
        export const isValidHost = value => /^[a-zA-Z0-9.-]+$/.test(value);
        export const findSsh = value => value || 'ssh';
        export class RemoteAgent {
          constructor(host, ssh, source, settings) { this.host = host; this.settings = settings; globalThis.__qtRemote.instances.push(this); }
          async start() { this.alive = true; }
          stop() { this.alive = false; }
          async call() { return { locations: Array.from({length: 5500}, () => ({path:'/p/a.py', range:{start:{line:0,character:0},end:{line:0,character:1}},inWorkspace:true,openable:true})) }; }
        }
      ` }))
    }
  }] })
  writeFileSync(join(scratch, 'agent.mjs'), '// test remote source')
  const { default: activate } = await import(pathToFileURL(outfile))
  let changed, release
  let policy = 'on', hold = false
  const handlers = {}
  activate({
    log() {}, storage: { get: async () => null },
    panels: { handle(name, handler) { handlers[name] = handler }, post() {} },
    events: { on() {} },
    settings: {
      onDidChange(callback) { changed = callback },
      async get(key) {
        if (key === 'projectEnvironments') {
          if (hold) await new Promise((done) => { release = done })
          return policy
        }
        return null
      }
    }
  })
  const host = 'h'.repeat(100)
  const input = { path: `@${host}:/project/main.py`, position: { line: 0, character: 0 } }
  await handlers['lsp.references'](input)
  assert.equal(globalThis.__qtRemote.instances[0].settings.projectEnvironments, 'on')
  policy = 'off'; hold = true; changed()
  const pending = handlers['lsp.references'](input)
  await new Promise((done) => setTimeout(done, 30))
  assert.equal(globalThis.__qtRemote.instances.length, 1, 'no agent may start with the previous policy while settings reload')
  release()
  const result = await pending
  assert.equal(globalThis.__qtRemote.instances[1].settings.projectEnvironments, 'off')
  assert(result.locations.length > 0 && result.locations.length < 5500)
  assert.equal(result.truncated, true)
  assert(Buffer.byteLength(JSON.stringify(result)) <= 700000, 'host prefixes must be included in the final JSON budget')
  delete globalThis.__qtRemote
})
