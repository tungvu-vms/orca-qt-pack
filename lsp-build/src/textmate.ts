// VS Code-like highlighting for Python, QML and C/C++: TextMate grammars (MagicPython, QML, VS Code's C++)
// + Dark+/Light+ themes, run with vscode-textmate. Grammars load lazily (dynamic import) so a Python file
// does not have to load the C++ grammar (~500 KB).
// Monaco receives tokens as scope strings; the Monaco theme has one rule per VS Code theme selector,
// and the returned token is just the most specific scope matching the theme (like VS Code picks colors).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type StateStack } from 'vscode-textmate'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
// WASM embedded as base64 in the JS: the plugin frame returns empty when fetching a .wasm file
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

/** Simple theme selectors (no spaces) -> rule; nested selectors (a b) are ignored. */
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

/** Longest (most specific) selector matching the scope, using TextMate's dotted-prefix rule. */
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
      // Missing grammars (asm, glsl, x86...) return null: vscode-textmate skips those embedded parts.
      loadGrammar: async (scope) => {
        const load = GRAMMARS[scope]
        if (!load) return null
        return parseRawGrammar(JSON.stringify((await load()).default), `${scope}.json`)
      }
    })
    return registry
  })
}

/** Register grammar + language configuration for `lang`. Returns false if loading fails (the built-in tokenizer stays). */
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
