// E2E agent tu xa qua SSH: node dev/remote-e2e.mjs <ssh-host> <json {hash,size,sizeCrlf} cua file tren may kia> <dong> <cot>
import { build } from 'file:///<repo>/lsp-build/node_modules/esbuild/lib/main.js'
import { readFileSync } from 'node:fs'
const [host, infoJson, line, col] = process.argv.slice(2)
await build({ entryPoints: ['<repo>/lsp-build/src/remote.ts'], bundle: true, format: 'esm', platform: 'node', outfile: './remote-test.mjs', logLevel: 'error' })
const { RemoteAgent, findSsh } = await import('./remote-test.mjs?' + Date.now())
const a = new RemoteAgent(host, findSsh(''), readFileSync('<repo>/plugins/qt-lsp/worker/agent.mjs', 'utf8'), {})
a.log = (l) => console.log('LOG', l.slice(0, 220))
let t0 = Date.now()
try { console.log('START', JSON.stringify(await a.start()), Date.now() - t0, 'ms') } catch (e) { console.log('START-FAIL', e.message); process.exit(0) }
const info = JSON.parse(infoJson)
t0 = Date.now(); const r = await a.call('lsp.attach', { language: 'python', ...info, hints: [] }, 400000)
console.log('ATTACH', JSON.stringify(r), Date.now() - t0, 'ms')
if (r.path) {
  await a.call('lsp.open', { path: r.path, version: 1 })
  t0 = Date.now(); const d = await a.call('lsp.definition', { path: r.path, position: { line: +line, character: +col } }); console.log('DEF', JSON.stringify(d).slice(0, 260), Date.now() - t0, 'ms')
  t0 = Date.now(); const h = await a.call('lsp.hover', { path: r.path, position: { line: +line, character: +col } }); console.log('HOVER', JSON.stringify(h).slice(0, 160), Date.now() - t0, 'ms')
}
a.stop(); setTimeout(() => process.exit(0), 3000)
