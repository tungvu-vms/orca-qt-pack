// Pinned Monaco 0.52.2 background-tokenization bridge (same store used by VS Code).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { TokenizationRegistry } from 'monaco-editor/esm/vs/editor/common/languages.js'
import { TokenizationSupportAdapter } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneLanguages.js'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { ILanguageService } from 'monaco-editor/esm/vs/editor/common/languages/language.js'
import { IStandaloneThemeService } from 'monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js'
import { ContiguousMultilineTokensBuilder } from 'monaco-editor/esm/vs/editor/common/tokens/contiguousMultilineTokensBuilder.js'
import TextMateWorker from './textmate.worker.ts?worker'
import type { EditorActivity } from './editor-activity'

type ClassicToken = { startIndex: number; scopes: string }
class CachedState implements monaco.languages.IState {
  constructor(readonly id: string) {}
  clone() { return this }
  equals(other: monaco.languages.IState) { return other instanceof CachedState && other.id === this.id }
}
type Context = { model: monaco.editor.ITextModel; receive: (data: any) => void; sync: () => void }
const contexts = new Map<number, Context>(), registrations = new Map<string, () => void>()
let worker: Worker | null = null, nextId = 0, enabled = true, idleTimer: ReturnType<typeof setTimeout> | undefined
let epoch = 0
function ensureWorker() {
  if (!worker) {
    worker = new TextMateWorker()
    const generation = ++epoch
    worker.onmessage = ({ data }) => contexts.get(data.id)?.receive({ ...data, generation })
    worker.onerror = error => {
      console.warn('[qt-lsp] TextMate worker failed; using the built-in tokenizer', error.message)
      worker?.terminate(); worker = null
      for (const restore of [...registrations.values()]) restore()
    }
  }
  return worker
}
export function trackTextMateActivity(activity: EditorActivity) {
  const update = (visible: boolean) => {
    enabled = visible
    clearTimeout(idleTimer)
    worker?.postMessage({ type: 'active', active: visible })
    if (visible) { for (const context of contexts.values()) context.sync() }
    else idleTimer = setTimeout(() => { worker?.terminate(); worker = null }, 30000)
  }
  update(activity.visible)
  const listener = activity.onChange(update)
  window.addEventListener('pagehide', () => { listener.dispose(); clearTimeout(idleTimer); worker?.terminate(); worker = null; contexts.clear() }, { once: true })
}

export async function installWorkerTokens(lang: string): Promise<boolean> {
  if (registrations.has(lang)) return true
  const fallback = await TokenizationRegistry.getOrCreate(lang)
  const languageService = StandaloneServices.get(ILanguageService)
  const themeService = StandaloneServices.get(IStandaloneThemeService)
  const cache = new Map<string, { tokens: ClassicToken[]; endState: CachedState; cost: number }>()
  let bytes = 0
  const keyFor = (state: string, line: string) => `${state}:${line}`
  const put = (key: string, tokens: ClassicToken[], state: string) => {
    const previous = cache.get(key)
    if (previous) { bytes -= previous.cost; cache.delete(key) }
    const value = { tokens, endState: new CachedState(state), cost: key.length * 2 + tokens.length * 80 }
    cache.set(key, value); bytes += value.cost
    while (cache.size > 2000 || bytes > 4 * 1048576) {
      const oldest = cache.keys().next().value!
      bytes -= cache.get(oldest)!.cost; cache.delete(oldest)
    }
  }
  const adapter = new TokenizationSupportAdapter(lang, {
    getInitialState: () => new CachedState('0'),
    tokenize(line: string, state: CachedState) {
      const hit = cache.get(keyFor(state.id, line))
      // Cache miss is deliberately cheap. The background worker supplies exact tokens.
      return hit ?? { tokens: [{ startIndex: 0, scopes: '' }], endState: new CachedState('?') }
    }
  }, languageService, themeService)
  adapter.createBackgroundTokenizer = (model: monaco.editor.ITextModel, store: any) => {
    const id = ++nextId
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false
    const sync = () => {
      clearTimeout(timer)
      timer = undefined
      if (!enabled || disposed) return
      try { ensureWorker().postMessage({ id, lang, version: model.getVersionId(), lines: model.getLinesContent() }) }
      catch (error) { console.warn('[qt-lsp] TextMate worker unavailable', error); registrations.get(lang)?.() }
    }
    const context: Context = { model, sync, receive(data) {
      if (data.error) { console.warn('[qt-lsp] TextMate grammar failed', data.error); registrations.get(lang)?.(); return }
      if (disposed || !enabled || data.version !== model.getVersionId()) return
      const stateId = (id: number) => id === 0 ? '0' : `${data.generation}/${id}`
      const builder = new ContiguousMultilineTokensBuilder()
      for (const row of data.rows) {
        put(keyFor(stateId(row.before), row.text), row.tokens, stateId(row.after))
        const tokens: Uint32Array = adapter._toBinaryTokens(languageService.languageIdCodec, row.tokens)
        // Monaco's background store expects end offsets, unlike its public provider.
        for (let i = 0; i < tokens.length; i += 2) tokens[i] = i + 2 < tokens.length ? tokens[i + 2] : row.text.length
        builder.add(row.line, tokens)
        store.setEndState(row.line, new CachedState(stateId(row.after)))
      }
      store.setTokens(builder.finalize())
      if (data.done) store.backgroundTokenizationFinished()
    } }
    contexts.set(id, context)
    const listener = model.onDidChangeContent(() => { clearTimeout(timer); timer = setTimeout(sync, 60) })
    // Registration happens during model construction/reset, before content events settle.
    queueMicrotask(sync)
    return {
      requestTokens() { if (!timer) timer = setTimeout(sync, 60) },
      dispose() {
        disposed = true; clearTimeout(timer); listener.dispose(); contexts.delete(id)
        worker?.postMessage({ type: 'dispose', id })
        if (!contexts.size) { worker?.terminate(); worker = null; cache.clear(); bytes = 0 }
      }
    }
  }
  const registration = TokenizationRegistry.register(lang, adapter)
  registrations.set(lang, () => {
    registrations.delete(lang)
    registration.dispose()
    if (fallback) TokenizationRegistry.register(lang, fallback)
    cache.clear(); bytes = 0
  })
  return true
}
