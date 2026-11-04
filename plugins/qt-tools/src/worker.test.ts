// Runs the worker the way Orca does: checks that it starts, scans the workspace and handles the QML save hook.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker.ts'

const capabilities = ['workspace:read', 'workspace:write', 'terminal:send', 'notifications:show', 'settings:own']

test('worker starts and registers its commands', async () => {
  const worker = await mountWorker(main, {
    host: mockHost({ capabilities, results: { 'workspace.readContext': null } }),
    commands: ['qt.designer', 'qt.cmake.configure', 'qt.cmake.build', 'qt.qmllint.all', 'qt.uic.all', 'qt.rcc.all', 'qt.lupdate', 'qt.doctor'],
    hooks: [{ event: 'editor.save.before', onError: 'pass' }]
  })
  const r = await worker.command('qt.designer')
  assert.match(String(r), /workspace/i)
  await worker.deactivate()
})

test('save hook leaves non-QML files alone', async () => {
  const worker = await mountWorker(main, {
    host: mockHost({ capabilities, settings: { formatQmlOnSave: true } }),
    hooks: [{ event: 'editor.save.before', onError: 'pass' }]
  })
  const event = { workspaceId: 'w', path: 'a.py', languageId: 'python', text: 'x=1\n' }
  const out = await worker.hooks.fire('editor.save.before', event)
  assert.equal(out.kind, 'continue')
  await worker.deactivate()
})
