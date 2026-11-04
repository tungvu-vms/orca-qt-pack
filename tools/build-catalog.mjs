// Dung orca-catalog.json cho marketplace noi bo cua team.
// Moi plugin trong plugins/ duoc ghim vao commit cuoi cung da sua thu muc cua no (giong repo chinh thuc).
// Dung: node tools/build-catalog.mjs --url <git-url-https-hoac-ssh> --owner <ten-org-hoac-user> [--ref main]
// Commit cac thay doi plugin TRUOC, roi chay script nay, roi commit orca-catalog.json.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const url = arg('url')
const owner = arg('owner')
const ref = arg('ref', 'main')
if (!url || !owner) {
  console.error('usage: node tools/build-catalog.mjs --url <git-url> --owner <owner> [--ref main]')
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..')
const orca = process.platform === 'win32' ? 'orca.cmd' : 'orca'
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })

if (run('git', ['status', '--porcelain', '--', 'plugins']).trim()) {
  console.error('plugins/ co thay doi chua commit: commit truoc roi chay lai')
  process.exit(1)
}

const CATEGORIES = { data: ['languages'], 'trusted-worker': ['commands-panels'] }
const plugins = []
for (const dir of readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const sourcePath = `plugins/${dir.name}`
  const manifest = JSON.parse(readFileSync(join(root, sourcePath, 'orca-plugin.json'), 'utf8'))
  const out = JSON.parse(run(orca, ['plugin', 'release-entry', sourcePath, '--json']))
  if (!out.ok) throw new Error(`${sourcePath}: ${out.error?.message}`)
  const entry = out.result.entry
  entry.commit = run('git', ['log', '-1', '--format=%H', 'HEAD', '--', sourcePath]).trim()
  if (manifest.license) entry.license = manifest.license
  const categories = manifest.contributes?.iconThemes ? ['icons'] : CATEGORIES[manifest.execution] ?? ['other']
  plugins.push({
    id: `${owner}.${manifest.id}`,
    source: { kind: 'git', url, ref, path: sourcePath },
    description: manifest.description,
    categories,
    releases: [entry]
  })
  console.log(`${owner}.${manifest.id} ${entry.version} @ ${entry.commit.slice(0, 10)} ${entry.contentHash.slice(0, 12)}`)
}

const catalog = {
  $schema: 'https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-catalog.v2.schema.json',
  catalogVersion: 2,
  name: 'Qt Developer Pack (team)',
  owner,
  plugins
}
writeFileSync(join(root, 'orca-catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
const v = JSON.parse(run(orca, ['plugin', 'validate', 'orca-catalog.json', '--json']))
console.log(v.ok ? 'orca-catalog.json hop le' : `catalog loi: ${v.error?.message}`)
process.exit(v.ok ? 0 : 1)
