import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retainedEntry } from './catalog-policy.mjs'
test('same-version catalog entries preserve legacy commit pins and content hashes', () => {
  const old = {
    id: 'owner.legacy',
    releases: [
      { version: '0.5.0', commit: 'original', contentHash: 'approved' }
    ]
  }
  assert.strictEqual(retainedEntry(old, { version: '0.5.0' }), old)
  assert.equal(retainedEntry(old, { version: '0.6.0' }), null)
  assert.equal(retainedEntry(undefined, { version: '0.1.0' }), null)
})
