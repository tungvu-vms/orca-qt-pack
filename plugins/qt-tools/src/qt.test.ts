// Test logic thuan: quet du an mau, dung lenh cho tung hanh dong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommand, scanProject, q, ToolMissing, type CommandContext } from './qt.ts'

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'qt-tools-test-'))
  for (const d of ['qml', 'ui', 'translations', 'build', 'node_modules/x', '.venv']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'CMakeLists.txt'), 'project(demo)')
  writeFileSync(join(root, 'main.py'), 'from PySide6.QtWidgets import QApplication')
  writeFileSync(join(root, 'helper.py'), 'def f(): pass')
  writeFileSync(join(root, 'tool.py'), 'app = QApplication(sys.argv)')
  writeFileSync(join(root, 'qml', 'Main.qml'), 'import QtQuick')
  writeFileSync(join(root, 'ui', 'main window.ui'), '<ui/>')
  writeFileSync(join(root, 'app.qrc'), '<RCC/>')
  writeFileSync(join(root, 'translations', 'app_vi.ts'), '<?xml version="1.0"?><!DOCTYPE TS><TS version="2.1"></TS>')
  writeFileSync(join(root, 'src.ts'), 'export const x = 1')
  writeFileSync(join(root, 'build', 'ignored.qml'), '')
  writeFileSync(join(root, 'node_modules', 'x', 'ignored.qml'), '')
  return root
}

test('scanProject lists Qt files, skips build dirs, TypeScript .ts and non-entry .py', () => {
  const root = project()
  try {
    const { files, truncated } = scanProject(root)
    assert.equal(truncated, false)
    assert.deepEqual(files.map((f) => `${f.kind}:${f.path}`), [
      'cmake:CMakeLists.txt',
      'py:main.py',
      'py:tool.py',
      'qml:qml/Main.qml',
      'ui:ui/main window.ui',
      'qrc:app.qrc',
      'ts:translations/app_vi.ts'
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('scanProject respects the file limit', () => {
  const root = project()
  try { assert.equal(scanProject(root, 2).truncated, true) } finally { rmSync(root, { recursive: true, force: true }) }
})

const tools = { designer: '/qt/bin/designer', uic: '/qt/bin/uic', rcc: '/qt/bin/rcc', qmllint: '/qt/bin/qmllint', qmlformat: '/qt/bin/qmlformat', qml: '/qt/bin/qml', lupdate: '/qt/bin/lupdate', lrelease: '/qt/bin/lrelease', linguist: '/qt/bin/linguist', qmake: '/qt/bin/qmake', cmake: '/qt/cmake' }
const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({ root: '/p', tools, binding: 'pyside6', python: null, cmakeGenerator: 'Ninja', cmakeBuildType: 'Debug', ...over })

test('uic targets each binding', () => {
  const path = 'ui/main window.ui'
  assert.match(buildCommand('uic', ctx({ path }))!, /uic.* -g python .*main window\.ui.* -o .*ui\/ui_main window\.py/)
  assert.match(buildCommand('uic', ctx({ path, binding: 'pyqt6', python: '/venv/python' }))!, /python.* -m PyQt6\.uic\.pyuic /)
  assert.match(buildCommand('uic', ctx({ path, binding: 'cpp' }))!, /ui_main window\.h/)
})

test('rcc output names', () => {
  assert.match(buildCommand('rcc', ctx({ path: 'app.qrc' }))!, /-g python app\.qrc -o app_rc\.py/)
  assert.match(buildCommand('rcc', ctx({ path: 'app.qrc', binding: 'pyqt5' }))!, /PyQt5\.pyrcc_main/)
  assert.match(buildCommand('rcc', ctx({ path: 'app.qrc', binding: 'cpp' }))!, /qrc_app\.cpp/)
})

test('cmake uses generator and build type settings', () => {
  const c = buildCommand('cmake-configure', ctx({ cmakeGenerator: 'MinGW Makefiles', cmakeBuildType: 'Release' }))!
  assert.match(c, /-S \. -B build -G .*MinGW Makefiles/)
  assert.match(c, /-DCMAKE_BUILD_TYPE=Release/)
  assert.match(buildCommand('cmake-build', ctx())!, /--build build --parallel$/)
})

test('missing tool throws ToolMissing', () => {
  assert.throws(() => buildCommand('designer', ctx({ tools: { ...tools, designer: null } })), ToolMissing)
})

test('open needs no terminal', () => {
  assert.equal(buildCommand('open', ctx({ path: 'a.qml' })), null)
})

test('quoting handles spaces and quotes', () => {
  const s = q("it's a file.qml")
  assert.ok(s.startsWith("'") && s.endsWith("'"))
  assert.equal(q('plain.qml'), 'plain.qml')
})
