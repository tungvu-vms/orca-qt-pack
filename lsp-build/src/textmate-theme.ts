import vsThemes from '../vendor/themes.json'
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
export function bestSelector(scope: string, selectors: Iterable<string>): string | null {
  let best: string | null = null
  for (const sel of selectors) {
    if ((scope === sel || scope.startsWith(sel + '.')) && (!best || sel.length > best.length)) best = sel
  }
  return best
}

const themes = vsThemes as unknown as Record<'dark' | 'light', VsTheme>
export const selectorsByMode = { dark: themeSelectors(themes.dark), light: themeSelectors(themes.light) }
export const allSelectors = [...new Set([...selectorsByMode.dark.keys(), ...selectorsByMode.light.keys()])]
