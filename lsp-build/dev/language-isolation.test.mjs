import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

for (const language of ['python', 'cpp', 'qml'])
  test(`${language} core rejects unrelated requests before workspace access`, async () => {
    const output = join(process.env.QT_LSP_TEST_DIR, `core-${language}.mjs`)
    await build({
      entryPoints: ['src/core.ts'],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      define: { __LSP_LANGUAGE__: JSON.stringify(language) },
      logLevel: 'warning'
    })
    const { createCore } = await import(pathToFileURL(output))
    let reads = 0
    const core = createCore({
      log() {},
      post() {},
      setting: async (_, d) => d,
      storageGet: async () => null,
      storageSet: async () => {},
      roots: async () => {
        reads++
        return { focused: null, roots: [] }
      }
    })
    const other = language === 'python' ? 'cpp' : 'python',
      ext = other === 'python' ? 'py' : 'cpp'
    try {
      await assert.rejects(
        core.handlers['lsp.attach']({
          language: other,
          hash: '0'.repeat(40),
          size: 1
        }),
        /language|supports|handles/i
      )
      await assert.rejects(
        core.handlers['lsp.open']({
          path: `/project/main.${ext}`,
          version: 1,
          text: 'x'
        }),
        /language|supports|handles/i
      )
      await assert.rejects(
        core.handlers['lsp.definition']({
          path: `/project/main.${ext}`,
          position: { line: 0, character: 0 },
          version: 1
        }),
        /language|supports|handles/i
      )
      assert.equal(reads, 0, 'wrong-language calls must not trigger discovery')
    } finally {
      core.shutdown()
    }
  })

test('Python worker rejects a foreign-language SSH request before creating an agent', async () => {
  const output = join(process.env.QT_LSP_TEST_DIR, 'isolated-worker.mjs')
  globalThis.__foreignAgents = 0
  await build({
    entryPoints: ['src/worker.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { __LSP_LANGUAGE__: '"python"' },
    plugins: [
      {
        name: 'boundary',
        setup(b) {
          b.onResolve({ filter: /^\.\/remote$/ }, () => ({
            path: 'remote',
            namespace: 'boundary'
          }))
          b.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({
            contents: `export const isValidHost=()=>true; export const findSsh=()=>"ssh"; export class RemoteAgent { constructor(){globalThis.__foreignAgents++} async start(){} async call(){return {locations:[]}} }`
          }))
        }
      }
    ],
    logLevel: 'warning'
  })
  writeFileSync(join(process.env.QT_LSP_TEST_DIR, 'agent.mjs'), '// fixture')
  const { default: activate } = await import(pathToFileURL(output)),
    handlers = {}
  activate({
    log() {},
    storage: { get: async () => null },
    host: {
      call: async () => {
        throw Error('unexpected workspace access')
      }
    },
    panels: {
      handle(n, h) {
        handlers[n] = h
      },
      post() {}
    },
    events: { on() {} },
    settings: { get: async () => null }
  })
  await assert.rejects(
    handlers['lsp.definition']({
      path: '@host:/project/main.cpp',
      position: { line: 0, character: 0 }
    }),
    /language|supports|handles/i
  )
  assert.equal(globalThis.__foreignAgents, 0)
  delete globalThis.__foreignAgents
})

test(
  'independent SSH agents validate identity and keep separate state on the same host',
  { timeout: 15000 },
  async (t) => {
    const home = join(process.env.QT_LSP_TEST_DIR, 'agent-home')
    mkdirSync(home, { recursive: true })
    const start = async (language) => {
      const outfile = join(process.env.QT_LSP_TEST_DIR, `agent-${language}.mjs`)
      await build({
        entryPoints: ['src/agent.ts'],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        define: {
          __LSP_LANGUAGE__: JSON.stringify(language),
          __AGENT_VERSION__: '"0.1.0"'
        },
        logLevel: 'warning'
      })
      const child = spawn(process.execPath, [outfile], {
        env: { ...process.env, USERPROFILE: home, HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      t.after(() => child.kill())
      let id = 0
      const pending = new Map()
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        const msg = JSON.parse(line),
          p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          clearTimeout(p.timer)
          msg.e ? p.reject(Error(msg.e)) : p.resolve(msg.r)
        }
      })
      const call = (m, p) =>
        new Promise((resolve, reject) => {
          const n = ++id
          pending.set(n, {
            resolve,
            reject,
            timer: setTimeout(() => reject(Error('agent RPC timed out')), 3000)
          })
          child.stdin.write(JSON.stringify({ id: n, m, p }) + '\n')
        })
      t.after(() => {
        rl.close()
        for (const p of pending.values()) clearTimeout(p.timer)
      })
      return call
    }
    const py = await start('python'),
      cpp = await start('cpp')
    await assert.rejects(
      py('$hello', { language: 'cpp', pluginId: 'cpp-code-intelligence' }),
      /identity|language|profile/i
    )
    const pyInfo = await py('$hello', {
      language: 'python',
      pluginId: 'python-code-intelligence',
      settings: {}
    })
    const cppInfo = await cpp('$hello', {
      language: 'cpp',
      pluginId: 'cpp-code-intelligence',
      settings: {}
    })
    assert.equal(pyInfo.language, 'python')
    assert.equal(cppInfo.language, 'cpp')
    await py('$roots', { roots: ['python-project'] })
    await cpp('$roots', { roots: ['cpp-project'] })
    const state = (language) =>
      JSON.parse(
        readFileSync(
          join(
            home,
            '.orca-qt-lsp',
            `state-${language}-code-intelligence.json`
          ),
          'utf8'
        )
      )
    assert.deepEqual(state('python').roots, ['python-project'])
    assert.deepEqual(state('cpp').roots, ['cpp-project'])
    await assert.rejects(
      py('lsp.open', { path: '/p/main.cpp', version: 1 }),
      /language|supports|handles/i
    )
  }
)
