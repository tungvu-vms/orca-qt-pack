// Actual independent editor bundles + real servers; only Orca's document bridge is simulated.
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

// clangd canonicalizes Windows 8.3 TEMP aliases in returned locations.
const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'orca-language-ui-'))
  ),
  root = join(scratch, 'project')
mkdirSync(root)
await build({
  entryPoints: ['src/servers.ts'],
  outfile: join(scratch, 'servers.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning'
})
const discovery = await import(pathToFileURL(join(scratch, 'servers.mjs')))
const clangd = process.env.QT_LSP_TEST_CLANGD || discovery.findClangd(''),
  qmlls = process.env.QT_LSP_TEST_QMLLS || discovery.findQmlls('', '')
const cases = [
  {
    lang: 'python',
    file: 'main.py',
    text: 'from helper import Box\nbox = Box()\n',
    word: 'Box',
    line: 2,
    target: 'helper.py'
  }
]
writeFileSync(join(root, 'helper.py'), 'class Box:\n    pass\n')
if (clangd) {
  cases.push({
    lang: 'cpp',
    file: 'main.cpp',
    text: '#include "box.hpp"\nint main() {\n    Box box;\n    return box.value();\n}\n',
    word: 'Box',
    line: 3,
    target: 'box.hpp'
  })
  writeFileSync(
    join(root, 'box.hpp'),
    '#pragma once\nclass Box { public: int value() const { return 42; } };\n'
  )
  writeFileSync(
    join(root, 'compile_commands.json'),
    JSON.stringify([
      {
        directory: root,
        file: join(root, 'main.cpp'),
        arguments: [
          'clang++',
          '-std=c++20',
          '-I',
          root,
          '-c',
          join(root, 'main.cpp')
        ]
      }
    ])
  )
} else console.log('SKIP real C/C++ UI: set QT_LSP_TEST_CLANGD to clangd')
if (qmlls) {
  cases.push({
    lang: 'qml',
    file: 'Main.qml',
    text: 'import QtQuick\nItem {\n    Badge { id: badge }\n}\n',
    word: 'Badge',
    line: 3,
    target: 'Badge.qml'
  })
  writeFileSync(
    join(root, 'Badge.qml'),
    'import QtQuick\nItem { property int value: 42 }\n'
  )
} else console.log('SKIP real QML UI: set QT_LSP_TEST_QMLLS to qmlls')
writeFileSync(join(root, 'pyrightconfig.json'), '{}')
const cores = new Map(),
  reveals = [],
  logs = []
for (const c of cases) {
  writeFileSync(join(root, c.file), c.text)
  const out = join(scratch, `core-${c.lang}.mjs`)
  await build({
    entryPoints: ['src/core.ts'],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { __LSP_LANGUAGE__: JSON.stringify(c.lang) },
    logLevel: 'warning'
  })
  const { createCore } = await import(pathToFileURL(out))
  const settings = {
    pyrightPath: resolve('node_modules/basedpyright/langserver.index.js'),
    nodePath: process.execPath,
    projectEnvironments: 'off',
    clangdPath: clangd,
    qmllsPath: qmlls
  }
  cores.set(
    c.lang,
    createCore({
      log: (line) => logs.push({ lang: c.lang, line }),
      post() {},
      setting: async (k, d) => settings[k] ?? d,
      storageGet: async () => null,
      storageSet: async () => {},
      roots: async () => ({ focused: root, roots: [root] }),
      reveal: async (path, line) => {
        reveals.push({ lang: c.lang, path, line })
        return { opened: true, line }
      }
    })
  )
}
const bridge = (c) => `<script>
let replace;
window.__session={value:${JSON.stringify(c.text)},readOnly:false,change(value){this.value=value},onReplace(fn){replace=fn;return{dispose(){}}},flush:async()=>{},dispose(){}};
window.__replace=text=>{window.__session.value=text;replace?.(text)};
window.orca={document:{session:async()=>window.__session},on(){return{dispose(){}}},settings:{get:async()=>undefined,onDidChange(){return{dispose(){}}}},plugin:{on(){return{dispose(){}}},async request(name,input){const r=await fetch('/api/${c.lang}',{method:'POST',body:JSON.stringify({name,input})}).then(r=>r.json());if(r.error)throw Error(r.error);return r.result}}};
</script>`
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html')
      res.end(
        '<!doctype html>' +
          cases
            .map(
              (c) =>
                `<iframe id="${c.lang}" src="/${c.lang}/${c.lang}.html" style="width:1200px;height:260px;display:block"></iframe>`
            )
            .join('')
      )
      return
    }
    const match = /^\/(?:api\/)?(python|cpp|qml)\//.exec(req.url + '/')
    const lang = match?.[1],
      c = cases.find((c) => c.lang === lang)
    if (!c) {
      res.writeHead(404).end()
      return
    }
    if (req.url.startsWith('/api/')) {
      let body = ''
      for await (const chunk of req) body += chunk
      const { name, input } = JSON.parse(body)
      const result =
        name === 'lsp.hostChoice'
          ? { project: 'Test', chosen: 'local', hosts: [] }
          : await cores.get(lang).handlers[name](input)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result }))
      return
    }
    const assets = resolve(`../plugins/${lang}-lsp/editor`),
      file = resolve(assets, '.' + req.url.slice(lang.length + 1))
    if (
      !file.startsWith(assets + (process.platform === 'win32' ? '\\' : '/'))
    ) {
      res.writeHead(403).end()
      return
    }
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.ttf': 'font/ttf'
      }[extname(file)] ?? 'application/octet-stream'
    )
    const text = readFileSync(file)
    res.end(
      extname(file) === '.html'
        ? text.toString().replace('<head>', '<head>' + bridge(c))
        : text
    )
  } catch (error) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: error.message }))
  }
})
let browser
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const executablePath =
    process.env.QT_LSP_BROWSER ??
    [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome'
    ].find(existsSync)
  assert(executablePath, 'Set QT_LSP_BROWSER to Chromium/Chrome/Edge')
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 }
    }),
    errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  for (const c of cases) {
    const frame = page.frameLocator('#' + c.lang)
    await frame.locator('#interp:not([hidden])').waitFor({ timeout: 30000 })
    const symbol = frame
      .locator('.view-lines .view-line')
      .filter({ hasText: c.text.split('\n')[c.line - 1].trim() })
      .getByText(c.word, { exact: true })
    const before = reveals.length,
      started = Date.now()
    await symbol.click({ modifiers: ['Control'] })
    for (let i = 0; i < 300 && reveals.length === before; i++)
      await page.waitForTimeout(50)
    assert(
      reveals
        .slice(before)
        .some((r) => r.lang === c.lang && r.path.endsWith(c.target)),
      JSON.stringify({ language: c.lang, reveals, logs: logs.slice(-12) })
    )
    console.log(
      JSON.stringify({
        language: c.lang,
        action: 'Ctrl+Click',
        target: c.target,
        ms: Date.now() - started
      })
    )
    const forbidden =
      c.lang === 'python'
        ? ['spawn cpp:', 'spawn qml:']
        : c.lang === 'cpp'
          ? ['spawn python:', 'spawn qml:']
          : ['spawn python:', 'spawn cpp:']
    assert(
      !logs.some(
        (l) =>
          l.lang === c.lang &&
          forbidden.some((prefix) => l.line.startsWith(prefix))
      )
    )
    const core = cores.get(c.lang),
      path = join(root, c.file),
      position = {
        line: c.line - 1,
        character: c.text.split('\n')[c.line - 1].indexOf(c.word) + 1
      }
    const hover = await core.handlers['lsp.hover']({ path, position })
    assert(hover.markdown, `${c.lang} must return hover information`)
    const broken =
      c.text +
      {
        python: '\ndef invalid(:\n',
        cpp: '\nthis is invalid C++;\n',
        qml: '\nItem {\n'
      }[c.lang]
    await frame
      .locator('#editor')
      .evaluate((_, text) => window.__replace(text), broken)
    let diagnostics
    for (let i = 0; i < 100; i++) {
      diagnostics = await core.handlers['lsp.diagnostics']({ path })
      if (
        diagnostics.version >= 2 &&
        diagnostics.items.some((d) => d.severity === 1)
      )
        break
      await page.waitForTimeout(50)
    }
    assert(
      diagnostics.version >= 2 &&
        diagnostics.items.some((d) => d.severity === 1),
      `${c.lang} must diagnose the unsaved syntax error: ${JSON.stringify(diagnostics)}`
    )
    console.log(
      `PASS ${c.lang}: hover and versioned diagnostics for an unsaved syntax error`
    )
    assert.equal(readFileSync(join(root, c.file), 'utf8'), c.text)
  }
  assert.deepEqual(errors, [])
  console.log(
    `PASS ${cases.length} independent language editors coexist; real definitions resolve without unrelated servers`
  )
} catch (error) {
  console.error(
    'Language editor test failed:',
    error.message,
    JSON.stringify(logs.slice(-15))
  )
  throw error
} finally {
  await browser?.close()
  for (const core of cores.values()) core.shutdown()
  // Core shutdown is graceful (3 s deadline + 0.5 s forced kill). Let its timers
  // run before deleting the current working directory held by qmlls/clangd.
  await new Promise((done) => setTimeout(done, 3800))
  await new Promise((done) => server.close(done))
  assert.equal(dirname(scratch), realpathSync.native(tmpdir()))
  assert(basename(scratch).startsWith('orca-language-ui-'))
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })
}
