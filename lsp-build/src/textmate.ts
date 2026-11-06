// Lightweight theme/configuration bridge. Grammar evaluation runs in a worker.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { allSelectors, bestSelector, selectorsByMode } from './textmate-theme'
import { installWorkerTokens } from './textmate-background'
export type Lang = 'python' | 'qml' | 'cpp'
type Loader = () => Promise<{ default: unknown }>
const LANGS: Record<Lang, { scope: string; config: Loader }> = {
  python: { scope: 'source.python', config: () => import('../vendor/python-language-configuration.json') },
  qml: { scope: 'source.qml', config: () => import('../vendor/qml-configuration.json') },
  cpp: { scope: 'source.cpp', config: () => import('../vendor/cpp-language-configuration.json') }
}


const installed = new Map<Lang, Promise<boolean>>()
export function installTextMate(lang: Lang): Promise<boolean> {
  let pending = installed.get(lang)
  if (!pending) {
    pending = (async () => {
      if (!monaco.languages.getLanguages().some(l => l.id === lang)) monaco.languages.register({ id: lang })
      monaco.languages.setLanguageConfiguration(lang, toMonacoConfig((await LANGS[lang].config()).default))
      return installWorkerTokens(lang)
    })().catch(error => { console.warn('[qt-lsp] textmate unavailable', error); return false }).finally(() => installed.delete(lang))
    installed.set(lang, pending)
  }
  return pending
}
/** Monaco rules for the current theme: each VS Code theme selector -> one rule with the same name. */
export function textMateRules(mode: 'dark' | 'light'): monaco.editor.ITokenThemeRule[] {
  const rules: monaco.editor.ITokenThemeRule[] = []
  for (const [token, s] of selectorsByMode[mode]) {
    const rule: monaco.editor.ITokenThemeRule = { token }
    if (s.foreground) rule.foreground = s.foreground.replace('#', '').slice(0, 6)
    if (s.fontStyle !== undefined) rule.fontStyle = s.fontStyle
    rules.push(rule)
  }
  // Selectors only in the other theme: reset to the default text color so the old theme's color doesn't stick.
  for (const token of allSelectors) if (!selectorsByMode[mode].has(token)) rules.push({ token, foreground: mode === 'dark' ? 'D4D4D4' : '000000' })
  return rules
}

/** Semantic token -> TextMate scope, following VS Code's default table (semanticTokenScopes),
 *  plus clangd- and qmlls-specific types. Key: "type" or "type.modifier" (the more specific modifier wins).
 *  Empty array = keep the TextMate color. */
const SEMANTIC_SCOPES: Record<string, string[]> = {
  namespace: ['entity.name.namespace'],
  type: ['entity.name.type', 'support.type'],
  'type.defaultLibrary': ['support.type'],
  class: ['entity.name.type.class', 'support.class'],
  'class.defaultLibrary': ['support.class'],
  enum: ['entity.name.type.enum'],
  interface: ['entity.name.type.interface'],
  struct: ['storage.type.struct'],
  typeParameter: ['entity.name.type.parameter'],
  concept: ['entity.name.type.concept'],
  parameter: ['variable.parameter'],
  variable: ['variable.other.readwrite', 'entity.name.variable'],
  'variable.readonly': ['variable.other.constant'],
  'variable.defaultLibrary': ['support.variable'],
  property: ['variable.other.property'],
  'property.readonly': ['variable.other.constant.property'],
  field: ['variable.other.property'],
  enumMember: ['variable.other.enummember'],
  function: ['entity.name.function'],
  'function.defaultLibrary': ['support.function'],
  method: ['entity.name.function.member'],
  decorator: ['entity.name.function'],
  macro: ['entity.name.function.preprocessor'],
  label: ['entity.name.label'],
  modifier: ['storage.modifier'],
  keyword: ['keyword'],
  // clangd: 'comment' = inactive #if region; qmlls: a real comment
  comment: ['comment'],
  string: ['string'],
  number: ['constant.numeric'],
  regexp: ['string.regexp'],
  operator: [],
  bracket: [],
  unknown: [],
  // Python (basedpyright)
  selfParameter: ['variable.parameter.function.language.special.self', 'variable.language'],
  clsParameter: ['variable.parameter.function.language.special.cls', 'variable.language'],
  // QML (qmlls)
  qmlLocalId: ['variable.other.constant'],
  qmlExternalId: ['variable.other.constant'],
  qmlRootObjectProperty: ['variable.other.property'],
  qmlScopeObjectProperty: ['variable.other.property'],
  qmlExternalObjectProperty: ['variable.other.property'],
  qmlStateName: ['string'],
  jsScopeVar: ['variable.other.readwrite'],
  jsImportVar: ['entity.name.namespace'],
  jsGlobalVar: ['support.variable']
}

/** Monaco token (theme selector) for a semantic token; '' to keep the TextMate color. */
export function semanticToken(type: string, modifiers: string[]): string {
  const keys = [...modifiers.map((m) => `${type}.${m}`), type]
  for (const k of keys) {
    const scopes = SEMANTIC_SCOPES[k]
    if (!scopes) continue
    for (const scope of scopes) {
      const sel = bestSelector(scope, allSelectors)
      if (sel) return sel
    }
    if (k === type) return ''
  }
  return ''
}

function toMonacoConfig(c: any): monaco.languages.LanguageConfiguration {
  const re = (v: any) => (typeof v === 'string' ? new RegExp(v) : v?.pattern ? new RegExp(v.pattern, v.flags) : undefined)
  const pairs = (list: any[] | undefined) => list?.map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p))
  return {
    comments: c.comments,
    brackets: c.brackets,
    autoClosingPairs: pairs(c.autoClosingPairs),
    surroundingPairs: pairs(c.surroundingPairs),
    wordPattern: re(c.wordPattern),
    indentationRules: c.indentationRules ? { increaseIndentPattern: re(c.indentationRules.increaseIndentPattern)!, decreaseIndentPattern: re(c.indentationRules.decreaseIndentPattern)! } : undefined,
    onEnterRules: c.onEnterRules?.map((r: any) => ({ beforeText: re(r.beforeText)!, afterText: re(r.afterText), action: { indentAction: r.action?.indent === 'indent' ? monaco.languages.IndentAction.Indent : r.action?.indent === 'outdent' ? monaco.languages.IndentAction.Outdent : monaco.languages.IndentAction.None, appendText: r.action?.appendText } }))
  }
}
