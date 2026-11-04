// To mau giong VS Code cho Python, QML va C/C++: grammar TextMate (MagicPython, QML, C++ cua VS Code)
// + theme Dark+/Light+, chay bang vscode-textmate. Grammar nap luoi (dynamic import) nen file Python
// khong phai tai grammar C++ (~500 KB).
// Monaco nhan token dang chuoi scope; theme Monaco co mot rule cho moi selector cua theme VS Code,
// va token tra ve chi la scope cu the nhat khop voi theme (giong cach VS Code chon mau).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type StateStack } from 'vscode-textmate'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
// WASM nhung base64 vao JS: frame cua plugin tra ve rong khi fetch file .wasm
import onigWasmBase64 from 'vscode-oniguruma/release/onig.wasm'
import vsThemes from '../vendor/themes.json'

export type Lang = 'python' | 'qml' | 'cpp'

type Loader = () => Promise<{ default: unknown }>
const GRAMMARS: Record<string, Loader> = {
  'source.python': () => import('../vendor/MagicPython.tmLanguage.json'),
  'source.regexp.python': () => import('../vendor/MagicRegExp.tmLanguage.json'),
  'source.qml': () => import('../vendor/qml.tmLanguage.json'),
  'source.js': () => import('../vendor/javascript.tmLanguage.json'),
  'source.cpp': () => import('../vendor/cpp.tmLanguage.json'),
  'source.cpp.embedded.macro': () => import('../vendor/cpp.embedded.macro.tmLanguage.json'),
  'source.c': () => import('../vendor/c.tmLanguage.json')
}
const LANGS: Record<Lang, { scope: string; config: Loader }> = {
  python: { scope: 'source.python', config: () => import('../vendor/python-language-configuration.json') },
  qml: { scope: 'source.qml', config: () => import('../vendor/qml-configuration.json') },
  cpp: { scope: 'source.cpp', config: () => import('../vendor/cpp-language-configuration.json') }
}

type TokenColor = { scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } }
type VsTheme = { colors: Record<string, string>; tokenColors: TokenColor[] }

/** Selector don gian (khong co khoang trang) cua theme -> rule; selector long nhau (a b) bo qua. */
function themeSelectors(theme: VsTheme): Map<string, { foreground?: string; fontStyle?: string }> {
  const map = new Map<string, { foreground?: string; fontStyle?: string }>()
  for (const rule of theme.tokenColors) {
    if (!rule.scope) continue
    const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',')
    for (const raw of scopes) {
      const s = raw.trim()
      if (!s || /\s/.test(s)) continue
      map.set(s, { ...(map.get(s) ?? {}), ...rule.settings })
    }
  }
  return map
}

/** Selector dai nhat (cu the nhat) khop voi scope, theo quy tac tien to cham cua TextMate. */
function bestSelector(scope: string, selectors: Iterable<string>): string | null {
  let best: string | null = null
  for (const sel of selectors) {
    if ((scope === sel || scope.startsWith(sel + '.')) && (!best || sel.length > best.length)) best = sel
  }
  return best
}

class TmState implements monaco.languages.IState {
  constructor(public readonly stack: StateStack) {}
  clone() { return new TmState(this.stack) }
  equals(other: monaco.languages.IState) { return other instanceof TmState && other.stack.equals(this.stack) }
}

const themes = vsThemes as unknown as Record<'dark' | 'light', VsTheme>
const selectorsByMode = { dark: themeSelectors(themes.dark), light: themeSelectors(themes.light) }
const allSelectors = [...new Set([...selectorsByMode.dark.keys(), ...selectorsByMode.light.keys()])]

let registry: Registry | null = null
let onigReady: Promise<void> | null = null
function getRegistry(): Promise<Registry> {
  onigReady ??= (async () => {
    const bin = atob(onigWasmBase64)
    const wasm = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) wasm[i] = bin.charCodeAt(i)
    await loadWASM(wasm.buffer)
  })()
  return onigReady.then(() => {
    registry ??= new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      // Grammar khong co (asm, glsl, x86...) tra null: vscode-textmate bo qua phan nhung do.
      loadGrammar: async (scope) => {
        const load = GRAMMARS[scope]
        if (!load) return null
        return parseRawGrammar(JSON.stringify((await load()).default), `${scope}.json`)
      }
    })
    return registry
  })
}

/** Dang ky grammar + language configuration cho `lang`. Tra ve false neu khong nap duoc (giu tokenizer co san). */
export async function installTextMate(lang: Lang): Promise<boolean> {
  if (!monaco.languages.getLanguages().some((l) => l.id === lang)) monaco.languages.register({ id: lang })
  let grammar: IGrammar | null
  try {
    grammar = await (await getRegistry()).loadGrammar(LANGS[lang].scope)
    monaco.languages.setLanguageConfiguration(lang, toMonacoConfig((await LANGS[lang].config()).default))
  } catch (e) {
    console.warn(`[qt-lsp] textmate unavailable for ${lang}`, e)
    return false
  }
  if (!grammar) return false
  const g = grammar
  const cache = new Map<string, string>()
  const tokenFor = (scopes: string[]): string => {
    const key = scopes.join(' ')
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let token = ''
    for (let i = scopes.length - 1; i >= 0 && !token; i--) token = bestSelector(scopes[i], allSelectors) ?? ''
    cache.set(key, token)
    return token
  }
  monaco.languages.setTokensProvider(lang, {
    getInitialState: () => new TmState(INITIAL),
    tokenize(line, state) {
      const r = g.tokenizeLine(line, (state as TmState).stack, 500)
      return {
        tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: tokenFor(t.scopes) })),
        endState: new TmState(r.ruleStack)
      }
    }
  })
  return true
}

/** Rule Monaco cho theme dang dung: moi selector cua theme VS Code -> mot rule cung ten. */
export function textMateRules(mode: 'dark' | 'light'): monaco.editor.ITokenThemeRule[] {
  const rules: monaco.editor.ITokenThemeRule[] = []
  for (const [token, s] of selectorsByMode[mode]) {
    const rule: monaco.editor.ITokenThemeRule = { token }
    if (s.foreground) rule.foreground = s.foreground.replace('#', '').slice(0, 6)
    if (s.fontStyle !== undefined) rule.fontStyle = s.fontStyle
    rules.push(rule)
  }
  // Selector chi co trong theme kia: dat lai mau chu mac dinh de khong giu mau cua theme cu.
  for (const token of allSelectors) if (!selectorsByMode[mode].has(token)) rules.push({ token, foreground: mode === 'dark' ? 'D4D4D4' : '000000' })
  return rules
}

/** Semantic token -> scope TextMate, theo bang mac dinh cua VS Code (semanticTokenScopes),
 *  them cac loai rieng cua clangd va qmlls. Key: "type" hoac "type.modifier" (modifier cu the hon thang).
 *  Mang rong = de nguyen mau TextMate. */
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
  // clangd: 'comment' = vung #if bi tat; qmlls: comment that
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

/** Token Monaco (selector cua theme) cho mot semantic token; '' neu de nguyen mau TextMate. */
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
