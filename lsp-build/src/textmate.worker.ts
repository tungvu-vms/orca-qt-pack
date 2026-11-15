// All grammar evaluation and Oniguruma/WASM live here, never on the editor thread.
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type StateStack } from 'vscode-textmate'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import wasmBase64 from 'vscode-oniguruma/release/onig.wasm'
import { allSelectors, bestSelector } from './textmate-theme'
declare const __LSP_LANGUAGE__: 'all' | 'python' | 'cpp' | 'qml'

const loaders: Record<string, () => Promise<{ default: unknown }>> = {
  ...((typeof __LSP_LANGUAGE__ === 'undefined' || __LSP_LANGUAGE__ === 'all' || __LSP_LANGUAGE__ === 'python') ? {
  'source.python': () => import('../vendor/MagicPython.tmLanguage.json'),
  'source.regexp.python': () => import('../vendor/MagicRegExp.tmLanguage.json'),
  } : {}),
  ...((typeof __LSP_LANGUAGE__ === 'undefined' || __LSP_LANGUAGE__ === 'all' || __LSP_LANGUAGE__ === 'qml') ? {
  'source.qml': () => import('../vendor/qml.tmLanguage.json'),
  'source.js': () => import('../vendor/javascript.tmLanguage.json'),
  } : {}),
  ...((typeof __LSP_LANGUAGE__ === 'undefined' || __LSP_LANGUAGE__ === 'all' || __LSP_LANGUAGE__ === 'cpp') ? {
  'source.cpp': () => import('../vendor/cpp.tmLanguage.json'),
  'source.cpp.embedded.macro': () => import('../vendor/cpp.embedded.macro.tmLanguage.json'),
  'source.c': () => import('../vendor/c.tmLanguage.json')
  } : {})
}
const ready = (async () => {
  const data = Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0))
  await loadWASM(data.buffer)
  return new Registry({ onigLib: Promise.resolve({ createOnigScanner, createOnigString }), loadGrammar: async scope => {
    const load = loaders[scope]
    return load ? parseRawGrammar(JSON.stringify((await load()).default), `${scope}.json`) : null
  } })
})()
type Row = { line: number; text: string; before: number; after: number; tokens: { startIndex: number; scopes: string }[] }
type Job = { id: number; version: number; lang: string; lines: string[]; states: StateStack[]; ids: number[]; rows: Row[]; valid: number; at: number; running: boolean }
const jobs = new Map<number, Job>(), grammars = new Map<string, Promise<IGrammar | null>>()
const scopes = new Map<string, string>()
let nextState = 0, active = true
const scopeFor = (list: string[]) => {
  const key = list.join(' '), hit = scopes.get(key)
  if (hit !== undefined) return hit
  let result = ''
  for (let i = list.length - 1; i >= 0 && !result; i--) result = bestSelector(list[i], allSelectors) ?? ''
  if (scopes.size > 2048) scopes.clear()
  scopes.set(key, result)
  return result
}
async function run(job: Job) {
  if (!active || job.running) return
  job.running = true
  try {
    if (!grammars.has(job.lang)) grammars.set(job.lang, ready.then(r => r.loadGrammar(`source.${job.lang}`)))
    const grammar = await grammars.get(job.lang)
    if (!grammar) throw new Error(`No grammar for ${job.lang}`)
    while (active && jobs.get(job.id) === job && job.at < job.lines.length) {
      const rows = [], until = performance.now() + 8
      do {
        const i = job.at++, line = job.lines[i], stack = i ? job.states[i - 1] : INITIAL
        if (i < job.valid) { rows.push(job.rows[i]); continue }
        // Pathological single lines get plain tokens, rather than an unbounded regex run.
        let r = line.length <= 20000 ? grammar.tokenizeLine(line, stack, 50) : null
        // Cold regex compilation can exhaust the first budget on a short line.
        // Retry from the original stack in this worker; never cache partial state.
        if (r?.stoppedEarly) r = grammar.tokenizeLine(line, stack, 200)
        if (r?.stoppedEarly) r = null
        const end = r?.ruleStack ?? stack
        job.states[i] = end
        job.ids[i] = end === INITIAL ? 0 : ++nextState
        const row = { line: i + 1, text: line, before: i ? job.ids[i - 1] : 0, after: job.ids[i], tokens: r?.tokens.map(t => ({ startIndex: t.startIndex, scopes: scopeFor(t.scopes) })) ?? [{ startIndex: 0, scopes: '' }] }
        job.rows[i] = row; rows.push(row)
      } while (job.at < job.lines.length && rows.length < 32 && performance.now() < until)
      self.postMessage({ id: job.id, version: job.version, rows, done: job.at === job.lines.length })
      // Let edits/pause/disposal interrupt large documents between bounded batches.
      await new Promise(done => setTimeout(done, 0))
    }
  } catch (error) { self.postMessage({ id: job.id, error: String(error) }) }
  finally { job.running = false }
}
self.onmessage = ({ data }) => {
  if (data.type === 'active') { active = data.active; if (active) for (const job of jobs.values()) void run(job); return }
  if (data.type === 'dispose') { jobs.delete(data.id); return }
  const old = jobs.get(data.id), lines: string[] = data.lines
  let at = 0
  if (old) while (at < Math.min(old.at, lines.length) && lines[at] === old.lines[at]) at++
  const job: Job = { id: data.id, version: data.version, lang: data.lang, lines, states: old?.states.slice(0, at) ?? [], ids: old?.ids.slice(0, at) ?? [], rows: old?.rows.slice(0, at) ?? [], valid: at, at: 0, running: false }
  jobs.set(job.id, job)
  void run(job)
}
