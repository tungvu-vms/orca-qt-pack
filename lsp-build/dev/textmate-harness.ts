import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { installTextMate, textMateRules } from '../src/textmate'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'
import { TokenizationRegistry } from 'monaco-editor/esm/vs/editor/common/languages.js'

const models = new Map<string, monaco.editor.ITextModel>()
const editors = new Map<string, monaco.editor.IStandaloneCodeEditor>()
Object.assign(window, { tm: {
  background(lang: string) { return !!TokenizationRegistry.get(lang)?.createBackgroundTokenizer },
  async open(id: string, lang: 'python' | 'cpp' | 'qml', text: string) {
    monaco.editor.defineTheme('test', { base: 'vs-dark', inherit: true, rules: textMateRules('dark'), colors: {} })
    monaco.editor.setTheme('test')
    if (!await installTextMate(lang)) throw new Error('grammar installation failed')
    const model = monaco.editor.createModel(text, lang)
    models.set(id, model)
    const element = document.createElement('div')
    element.style.cssText = 'width:800px;height:250px'
    document.body.append(element)
    editors.set(id, monaco.editor.create(element, { model, minimap: { enabled: false } }))
  },
  replace(id: string, text: string) { models.get(id)!.setValue(text) },
  edit(id: string, line: number, column: number, text: string) {
    models.get(id)!.applyEdits([{ range: new monaco.Range(line, column, line, column), text }])
  },
  types(id: string, line: number) {
    const tokens = (models.get(id)! as any).tokenization.getLineTokens(line)
    return Array.from({ length: tokens.getCount() }, (_, i) => ({ start: tokens.getStartOffset(i), type: tokens.getStandardTokenType(i), color: tokens.getForeground(i) }))
  },
  close(id: string) { const editor = editors.get(id)!; const element = editor.getDomNode(); editor.dispose(); element?.remove(); editors.delete(id); models.get(id)!.dispose(); models.delete(id) }
} })
