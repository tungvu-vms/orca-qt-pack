// Panel <-> worker contract.
export {}

export type QtFileKind = 'ui' | 'qrc' | 'qml' | 'ts' | 'pro' | 'cmake' | 'py'

export interface QtFile {
  kind: QtFileKind
  /** Path relative to the workspace root, using '/' separators */
  path: string
}

export interface ProjectInfo {
  workspaceId: string | null
  workspaceName: string | null
  root: string | null
  files: QtFile[]
  truncated: boolean
  tools: Record<string, string | null>
  binding: string
  python: string | null
}

export type QtAction =
  | 'designer' | 'uic' | 'rcc' | 'qmllint' | 'qmlformat' | 'qml-preview'
  | 'lupdate' | 'lrelease' | 'linguist' | 'open'
  | 'cmake-configure' | 'cmake-build' | 'qmake' | 'run-python'

declare module 'orca' {
  interface PluginRequests {
    'qt.scan': { output: ProjectInfo }
    'qt.run': { input: { action: QtAction; path?: string }; output: { ok: boolean; message: string } }
  }
}
