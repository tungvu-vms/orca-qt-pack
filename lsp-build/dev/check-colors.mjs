// Check: tokenizes a Python file with MagicPython, picks Dark+ theme selectors the way textmate.ts does, and writes each token's color.
// Usage: node dev/check-colors.mjs <file.py> <out.txt>   (run from lsp-build/)
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const tm = require('vscode-textmate')
const onig = require('vscode-oniguruma')
const v = (f) => JSON.parse(readFileSync(new URL(`../vendor/${f}`, import.meta.url)))
await onig.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer)
const reg = new tm.Registry({
  onigLib: Promise.resolve({ createOnigScanner: (p) => new onig.OnigScanner(p), createOnigString: (s) => new onig.OnigString(s) }),
  loadGrammar: async (s) => s === 'source.python' ? tm.parseRawGrammar(JSON.stringify(v('MagicPython.tmLanguage.json')), 'p.json') : s === 'source.regexp.python' ? tm.parseRawGrammar(JSON.stringify(v('MagicRegExp.tmLanguage.json')), 'r.json') : null
})
const g = await reg.loadGrammar('source.python')
const theme = v('themes.json').dark
const sel = new Map()
for (const r of theme.tokenColors) { if (!r.scope) continue; for (const s of (Array.isArray(r.scope) ? r.scope : r.scope.split(','))) { const x = s.trim(); if (x && !/\s/.test(x)) sel.set(x, { ...(sel.get(x) ?? {}), ...r.settings }) } }
const best = (scope) => { let b = null; for (const s of sel.keys()) if ((scope === s || scope.startsWith(s + '.')) && (!b || s.length > b.length)) b = s; return b }
let stack = tm.INITIAL
const out = []
const text = readFileSync(process.argv[2], 'utf8')
for (const line of text.split(/\r?\n/)) {
  const r = g.tokenizeLine(line, stack)
  for (const t of r.tokens) {
    const word = line.slice(t.startIndex, t.endIndex)
    if (!word.trim()) continue
    let token = ''
    for (let i = t.scopes.length - 1; i >= 0 && !token; i--) token = best(t.scopes[i]) ?? ''
    out.push(`${word.padEnd(16)} ${(sel.get(token)?.foreground ?? '-').padEnd(8)} ${t.scopes.slice(1).join(' > ')}`)
  }
  stack = r.ruleStack
}
writeFileSync(process.argv[3], out.join('\n'))
