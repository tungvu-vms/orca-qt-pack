// Verify the complete plugin file set, including additions/deletions, not just git diff.
// Like npm run build this refreshes generated files in place.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../plugins/qt-lsp')
function snapshot(dir = root, relative = '', files = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const key = relative ? relative + '/' + entry.name : entry.name
    if (entry.isDirectory()) snapshot(join(dir, entry.name), key, files)
    else files.set(key, readFileSync(join(dir, entry.name)))
  }
  return files
}
const before = snapshot()
const result = spawnSync(process.execPath, ['build.mjs'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
const after = snapshot()
const differences = [...new Set([...before.keys(), ...after.keys()])].filter((key) => !before.get(key)?.equals(after.get(key)))
if (differences.length) {
  console.error('Plugin bundles differ from source; rebuild and include the generated changes:\n' + differences.join('\n'))
  process.exitCode = 1
} else console.log(`Build matches all ${after.size} plugin files byte-for-byte.`)
