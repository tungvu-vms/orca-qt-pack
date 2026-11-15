import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const legacy = JSON.parse(
  readFileSync(
    new URL('../plugins/qt-lsp/orca-plugin.json', import.meta.url),
    'utf8'
  )
)
const common = [
  'remoteHosts',
  'autoFindRemote',
  'remoteRoots',
  'sshPath',
  'remoteNode'
]
export const profiles = [
  {
    language: 'python',
    id: 'python-code-intelligence',
    name: 'Python Code Intelligence',
    description:
      'Python navigation and editing for backend, scripting and Qt projects: definitions, references, hover, completion and diagnostics through basedpyright. Qt is optional.',
    settings: [
      'python',
      'typeCheckingMode',
      'pythonDiagnostics',
      'projectEnvironments',
      'pyrightPath',
      'nodePath'
    ]
  },
  {
    language: 'cpp',
    id: 'cpp-code-intelligence',
    name: 'C/C++ Code Intelligence',
    description:
      'C and C++ navigation, references, hover, completion and diagnostics through clangd. Works with native projects and compilation databases; Qt is optional.',
    settings: ['clangdPath', 'compilerGlobs', 'compilationDatabase']
  },
  {
    language: 'qml',
    id: 'qml-code-intelligence',
    name: 'QML Code Intelligence',
    description:
      'Qt Quick and QML definitions, references, hover, completion and diagnostics through the Qt QML language server (qmlls).',
    settings: ['qtBin', 'qmllsPath']
  }
].map((p) => ({ ...p, folder: `${p.language}-lsp` }))
export function manifestFor(profile) {
  const editor = structuredClone(
    legacy.contributes.customEditors.find(
      (e) => e.id === `${profile.language}-lsp`
    )
  )
  if (profile.language === 'cpp')
    editor.extensions = [
      ...new Set([
        ...editor.extensions,
        '.c++',
        '.tpp',
        '.tcc',
        '.ixx',
        '.cppm'
      ])
    ]
  const keys = [...profile.settings, ...common]
  const settings = [
    ...legacy.contributes.settings,
    {
      key: 'compilationDatabase',
      title: 'Compilation database folder',
      description:
        'Folder containing compile_commands.json. Absolute, or relative to the project root. Empty: discover build folders automatically.',
      type: 'string',
      default: ''
    }
  ].filter((s) => keys.includes(s.key))
  for (const setting of settings)
    if (setting.key === 'clangdPath')
      setting.description =
        'Path to clangd. Empty: PATH first, then known LLVM and Qt Creator installations.'
  return {
    ...legacy,
    id: profile.id,
    name: profile.name,
    version: '0.1.0',
    description: profile.description,
    contributes: {
      events: legacy.contributes.events,
      customEditors: [editor],
      settings
    }
  }
}
export const outputFolders = profiles.map((p) =>
  resolve(import.meta.dirname, '../plugins', p.folder)
)
