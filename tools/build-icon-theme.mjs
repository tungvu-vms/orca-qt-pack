// Generates theme.json / theme-light.json for Qt Developer Icons:
// takes the Material theme as the base and adds Qt icons for Qt project file types, file names and folders.
// Usage: node build-icon-theme.mjs <plugin-dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const qtExt = {
  qml: 'qml', qmlproject: 'qml', qrc: 'qrc', qss: 'qss', ts: null, ui: 'ui',
  qtd: 'qtd', qzt: 'qzt', qdoc: 'qdoc', qdocconf: 'qdoc', qdocinc: 'qdoc'
}
const qtFileNames = { qmldir: 'qmldir', 'pysidedeploy.spec': 'pysidedeploy' }
// reuse existing Material icons for other file types found in Qt projects
const reuseExt = {
  pro: 'icons/settings.svg', pri: 'icons/settings.svg', prf: 'icons/settings.svg',
  cmake: 'icons/cmake.svg', pyi: 'icons/python.svg', pyw: 'icons/python.svg',
  h: 'icons/h.svg', hpp: 'icons/hpp.svg', cpp: 'icons/cpp.svg', cxx: 'icons/cpp.svg', cc: 'icons/cpp.svg'
}
const reuseNames = {
  'cmakelists.txt': 'icons/cmake.svg', 'cmakepresets.json': 'icons/cmake.svg', 'cmakeuserpresets.json': 'icons/cmake.svg',
  'cmakecache.txt': 'icons/cmake.svg', '.qmake.conf': 'icons/settings.svg', 'requirements.txt': 'icons/python-misc.svg',
  'pyproject.toml': 'icons/python-misc.svg'
}
// common Qt project folders -> the closest matching Material folder icon
const folderMap = {
  qml: 'components', ui: 'components', forms: 'components', resources: 'assets', res: 'assets',
  icons: 'images', translations: 'docs', i18n: 'docs', plugins: 'packages', include: 'lib',
  cmake: 'config', tests: 'test'
}

function build(base, light) {
  const t = JSON.parse(readFileSync(join(dir, 'icons', base), 'utf8'))
  const qt = (name) => {
    const p = `icons/qt/${name}${light ? '_light' : ''}.svg`
    if (!existsSync(join(dir, p))) throw new Error(`missing ${p}`)
    return p
  }
  for (const [e, name] of Object.entries(qtExt)) if (name) t.fileExtensions[e] = qt(name)
  for (const [n, name] of Object.entries(qtFileNames)) t.fileNames[n] = qt(name)
  for (const [e, p] of Object.entries(reuseExt)) if (!t.fileExtensions[e] && existsSync(join(dir, p))) t.fileExtensions[e] = p
  for (const [n, p] of Object.entries(reuseNames)) if (!t.fileNames[n] && existsSync(join(dir, p))) t.fileNames[n] = p
  for (const [f, like] of Object.entries(folderMap)) {
    if (t.folderNames[f]) continue
    if (t.folderNames[like]) { t.folderNames[f] = t.folderNames[like]; t.folderNamesExpanded[f] = t.folderNamesExpanded[like] }
  }
  // .ts defaults to TypeScript; Linguist files live in translations/i18n folders, so keep the TypeScript icon
  // Orca allows at most 512 mappings: drop Material file names (from the end of the list), keep the Qt entries
  const keep = new Set([...Object.keys(qtFileNames), ...Object.keys(reuseNames)])
  const count = () => ['icons', 'fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded']
    .reduce((n, k) => n + Object.keys(t[k]).length, 0)
  const names = Object.keys(t.fileNames).reverse()
  for (const n of names) {
    if (count() <= 512) break
    if (!keep.has(n)) delete t.fileNames[n]
  }
  return t
}

writeFileSync(join(dir, 'icons', 'theme.json'), JSON.stringify(build('theme.json', false), null, 1) + '\n')
writeFileSync(join(dir, 'icons', 'theme-light.json'), JSON.stringify(build('theme-light.json', true), null, 1) + '\n')
console.log('ok')
