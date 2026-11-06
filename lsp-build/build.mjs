// Builds independent Python/C++/QML plugins from shared source into plugins/*-lsp.
// Each folder owns one editor page, its grammar assets, Node worker and SSH agent.
// The legacy plugins/qt-lsp output remains frozen for migration.
// Language servers are installed separately, not bundled.
// 1 MiB is a per-file soft warning; the plugin folder limit is 50 MiB / 2000 files.
// Usage: npm ci --ignore-scripts && node build.mjs
import { build } from 'esbuild'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { profiles, manifestFor } from './profiles.mjs'
import { workerPlugin } from './worker-build.mjs'
import { monacoWorkarounds } from './monaco-workarounds.mjs'

const HERE = import.meta.dirname
const MAX = 1024 * 1024
for (const PROFILE of profiles) {
  const PLUGIN = path.resolve(HERE, '..', 'plugins', PROFILE.folder)
  if (!PLUGIN.startsWith(path.resolve(HERE, '..', 'plugins') + path.sep)) throw new Error('Invalid output folder')
  const define = { __LSP_LANGUAGE__: JSON.stringify(PROFILE.language) }
  mkdirSync(PLUGIN, { recursive: true })
  writeFileSync(path.join(PLUGIN, 'orca-plugin.json'), JSON.stringify(manifestFor(PROFILE), null, 2) + '\n')
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) writeFileSync(path.join(PLUGIN, name), readFileSync(path.resolve(HERE, '../plugins/qt-lsp', name), 'utf8').replace('Qt Code Intelligence for Orca bundles', 'Code Intelligence for Orca bundles'))

  for (const d of ['editor', 'worker', 'server']) rmSync(path.join(PLUGIN, d), { recursive: true, force: true })
  mkdirSync(path.join(PLUGIN, 'editor', 'assets'), { recursive: true })

  const page = await build({
    absWorkingDir: HERE,
    entryPoints: { editor: path.join(HERE, 'src', 'editor.ts') },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    legalComments: 'none',
    outdir: path.join(PLUGIN, 'editor', 'assets'),
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    assetNames: '[name]-[hash]',
    loader: { '.ttf': 'file', '.wasm': 'base64' },
    external: ['orca/*'],
    plugins: [workerPlugin(path.join(PLUGIN, 'editor', 'assets'), define), monacoWorkarounds],
    define,
    metafile: true,
    logLevel: 'warning'
  })
  writeFileSync(path.join(HERE, `meta-${PROFILE.language}.json`), JSON.stringify(page.metafile))

  const css = readdirSync(path.join(PLUGIN, 'editor', 'assets')).filter((f) => f.endsWith('.css'))
  const PAGES = { [PROFILE.language]: PROFILE.name }
  for (const [lang, title] of Object.entries(PAGES)) writeFileSync(path.join(PLUGIN, 'editor', `${lang}.html`), `<!doctype html>
  <html lang="en" data-lang="${lang}">
  <head>
  <meta charset="utf-8">
  <title>${title}</title>
  ${css.map((c) => `<link rel="stylesheet" href="./assets/${c}">`).join('\n')}
  <style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--orca-background, #1e1e1e); }
  body { display: flex; flex-direction: column; font: 12px system-ui, "Segoe UI", sans-serif; color: var(--orca-foreground, #ccc); }
  #editor { flex: 1; min-height: 0; }
  #bar { display: flex; align-items: center; border-top: 1px solid var(--orca-border, #333); background: var(--orca-background); }
  #interp { flex: none; margin: 0 6px; padding: 2px 8px; font: inherit; color: var(--orca-foreground, #ccc); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; white-space: nowrap; }
  #interp:hover, #host:hover { background: var(--orca-accent, #333); }
  #host { flex: none; margin: 0 0 0 6px; padding: 2px 8px; font: inherit; color: var(--orca-foreground, #ccc); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; white-space: nowrap; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
  #picker { position: fixed; left: 50%; top: 40px; transform: translateX(-50%); width: min(620px, 90vw); max-height: 60vh; display: flex; flex-direction: column; background: var(--orca-popover, #252526); color: var(--orca-popover-foreground, #ccc); border: 1px solid var(--orca-border, #444); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.35); z-index: 50; }
  #picker[hidden] { display: none; }
  #picker-filter { margin: 8px; padding: 6px 8px; font: inherit; color: inherit; background: var(--orca-background, #1e1e1e); border: 1px solid var(--orca-input, #555); border-radius: 4px; outline: none; }
  #picker-list { overflow: auto; padding: 0 4px 6px; }
  .pk { padding: 5px 8px; border-radius: 4px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  .pk.sel, .pk:hover { background: var(--orca-accent, #04395e); }
  .pk b { font-weight: 600; } .pk small { opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pk i { font-style: normal; opacity: .65; margin-left: auto; }
  #status { flex: 1; min-width: 0; padding: 3px 10px; color: var(--orca-muted-foreground, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #status[data-tone="warn"] { color: #d7a700; }
  #status[data-tone="err"] { color: var(--orca-destructive, #f14c4c); }
  #status[data-tone="busy"] { opacity: .7; }
  </style>
  <script type="module" src="./assets/editor.js"></script>
  </head>
  <body>
  <div id="editor"></div>
  <div id="bar"><button id="host" type="button" title="Host with this project's code" hidden></button><div id="status" data-tone="busy">Starting…</div><button id="interp" type="button" title="Select Python interpreter" hidden></button></div>
  <div id="picker" hidden><input id="picker-filter" placeholder="Select a Python interpreter (type to filter)…" spellcheck="false"><div id="picker-list" role="listbox"></div></div>
  </body>
  </html>
  `.replace(/[ \t]+\n/g, '\n').trimEnd() + '\n')

  // Agent for other hosts (over SSH): one self-contained .mjs file, only needs Node >= 18 on the remote side.
  const pkgVersion = JSON.parse(readFileSync(path.join(PLUGIN, 'orca-plugin.json'), 'utf8')).version
  await build({
    absWorkingDir: HERE,
    entryPoints: { agent: path.join(HERE, 'src', 'agent.ts') },
    bundle: true,
    format: 'esm',
    platform: 'node',
    minifySyntax: true,
    target: 'node18',
    outdir: path.join(PLUGIN, 'worker'),
    outExtension: { '.js': '.mjs' },
    define: { ...define, __AGENT_VERSION__: JSON.stringify(pkgVersion) },
    logLevel: 'warning'
  })

  await build({
    absWorkingDir: HERE,
    entryPoints: { worker: path.join(HERE, 'src', 'worker.ts') },
    bundle: true,
    format: 'esm',
    platform: 'node',
    minifySyntax: true,
    target: 'node20',
    outdir: path.join(PLUGIN, 'worker'),
    outExtension: { '.js': '.mjs' },
    external: ['orca/*'],
    define,
    logLevel: 'warning'
  })

  // Pyright is not bundled into the plugin (typeshed > 2000 files): it is installed on the machine and the worker finds it.

  // Check Orca's limits
  let files = 0, bytes = 0
  const big = []
  const walk = (d) => { for (const n of readdirSync(d)) { const f = path.join(d, n); const s = statSync(f); if (s.isDirectory()) walk(f); else { files++; bytes += s.size; if (s.size > MAX) big.push(`${path.relative(PLUGIN, f)} ${(s.size / 1048576).toFixed(2)} MiB`) } } }
  walk(PLUGIN)
  console.log(`${PROFILE.folder}: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB`)
  if (big.length) console.log('FILE > 1 MiB:\n  ' + big.join('\n  '))
  if (files > 2000 || bytes > 50 * MAX) console.log('OVER LIMIT: 2000 files / 50 MiB')
}
