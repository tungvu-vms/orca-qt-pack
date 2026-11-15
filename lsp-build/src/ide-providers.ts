// Monaco's built-in UX supplies key bindings, menus, peek, parameter hints and undo.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints.js'
import 'monaco-editor/esm/vs/editor/contrib/rename/browser/rename.js'
import 'monaco-editor/esm/vs/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js'
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js'
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js'
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
import type { DocumentHighlightsOutput, DocumentSymbolsOutput, Loc, Pos, PrepareRenameOutput, ReferencesOutput, RenameOutput, SignatureHelpOutput } from './protocol'

interface Environment {
  language: string
  path: string
  model: monaco.editor.ITextModel
  readOnly: boolean
  request<T>(name: string, input: unknown): Promise<T>
  flush(): Promise<void>
  version(): number
  locations(items: Loc[]): Promise<monaco.languages.Location[]>
  report(error: unknown): unknown
  status(message: string): void
}
const pos = (p: monaco.Position): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 })
const range = (r: { start: Pos; end: Pos }) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1)

export function registerIdeProviders(env: Environment): monaco.IDisposable {
  const { language, model, path, request, flush } = env
  const owned: monaco.IDisposable[] = []
  // A request belongs to a particular revision; never apply a late response to newer text.
  async function read<T>(name: string, extra: object, token: monaco.CancellationToken): Promise<T | null> {
    if (token.isCancellationRequested) return null
    const revision = model.getVersionId()
    await flush()
    if (token.isCancellationRequested || model.getVersionId() !== revision) return null
    try {
      const result = await request<T>(name, { path, ...extra })
      return token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== revision ? null : result
    } catch (e) { if (!token.isCancellationRequested) env.report(e); return null }
  }

  owned.push(monaco.languages.registerReferenceProvider(language, {
    async provideReferences(m, position, context, token) {
      if (m !== model) return []
      const r = await read<ReferencesOutput>('lsp.references', { position: pos(position), includeDeclaration: context.includeDeclaration }, token)
      if (!r) return []
      if (r.truncated) env.status('Showing the first references; the result exceeds the message limit.')
      const result = await env.locations(r.locations)
      return token.isCancellationRequested ? [] : result
    }
  }))
  owned.push(monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(m, position, token, context) {
      if (m !== model) return null
      const r = await read<SignatureHelpOutput>('lsp.signatureHelp', { position: pos(position), trigger: context.triggerCharacter }, token)
      if (!r?.signatures.length) return null
      const activeSignature = Math.min(r.signatures.length - 1, Math.max(0, r.activeSignature))
      const active = r.signatures[activeSignature]
      return {
        value: {
          signatures: r.signatures.map((s) => ({ ...s, documentation: s.documentation ? { value: s.documentation } : undefined,
            parameters: s.parameters.map((p) => ({ ...p, documentation: p.documentation ? { value: p.documentation } : undefined })) })),
          activeSignature, activeParameter: Math.min(Math.max(0, active.parameters.length - 1), active.activeParameter ?? r.activeParameter)
        },
        dispose() {}
      }
    }
  }))
  owned.push(monaco.languages.registerDocumentSymbolProvider(language, {
    displayName: 'Qt Code Intelligence',
    async provideDocumentSymbols(m, token) {
      if (m !== model) return []
      const r = await read<DocumentSymbolsOutput>('lsp.documentSymbols', {}, token)
      if (!r) return []
      const roots: monaco.languages.DocumentSymbol[] = [], stack: monaco.languages.DocumentSymbol[] = []
      for (const s of r.items) {
        const item: monaco.languages.DocumentSymbol = { name: s.name, detail: s.detail, kind: Math.max(0, s.kind - 1),
          range: range(s.range), selectionRange: range(s.selectionRange), tags: s.tags?.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [], children: [] }
        while (stack.length && !monaco.Range.containsRange(stack[stack.length - 1].range, item.range)) stack.pop()
        if (stack.length && s.containerName) stack[stack.length - 1].children!.push(item); else roots.push(item)
        stack.push(item)
      }
      if (r.truncated) env.status('Showing the first symbols; the result exceeds the message limit.')
      return roots
    }
  }))
  owned.push(monaco.languages.registerDocumentHighlightProvider(language, {
    async provideDocumentHighlights(m, position, token) {
      if (m !== model) return []
      const r = await read<DocumentHighlightsOutput>('lsp.documentHighlights', { position: pos(position) }, token)
      return (r?.items ?? []).map((h) => ({ range: range(h.range), kind: h.kind }))
    }
  }))
  if (!env.readOnly) owned.push(monaco.languages.registerRenameProvider(language, {
    async resolveRenameLocation(m, position, token) {
      if (m !== model) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'Rename is only available in the editable document.' }
      const r = await read<PrepareRenameOutput>('lsp.prepareRename', { position: pos(position) }, token)
      const word = model.getWordAtPosition(position)
      const fallback = new monaco.Range(position.lineNumber, word?.startColumn ?? position.column, position.lineNumber, word?.endColumn ?? position.column)
      return { range: r?.range ? range(r.range) : fallback, text: r?.placeholder ?? word?.word ?? '', rejectReason: r?.rejectReason ?? (!r ? 'The document changed. Try rename again.' : undefined) }
    },
    async provideRenameEdits(m, position, newName, token) {
      if (m !== model) return { edits: [], rejectReason: 'Rename is only available in the editable document.' }
      const revision = model.getVersionId()
      await flush()
      if (token.isCancellationRequested || revision !== model.getVersionId()) return { edits: [], rejectReason: 'The document changed. Try rename again.' }
      try {
        const r = await request<RenameOutput>('lsp.rename', { path, position: pos(position), newName, version: env.version() })
        if (token.isCancellationRequested || model.isDisposed() || revision !== model.getVersionId()) return { edits: [], rejectReason: 'The document changed. Try rename again.' }
        if (r.rejectReason) env.status(r.rejectReason)
        return { rejectReason: r.rejectReason, edits: r.edits.map((e) => ({ resource: model.uri, versionId: revision, textEdit: { range: range(e.range), text: e.text } })) }
      } catch (e) { env.report(e); return { edits: [], rejectReason: e instanceof Error ? e.message : String(e) } }
    }
  }))
  return { dispose: () => { for (const d of owned) d.dispose() } }
}
