// Chuan hoa grammar/config lay tu VS Code cho bo kiem tra cua Orca:
//  - bo comment JSONC va dau phay thua trong language-configuration
//  - surroundingPairs / autoClosingPairs dang mang [a,b] -> {open, close}
//  - trong "captures", bo cac khoa khong phai so (loi co san o grammar xml/qrc/ui)
// Dung: node normalize-syntaxes.mjs <thu-muc-syntaxes>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: node normalize-syntaxes.mjs <dir>')

function stripJsonc(text) {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += n; i++ } else if (c === '"') inStr = false
    } else if (c === '"') { inStr = true; out += c }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n' }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++ }
    else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const pairsToObjects = (arr) => Array.isArray(arr)
  ? arr.map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p))
  : arr

function fixCaptures(node) {
  if (Array.isArray(node)) { node.forEach(fixCaptures); return }
  if (!node || typeof node !== 'object') return
  for (const key of ['captures', 'beginCaptures', 'endCaptures', 'whileCaptures']) {
    const cap = node[key]
    if (cap && typeof cap === 'object' && !Array.isArray(cap)) {
      for (const k of Object.keys(cap)) if (!/^\d+$/.test(k)) delete cap[k]
    }
  }
  for (const v of Object.values(node)) fixCaptures(v)
}

for (const name of readdirSync(dir)) {
  if (!name.endsWith('.json')) continue
  const file = join(dir, name)
  const json = JSON.parse(stripJsonc(readFileSync(file, 'utf8')))
  if (name.endsWith('-configuration.json')) {
    if (json.surroundingPairs) json.surroundingPairs = pairsToObjects(json.surroundingPairs)
    if (json.autoClosingPairs) json.autoClosingPairs = pairsToObjects(json.autoClosingPairs)
  } else {
    fixCaptures(json)
  }
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  console.log('ok', name)
}
