// Read-only source-tree hygiene. Secret values are scanned separately by Gitleaks.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export function auditRepository(root, files) {
  const problems = []
  const artifact = /(?:^|\/)(?:node_modules|_scratch|_ref|dist-test|\.orca|\.superpowers|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|coverage)(?:\/|$)|(?:^|\/)(?:\.DS_Store|Thumbs\.db|Desktop\.ini)$|\.(?:log|pyc|pyo|tsbuildinfo)$/i
  for (const path of files) {
    if (artifact.test(path)) { problems.push({ path, reason: 'local artifact must not be tracked' }); continue }
    const name = basename(path)
    if ((/^\.env(?:\.|$)/.test(name) && !/\.example$/.test(name)) || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(name) || name === 'keys.txt' || /(?:^|\/)secrets\//.test(path)) {
      problems.push({ path, reason: 'credential file must not be tracked' }); continue
    }
    if (!path.endsWith('.md') || !existsSync(resolve(root, path))) continue
    const text = readFileSync(resolve(root, path), 'utf8')
    for (const [, raw] of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = raw.startsWith('<') ? raw.slice(1, raw.indexOf('>')) : raw.split(/\s+/)[0]
      if (!target || /^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(target)) continue
      const local = decodeURIComponent(target.split('#')[0].split('?')[0])
      if (local && !existsSync(resolve(root, dirname(path), local))) problems.push({ path, reason: `missing link target: ${local}` })
    }
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..')
  // Index plus untracked, non-ignored sources covers new files before a commit.
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
  const problems = auditRepository(root, files)
  for (const p of problems) console.error(`${p.path}: ${p.reason}`)
  console.log(`Repository hygiene: ${files.length} source paths, ${problems.length} problems.`)
  if (problems.length) process.exitCode = 1
}
