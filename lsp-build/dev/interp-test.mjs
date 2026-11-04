// Runs discoverInterpreters on the sample projects and prints the chosen interpreter (head of the list) plus the full list.
// Usage: node dev/interp-test.mjs <out.txt>   (run from lsp-build/ after make-interp-fixtures.ps1; build first: npx esbuild src/interpreters.ts --bundle --platform=node --format=esm --outfile=dist-test/interpreters.mjs)
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { discoverInterpreters } from '../dist-test/interpreters.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '')
const R = `${REPO}\\samples\\interp-cases`
const cases = [
  ['A no venv', `${R}\\a-no-venv\\main.py`, `${R}\\a-no-venv`, 'global'],
  ['B one .venv', `${R}\\b-one-venv\\main.py`, `${R}\\b-one-venv`, '.venv'],
  ['C several venvs', `${R}\\c-multi\\main.py`, `${R}\\c-multi`, 'c-multi\\venv\\'],
  ['D mono/api', `${R}\\d-mono\\svc_api\\app.py`, `${R}\\d-mono`, 'svc_api'],
  ['D mono/ui', `${R}\\d-mono\\svc_ui\\app.py`, `${R}\\d-mono`, 'svc_ui'],
  ['F nested', `${REPO}\\samples\\demo-app\\main.py`, REPO, 'demo-app\\.venv'],
  ['E vscode setting', `${R}\\e-vscode\\main.py`, `${R}\\e-vscode`, 'envs\\work'],
  ['demo-app real', `${REPO}\\samples\\demo-app\\main.py`, `${REPO}\\samples\\demo-app`, '.venv']
]
const out = []
let fail = 0
for (const [name, file, root, expect] of cases) {
  const list = discoverInterpreters(file, root)
  const pick = list[0]
  const ok = pick && (expect === 'global' ? pick.source === 'global' : pick.path.toLowerCase().includes(expect.toLowerCase()))
  if (!ok) fail++
  out.push(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(18)} -> ${pick ? `${pick.label} [${pick.source}] ${pick.path}` : '(none)'}`)
  out.push(`     all: ${list.map((i) => `${i.label}[${i.source}]`).join(' | ')}`)
}
out.push(`fail=${fail}`)
writeFileSync(process.argv[2], out.join('\n'))
process.exit(fail ? 1 : 0)
