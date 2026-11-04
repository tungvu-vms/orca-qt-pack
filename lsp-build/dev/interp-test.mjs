// Chay discoverInterpreters tren cac du an mau, in interpreter duoc chon (dau danh sach) va ca danh sach.
// Dung: node interp-test.mjs <out.txt>   (build truoc: npx esbuild src/interpreters.ts --bundle --platform=node --format=esm --outfile=dist-test/interpreters.mjs)
import { writeFileSync } from 'node:fs'
import { discoverInterpreters } from '../dist-test/interpreters.mjs'

const R = '<repo>\\samples\\interp-cases'
const cases = [
  ['A khong venv', `${R}\\a-no-venv\\main.py`, `${R}\\a-no-venv`, 'global'],
  ['B mot .venv', `${R}\\b-one-venv\\main.py`, `${R}\\b-one-venv`, '.venv'],
  ['C nhieu venv', `${R}\\c-multi\\main.py`, `${R}\\c-multi`, 'c-multi\\venv\\'],
  ['D mono/api', `${R}\\d-mono\\svc_api\\app.py`, `${R}\\d-mono`, 'svc_api'],
  ['D mono/ui', `${R}\\d-mono\\svc_ui\\app.py`, `${R}\\d-mono`, 'svc_ui'],
  ['F long nhau', '<repo>\\samples\\demo-app\\main.py', '<repo>', 'demo-app\\.venv'],
  ['E vscode setting', `${R}\\e-vscode\\main.py`, `${R}\\e-vscode`, 'envs\\work'],
  ['demo-app thuc', '<repo>\\samples\\demo-app\\main.py', '<repo>\\samples\\demo-app', '.venv']
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
