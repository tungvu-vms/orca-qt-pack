// Remote agent E2E over SSH: node dev/remote-e2e.mjs <ssh-host> <json {hash,size,sizeCrlf} of the file on the remote machine> <line> <col>
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const lspBuild = new URL('..', import.meta.url)
const repo = new URL('../..', import.meta.url)
const { build } = await import(pathToFileURL(fileURLToPath(new URL('node_modules/esbuild/lib/main.js', lspBuild))).href)
const [host, infoJson, line, col] = process.argv.slice(2)
await build({ entryPoints: [fileURLToPath(new URL('src/remote.ts', lspBuild))], bundle: true, format: 'esm', platform: 'node', outfile: fileURLToPath(new URL('remote-test.mjs', import.meta.url)), logLevel: 'error' })
const { RemoteAgent, findSsh } = await import(new URL('remote-test.mjs?' + Date.now(), import.meta.url).href)
const a = new RemoteAgent(host, findSsh(''), readFileSync(new URL('plugins/qt-lsp/worker/agent.mjs', repo), 'utf8'), {})
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
