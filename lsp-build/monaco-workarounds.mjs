// Narrow, source-checked fixes for the pinned Monaco 0.52.2. Never edit node_modules.
import { readFileSync } from 'node:fs'

const replaceOnce = (text, before, after) => {
  if (!text.includes(before)) throw new Error('Monaco source changed: review the lifecycle workarounds before building.')
  return text.replace(before, after)
}
export const monacoWorkarounds = {
  name: 'monaco-lifecycle-workarounds',
  setup(b) {
    b.onLoad({ filter: /wordHighlighter[\\/]browser[\\/]wordHighlighter\.js$/ }, (args) => {
      let contents = readFileSync(args.path, 'utf8')
      for (const callback of ['this._onPositionChanged(e);', 'this._run();']) {
        const before = `this.runDelayer.trigger(() => { ${callback} });`
        contents = replaceOnce(contents, before, `this.runDelayer.trigger(() => { ${callback} }).catch(onUnexpectedError);`)
      }
      return { contents, loader: 'js' }
    })
    b.onLoad({ filter: /gotoSymbol[\\/]browser[\\/]referencesModel\.js$/ }, (args) => {
      let contents = readFileSync(args.path, 'utf8')
      const start = contents.indexOf('export class FileReferences {'), end = contents.indexOf('export class ReferencesModel {')
      if (start < 0 || end < start) throw new Error('Monaco reference classes changed: review the preview disposal fix.')
      let group = contents.slice(start, end)
      group = replaceOnce(group, 'this._previews = new ResourceMap();', 'this._previews = new ResourceMap(); this._disposed = false;')
      group = replaceOnce(group, 'dispose(this._previews.values());', 'this._disposed = true; dispose(this._previews.values());')
      group = replaceOnce(group, 'if (this._previews.size !== 0)', 'if (this._disposed || this._previews.size !== 0)')
      group = replaceOnce(group, 'this._previews.set(child.uri, new FilePreview(ref));', `
                if (this._disposed) { ref.dispose(); return this; }
                if (this._previews.has(child.uri)) { ref.dispose(); }
                else { this._previews.set(child.uri, new FilePreview(ref)); }`)
      contents = contents.slice(0, start) + group + contents.slice(end)
      return { contents, loader: 'js' }
    })
  }
}
