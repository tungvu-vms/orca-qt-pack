// Copies the Python grammar + Dark+/Light+ themes from VS Code (MIT) into vendor/, merging theme includes.
// Run once when changing the VS Code version; vendor/ is committed, so the build does not need VS Code.
// Usage: node prepare-vendor.mjs "<VS Code>\resources\app\extensions"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ext = process.argv[2]
if (!ext) throw new Error('usage: node prepare-vendor.mjs <vscode extensions dir>')
const out = resolve(import.meta.dirname, 'vendor')
mkdirSync(out, { recursive: true })

function stripJsonc(text) {
  let s = '', inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (inStr) { s += c; if (c === '\\') { s += n; i++ } else if (c === '"') inStr = false }
    else if (c === '"') { inStr = true; s += c }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; s += '\n' }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++ }
    else s += c
  }
  return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'))
}

/** VS Code theme -> { colors, tokenColors } with `include` merged (child theme wins). */
function loadTheme(file) {
  const t = stripJsonc(readFileSync(file, 'utf8'))
  const base = t.include ? loadTheme(join(dirname(file), t.include)) : { colors: {}, tokenColors: [] }
  return {
    colors: { ...base.colors, ...(t.colors ?? {}) },
    tokenColors: [...base.tokenColors, ...(Array.isArray(t.tokenColors) ? t.tokenColors : [])]
  }
}

copyFileSync(join(ext, 'python', 'syntaxes', 'MagicPython.tmLanguage.json'), join(out, 'MagicPython.tmLanguage.json'))
copyFileSync(join(ext, 'python', 'syntaxes', 'MagicRegExp.tmLanguage.json'), join(out, 'MagicRegExp.tmLanguage.json'))
writeFileSync(join(out, 'python-language-configuration.json'), JSON.stringify(stripJsonc(readFileSync(join(ext, 'python', 'language-configuration.json'), 'utf8')), null, 1))
// C/C++ (VS Code built-in "cpp", MIT)
for (const g of ['cpp.tmLanguage.json', 'c.tmLanguage.json', 'cpp.embedded.macro.tmLanguage.json']) copyFileSync(join(ext, 'cpp', 'syntaxes', g), join(out, g))
writeFileSync(join(out, 'cpp-language-configuration.json'), JSON.stringify(stripJsonc(readFileSync(join(ext, 'cpp', 'language-configuration.json'), 'utf8')), null, 1))
// QML (seanwu1105/vscode-qt-for-python, MIT) + JavaScript dependency, taken from stablyai/orca-plugins plugins/qml
const qml = resolve(import.meta.dirname, '..', '_ref', 'orca-plugins', 'plugins', 'qml', 'syntaxes')
for (const g of ['qml.tmLanguage.json', 'qml-configuration.json', 'javascript.tmLanguage.json']) copyFileSync(join(qml, g), join(out, g))
copyFileSync(join(qml, 'qml-LICENSE.txt'), join(out, 'LICENSE-qml-grammar.txt'))
const themes = {
  dark: loadTheme(join(ext, 'theme-defaults', 'themes', 'dark_plus.json')),
  light: loadTheme(join(ext, 'theme-defaults', 'themes', 'light_plus.json'))
}
writeFileSync(join(out, 'themes.json'), JSON.stringify(themes))
const pkg = JSON.parse(readFileSync(join(ext, '..', 'package.json'), 'utf8'))
writeFileSync(join(out, 'SOURCE.txt'), `Copied from VS Code ${pkg.version} (${pkg.distro ?? ''}) built-in extensions "python", "cpp" and "theme-defaults", MIT.\nMagicPython grammar: MagicStack Inc., MIT.\nQML grammar: seanwu1105/vscode-qt-for-python (MIT) via stablyai/orca-plugins; JavaScript grammar: microsoft/vscode (MIT).\n`)
console.log('vendor ok:', Object.keys(themes).map((k) => `${k} ${themes[k].tokenColors.length} rules`).join(', '))
