import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('JSON byte budgets cover Vietnamese, CJK, escaped text and emoji', async () => {
  assert(existsSync('src/transport.ts'), 'shared byte-budget helper must exist')
  const out = join(process.env.QT_LSP_TEST_DIR, 'transport.js')
  await build({ entryPoints: ['src/transport.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm' })
  const { jsonBytes, chunkText, limitItems, RESPONSE_BUDGET, REQUEST_BUDGET } = await import(pathToFileURL(out))
  assert(REQUEST_BUDGET < 64 * 1024, 'editor inputs use the 64 KiB lane, not the 1 MiB result lane')
  const text = ('Tiếng Việt 漢字 😀\n\t\\"\u0000').repeat(30000)
  assert.equal(jsonBytes({ text }), Buffer.byteLength(JSON.stringify({ text })))
  const chunks = chunkText(text)
  assert.equal(chunks.join(''), text)
  for (const part of chunks) {
    assert(jsonBytes({ path: 'x'.repeat(4000), version: 1, part, index: 1, total: chunks.length }) < 64 * 1024)
    assert(!/[\uD800-\uDBFF]$/.test(part), 'never split a surrogate pair')
  }
  const items = Array.from({ length: 2000 }, () => ({ message: '漢😀\u0000'.repeat(500) }))
  const make = (items) => ({ path: '/project/main.py', version: 2, items })
  const capped = limitItems(items, make, 220000)
  assert(capped.length > 0 && capped.length < items.length)
  assert(jsonBytes(make(capped)) <= 220000)
  assert(RESPONSE_BUDGET < 1024 * 1024)
})
