// Grammar check: tokenizes sample files with vscode-textmate and prints the % of tokens with their own scope (not just the root scope).
// Usage: node tokenize-check.mjs <plugin-dir> <file> [<file> ...]
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(join(process.cwd(), 'x.js'))
const vsctm = require('vscode-textmate')
const oniguruma = require('vscode-oniguruma')

const [pluginDir, ...files] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(join(pluginDir, 'orca-plugin.json'), 'utf8'))
const syntaxes = manifest.contributes.syntaxes
const byScope = new Map(syntaxes.map((s) => [s.scopeName, s]))

const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer
await oniguruma.loadWASM(wasm)
const registry = new vsctm.Registry({
  onigLib: Promise.resolve({ createOnigScanner: (p) => new oniguruma.OnigScanner(p), createOnigString: (s) => new oniguruma.OnigString(s) }),
  loadGrammar: async (scope) => {
    const s = byScope.get(scope)
    if (!s) return null
    return vsctm.parseRawGrammar(readFileSync(join(pluginDir, s.path), 'utf8'), s.path)
  }
})

function pick(file) {
  const name = basename(file).toLowerCase()
  return syntaxes.find((s) => (s.filenames || []).some((f) => f.toLowerCase() === name))
    || syntaxes.filter((s) => (s.extensions || []).some((e) => name.endsWith(e.toLowerCase())))
      .sort((a, b) => Math.max(...b.extensions.map((e) => e.length)) - Math.max(...a.extensions.map((e) => e.length)))[0]
}

let failed = false
for (const file of files) {
  const s = pick(file)
  if (!s) { console.log(`${basename(file)}: NO syntax matches this file`); failed = true; continue }
  const grammar = await registry.loadGrammar(s.scopeName)
  if (!grammar) { console.log(`${basename(file)}: could not load ${s.scopeName}`); failed = true; continue }
  let stack = vsctm.INITIAL, total = 0, scoped = 0
  const seen = new Set()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const r = grammar.tokenizeLine(line, stack)
    for (const t of r.tokens) {
      const text = line.slice(t.startIndex, t.endIndex)
      if (!text.trim()) continue
      total++
      if (t.scopes.length > 1) { scoped++; t.scopes.slice(1).forEach((x) => seen.add(x.replace(/\.[a-z0-9-]+$/, ''))) }
    }
    stack = r.ruleStack
  }
  const pct = total ? Math.round((100 * scoped) / total) : 0
  if (pct < 40) failed = true
  console.log(`${basename(file).padEnd(18)} ${s.id.padEnd(16)} ${String(pct).padStart(3)}% tokens colored  [${[...seen].slice(0, 8).join(', ')}]`)
}
process.exit(failed ? 1 : 0)
