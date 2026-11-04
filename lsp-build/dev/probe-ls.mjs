// Probes a language server over stdio: definition, hover, completion, semantic tokens.
// Usage: node probe-ls.mjs <out.txt> <root> <file-rel> <languageId> <cmd> [args...] -- <line0>:<col0> ...
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
const [outFile, root, rel, languageId, cmd, ...args] = argv.slice(0, sep)
const positions = argv.slice(sep + 1).map((p) => { const [l, c] = p.split(':').map(Number); return { line: l, character: c } })
const p = spawn(cmd, args, { cwd: root, windowsHide: true })
let buf = Buffer.alloc(0), id = 0
const pending = new Map()
p.stderr.on('data', () => {})
p.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  for (;;) {
    const h = buf.indexOf('\r\n\r\n'); if (h < 0) break
    const len = +/Content-Length: (\d+)/i.exec(buf.slice(0, h).toString())[1]
    if (buf.length < h + 4 + len) break
    const m = JSON.parse(buf.slice(h + 4, h + 4 + len).toString()); buf = buf.slice(h + 4 + len)
    if (m.id !== undefined && pending.has(m.id) && m.method === undefined) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, result: m.method === 'workspace/configuration' ? m.params.items.map(() => ({})) : null })
  }
})
const send = (m) => { const s = JSON.stringify(m); p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`) }
const req = (method, params, ms = 30000) => new Promise((r) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); r({ error: { message: 'timeout' } }) }, ms); pending.set(i, (x) => { clearTimeout(t); r(x) }); send({ jsonrpc: '2.0', id: i, method, params }) })
const rootUri = pathToFileURL(resolve(root)).href, uri = pathToFileURL(resolve(root, rel)).href
const text = readFileSync(join(root, rel), 'utf8')
const lines = text.split(/\r?\n/)
const out = []
const init = await req('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'ws' }], capabilities: { textDocument: { definition: {}, hover: { contentFormat: ['markdown', 'plaintext'] }, completion: { completionItem: {} }, semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] } }, workspace: { configuration: true } } }, 60000)
const caps = init.result?.capabilities ?? {}
out.push(`server: ${init.result?.serverInfo?.name ?? '?'} ${init.result?.serverInfo?.version ?? ''}`)
out.push(`caps: def=${!!caps.definitionProvider} hover=${!!caps.hoverProvider} completion=${!!caps.completionProvider} semantic=${!!caps.semanticTokensProvider} format=${!!caps.documentFormattingProvider}`)
const legend = caps.semanticTokensProvider?.legend
if (legend) out.push(`legend: ${legend.tokenTypes.join(',')}`)
send({ jsonrpc: '2.0', method: 'initialized', params: {} })
send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId, version: 1, text } } })
await new Promise((r) => setTimeout(r, 4000))
for (const pos of positions) {
  const word = (lines[pos.line].slice(pos.character).match(/^[\w.]+/) ?? [''])[0]
  const d = await req('textDocument/definition', { textDocument: { uri }, position: pos })
  const h = await req('textDocument/hover', { textDocument: { uri }, position: pos })
  const locs = [].concat(d.result ?? []).map((l) => { const u = l.uri ?? l.targetUri; const f = u.startsWith('file:') ? fileURLToPath(u) : u; return `${f.split(/[\\/]/).slice(-2).join('/')}:${(l.range ?? l.targetSelectionRange).start.line + 1}` })
  const hv = typeof h.result?.contents === 'string' ? h.result.contents : h.result?.contents?.value ?? (Array.isArray(h.result?.contents) ? h.result.contents.map((x) => x.value ?? x).join(' ') : '')
  out.push(`L${pos.line + 1}:${pos.character} ${word.padEnd(16)} def=[${locs.join(' | ') || (d.error ? 'ERR ' + d.error.message : '-')}] hover=[${(hv || '').replace(/```\w*/g, '').replace(/\s+/g, ' ').trim().slice(0, 90)}]`)
}
const c = await req('textDocument/completion', { textDocument: { uri }, position: positions[0] })
const items = Array.isArray(c.result) ? c.result : c.result?.items ?? []
out.push(`completion@first: ${items.length} items: ${items.slice(0, 6).map((i) => i.label).join(', ')}`)
if (legend) {
  const s = await req('textDocument/semanticTokens/full', { textDocument: { uri } })
  out.push(`semantic tokens: ${(s.result?.data?.length ?? 0) / 5}`)
}
writeFileSync(outFile, out.join('\n'))
await req('shutdown', null, 3000); send({ jsonrpc: '2.0', method: 'exit' }); setTimeout(() => { p.kill(); process.exit(0) }, 300)
