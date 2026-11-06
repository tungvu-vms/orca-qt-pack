import { build } from 'esbuild'
import { resolve } from 'node:path'

// Local workers keep their own lazy grammar chunks. Monaco's worker remains an IIFE.
export const workerPlugin = outdir => ({
  name: 'editor-workers',
  setup(b) {
    b.onResolve({ filter: /\?worker$/ }, args => ({ path: args.path.startsWith('.') ? resolve(args.resolveDir, args.path.slice(0, -7)) : resolve(import.meta.dirname, 'node_modules', args.path.slice(0, -7)), namespace: 'worker' }))
    b.onLoad({ filter: /.*/, namespace: 'worker' }, async args => {
      const local = args.path.endsWith('textmate.worker.ts'), name = local ? 'textmate.worker' : 'editor.worker'
      await build({ entryPoints: { [name]: args.path }, outdir, bundle: true, format: local ? 'esm' : 'iife', splitting: local,
        minify: true, target: 'chrome120', legalComments: 'none', chunkNames: 'tm-[name]-[hash]', loader: { '.wasm': 'base64' } })
      return { contents: `export default class extends Worker { constructor() { super(new URL('./${name}.js', import.meta.url), ${local ? "{type:'module'}" : '{}'}) } }`, loader: 'js' }
    })
  }
})
