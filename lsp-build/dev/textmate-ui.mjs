import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename, extname } from 'node:path'
import assert from 'node:assert/strict'

const scratch = mkdtempSync(join(tmpdir(), 'qt-textmate-ui-'))
const extra = existsSync('worker-build.mjs') ? [(await import('../worker-build.mjs')).workerPlugin(scratch)] : []
await build({ entryPoints: ['dev/textmate-harness.ts'], outdir: scratch, entryNames: 'harness', bundle: true, splitting: true, format: 'esm', loader: { '.wasm': 'base64', '.ttf': 'file' }, plugins: extra, logLevel: 'warning' })
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script type="module" src="/harness.js"></script>'); return }
  const file = resolve(scratch, '.' + req.url)
  if (dirname(file) !== resolve(scratch)) { res.writeHead(403).end(); return }
  try { res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript' : 'text/css'); res.end(readFileSync(file)) }
  catch { res.writeHead(404).end() }
})
let browser
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const executablePath = process.env.QT_LSP_BROWSER ?? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(existsSync)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage(), workers = [], liveWorkers = new Set(), errors = []
  page.setDefaultTimeout(10000)
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        if (String(url).includes('textmate.worker') && window.__failWorker) {
          window.__failWorker = false
          setTimeout(() => this.dispatchEvent(new ErrorEvent('error', {message:'forced worker failure'})), 150)
        }
      }
    }
  })
  page.on('worker', worker => { workers.push(worker.url()); liveWorkers.add(worker); worker.on('close', () => liveWorkers.delete(worker)) })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => { if (msg.type() === 'warning' || msg.type() === 'error') console.log(msg.text()) })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.tm)
  await page.evaluate(() => tm.open('py', 'python', 'value = """hello\ncontinued 😀\n"""\nanswer = 42\n'))
  await page.waitForTimeout(150)
  assert(workers.some(url => url.endsWith('/textmate.worker.js')), 'TextMate evaluation must run in a dedicated worker')
  const stringLine = async (id, line, expected) => {
    try { await page.waitForFunction(({id,line,expected}) => tm.types(id,line).some(t => t.type === 2) === expected, {id,line,expected}) }
    catch (error) { console.error({id,line,expected,workers:liveWorkers.size,tokens:await page.evaluate(({id,line})=>tm.types(id,line), {id,line}),background:await page.evaluate(()=>tm.background('python'))}); throw error }
  }
  await stringLine('py', 2, true)
  await page.evaluate(() => tm.edit('py', 1, 1, '# '))
  await stringLine('py', 2, false)
  await page.evaluate(() => tm.replace('py', 'v = """CRLF\r\n漢字 😀\r\n"""\r\n'))
  await stringLine('py', 2, true)
  await page.evaluate(() => tm.replace('py', 'v = """\n' + 'x'.repeat(21000) + '\nstill a string\n"""\nanswer = 42\n'))
  await stringLine('py', 3, true)
  await stringLine('py', 5, false)
  await page.evaluate(() => tm.open('cpp', 'cpp', '#define A 1\n/* comment\ncontinued */\nconst char* s = "hello";\n'))
  await page.waitForFunction(() => tm.types('cpp',2).some(t => t.type === 1))
  await stringLine('cpp', 4, true)
  await page.evaluate(() => tm.open('qml', 'qml', 'import QtQuick\nItem {\n property string title: "hello"\n function f() { return /x+/.test("xx"); }\n}\n'))
  await stringLine('qml', 3, true)
  await page.evaluate(() => { tm.replace('py', 'a = """\nold\n"""'); tm.replace('py', '# latest\nnumber = 3\n'); tm.close('cpp'); tm.close('qml') })
  await stringLine('py', 2, false)
  await page.waitForTimeout(150)
  assert.deepEqual(errors, [])
  console.log('PASS off-thread TextMate: Python multiline/CRLF/UTF-16, C++ comments/macros, QML/JS, stale edits and model disposal')
  await page.evaluate(() => tm.close('py'))
  for (let i = 0; i < 50 && liveWorkers.size; i++) await page.waitForTimeout(20)
  assert.equal(liveWorkers.size, 0, 'disposing the last model must release its grammar worker')
  const cdp = await page.context().newCDPSession(page)
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize }
  const baseline = await heap()
  const big = 'value = """start\n' + 'multiline 漢字 😀\n'.repeat(2400) + '"""\nlast = 42\n'
  for (let i = 0; i < 30; i++) {
    await page.evaluate(text => tm.open('cycle', 'python', text), big)
    await stringLine('cycle', 2400, true)
    await page.evaluate(() => tm.close('cycle'))
    for (let j = 0; j < 50 && liveWorkers.size; j++) await page.waitForTimeout(10)
    assert.equal(liveWorkers.size, 0, `cycle ${i + 1} must release its worker`)
    if ((i + 1) % 10 === 0) console.log(JSON.stringify({ phase: 'editor-open-close', cycles: i + 1, retainedMiB: +(((await heap()) - baseline) / 1048576).toFixed(2) }))
  }
  const retained = (await heap()) - baseline
  assert(retained < 12 * 1048576, `30 open/close cycles retained ${(retained / 1048576).toFixed(1)} MiB`)
  assert.deepEqual(errors, [])
  console.log('PASS model lifecycle: 30 large editors close with zero grammar workers and bounded frame heap')
  await page.evaluate(() => { window.__failWorker = true; return tm.open('failure', 'python', 'value = "fallback"\n') })
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => tm.background('python')), false, 'a failed worker must restore the original tokenizer')
  await stringLine('failure', 1, true)
  await page.evaluate(() => tm.close('failure'))
  await page.evaluate(() => tm.open('retry', 'python', 'value = """\nretry\n"""\n'))
  await stringLine('retry', 2, true)
  assert.equal(await page.evaluate(() => tm.background('python')), true, 'a later grammar installation must be able to retry')
  await page.evaluate(() => tm.close('retry'))
  console.log('PASS worker failure: built-in highlighting restored and later installation retries')
} finally {
  await browser?.close()
  await new Promise(done => server.close(done))
  assert.equal(dirname(scratch), resolve(tmpdir())); assert(basename(scratch).startsWith('qt-textmate-ui-'))
  rmSync(scratch, { recursive: true, force: true })
}
