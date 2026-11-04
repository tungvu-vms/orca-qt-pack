// Tao theme.json / theme-light.json cho Qt Developer Icons:
// lay theme Material lam nen, them icon Qt cho cac loai file/ten file/thu muc cua du an Qt.
// Dung: node build-icon-theme.mjs <plugin-dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const qtExt = {
  qml: 'qml', qmlproject: 'qml', qrc: 'qrc', qss: 'qss', ts: null, ui: 'ui',
  qtd: 'qtd', qzt: 'qzt', qdoc: 'qdoc', qdocconf: 'qdoc', qdocinc: 'qdoc'
}
const qtFileNames = { qmldir: 'qmldir', 'pysidedeploy.spec': 'pysidedeploy' }
// dung icon Material co san cho cac loai file khac trong du an Qt
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
// thu muc quen thuoc cua du an Qt -> dung icon thu muc Material gan nghia
const folderMap = {
  qml: 'components', ui: 'components', forms: 'components', resources: 'assets', res: 'assets',
  icons: 'images', translations: 'docs', i18n: 'docs', plugins: 'packages', include: 'lib',
  cmake: 'config', tests: 'test'
}

function build(base, light) {
  const t = JSON.parse(readFileSync(join(dir, 'icons', base), 'utf8'))
  const qt = (name) => {
    const p = `icons/qt/${name}${light ? '_light' : ''}.svg`
    if (!existsSync(join(dir, p))) throw new Error(`thieu ${p}`)
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
  // .ts mac dinh la TypeScript; file Linguist nam trong thu muc translations/i18n nen giu nguyen TypeScript
  // Orca gioi han 512 mapping: bo bot ten file Material (tu cuoi danh sach), giu cac muc cua Qt
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
