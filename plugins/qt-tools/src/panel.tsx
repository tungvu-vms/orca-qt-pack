// Panel Qt Tools: liet ke file Qt cua workspace dang focus, moi file co nut hanh dong.
import {
  atom, Badge, Button, Callout, EmptyState, Heading, IconButton, List, ListItem, on, plugin, read, Row, set,
  Spinner, Stack, Tab, Tabs, Text, type PanelContext
} from 'orca'
import type { ProjectInfo, QtAction, QtFile, QtFileKind } from './protocol'

const info = atom<ProjectInfo | null>(null)
const loading = atom(true)
const status = atom<{ ok: boolean; message: string } | null>(null)
const tab = atom('qt-tab', 'files', { persist: 'plugin' })

async function scan(): Promise<void> {
  set(loading, true)
  try { set(info, await plugin.request('qt.scan')) }
  catch (e) { set(status, { ok: false, message: e instanceof Error ? e.message : String(e) }) }
  finally { set(loading, false) }
}

async function runAction(action: QtAction, path?: string): Promise<void> {
  try { set(status, await plugin.request('qt.run', { action, path })) }
  catch (e) { set(status, { ok: false, message: e instanceof Error ? e.message : String(e) }) }
}

export function setup(ctx: PanelContext): void {
  // quet lai khi doi workspace
  ctx.subscriptions.push(on('workspace.changed', () => { void scan() }))
  void scan()
}

interface ActionDef { action: QtAction; label: string; icon: 'edit' | 'play' | 'check' | 'refresh' | 'code' | 'open-external' | 'globe' | 'hammer' }
const ACTIONS: Record<QtFileKind, ActionDef[]> = {
  ui: [{ action: 'designer', label: 'Designer', icon: 'edit' }, { action: 'uic', label: 'uic', icon: 'hammer' }],
  qrc: [{ action: 'rcc', label: 'rcc', icon: 'hammer' }],
  qml: [{ action: 'qml-preview', label: 'Preview', icon: 'play' }, { action: 'qmllint', label: 'Lint', icon: 'check' }, { action: 'qmlformat', label: 'Format', icon: 'code' }],
  ts: [{ action: 'linguist', label: 'Linguist', icon: 'globe' }, { action: 'lrelease', label: 'lrelease', icon: 'hammer' }],
  pro: [{ action: 'qmake', label: 'qmake', icon: 'hammer' }, { action: 'lupdate', label: 'lupdate', icon: 'refresh' }],
  cmake: [{ action: 'cmake-configure', label: 'Configure', icon: 'refresh' }, { action: 'cmake-build', label: 'Build', icon: 'hammer' }],
  py: [{ action: 'run-python', label: 'Run', icon: 'play' }]
}
const GROUPS: { kind: QtFileKind; title: string }[] = [
  { kind: 'cmake', title: 'CMake' }, { kind: 'pro', title: 'qmake' }, { kind: 'py', title: 'Python entry points' },
  { kind: 'qml', title: 'QML' }, { kind: 'ui', title: 'Designer forms' }, { kind: 'qrc', title: 'Resources' }, { kind: 'ts', title: 'Translations' }
]

function FileRow({ file }: { file: QtFile }) {
  const name = file.path.split('/').pop() ?? file.path
  const dir = file.path.slice(0, file.path.length - name.length)
  return (
    <ListItem title={name} description={dir || undefined}>
      <Row gap="xs" wrap>
        <Button size="sm" variant="ghost" icon="file" onPress={() => runAction('open', file.path)}>Mở</Button>
        {ACTIONS[file.kind].map((a) => (
          <Button size="sm" variant="ghost" icon={a.icon} onPress={() => runAction(a.action, file.path)}>{a.label}</Button>
        ))}
      </Row>
    </ListItem>
  )
}

function Files({ p }: { p: ProjectInfo }) {
  if (!p.files.length) return <EmptyState icon="folder" title="Không thấy file Qt" description="Không có .ui, .qrc, .qml, .ts, .pro hay CMakeLists.txt trong workspace này." />
  return (
    <Stack gap="md">
      {GROUPS.map((g) => {
        const files = p.files.filter((f) => f.kind === g.kind)
        if (!files.length) return null
        return (
          <List label={`${g.title} (${files.length})`}>
            {files.map((f) => <FileRow file={f} />)}
          </List>
        )
      })}
      {p.truncated ? <Text muted size="xs">Chỉ hiện 400 file đầu tiên.</Text> : null}
    </Stack>
  )
}

function Toolchain({ p }: { p: ProjectInfo }) {
  return (
    <Stack gap="sm">
      <List label="Công cụ Qt">
        {Object.entries(p.tools).map(([name, path]) => (
          <ListItem title={name} description={path ?? 'Không thấy: đặt "Qt bin folder" trong Settings của plugin'} icon={path ? 'check' : 'warning'} />
        ))}
        <ListItem title="python" description={p.python ?? 'python trên PATH'} icon="code" />
      </List>
      <Text muted size="xs">Binding: {p.binding}. Đổi trong Settings → Plugins → Qt Developer Tools.</Text>
    </Stack>
  )
}

export default function Panel() {
  const p = read(info)
  const busy = read(loading)
  const s = read(status)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>{p?.workspaceName ?? 'Qt Tools'}</Heading>
        <Row gap="xs">
          {p ? <Badge tone="accent">{p.files.length}</Badge> : null}
          <IconButton icon="refresh" label="Quét lại" onPress={scan} />
        </Row>
      </Row>
      {s ? <Callout tone={s.ok ? 'success' : 'danger'}>{s.message}</Callout> : null}
      {busy && !p ? <Spinner label="Đang quét dự án" /> : null}
      {p && !p.workspaceId ? <EmptyState icon="folder" title="Chưa chọn workspace" description="Mở một workspace trong Orca để thấy file Qt của nó." /> : null}
      {p && p.workspaceId ? (
        <Tabs label="Qt Tools" value={read(tab)} onChange={(v) => set(tab, v)}>
          <Tab value="files" label="Files"><Files p={p} /></Tab>
          <Tab value="tools" label="Toolchain"><Toolchain p={p} /></Tab>
        </Tabs>
      ) : null}
    </Stack>
  )
}
