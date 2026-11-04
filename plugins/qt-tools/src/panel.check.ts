// Scenarios for `orca plugin check`: the panel with a workspace holding every kind of Qt file.
import { defineCheck } from 'orca/testing'
import type { ProjectInfo } from './protocol'

const project: ProjectInfo = {
  workspaceId: 'w1', workspaceName: 'demo-app', root: 'C:/demo-app', truncated: false, binding: 'pyside6', python: null,
  files: [
    { kind: 'cmake', path: 'CMakeLists.txt' }, { kind: 'py', path: 'main.py' }, { kind: 'qml', path: 'qml/Main.qml' },
    { kind: 'ui', path: 'ui/mainwindow.ui' }, { kind: 'qrc', path: 'app.qrc' }, { kind: 'ts', path: 'translations/app_vi.ts' }
  ],
  tools: { designer: 'C:/Qt/bin/designer.exe', uic: 'C:/Qt/bin/uic.exe', qmllint: null }
}

export default defineCheck({
  project: { requests: { 'qt.scan': () => project } },
  noWorkspace: { requests: { 'qt.scan': () => ({ ...project, workspaceId: null, workspaceName: null, files: [] }) } }
})
