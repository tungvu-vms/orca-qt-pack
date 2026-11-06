# Install language support independently

The development branch provides three separate trusted-worker plugins:

| Plugin ID (publisher: `tungvu-vms`) | Folder | Runtime requirements |
| --- | --- | --- |
| `python-code-intelligence` | `plugins/python-lsp` | Node.js and basedpyright; Python environment for project imports |
| `cpp-code-intelligence` | `plugins/cpp-lsp` | clangd and compiler/build configuration |
| `qml-code-intelligence` | `plugins/qml-lsp` | Qt and qmlls |

Qt/PySide6 is optional for Python. Qt and Python are not required for the C/C++
editor. QML needs Qt but does not require a Python environment. SSH agents need
Node.js on the remote host for any language. Qt Tools, Qt Syntax and Icons remain
optional, independent plugins. No Common Core installation is required.

## Moving from Qt Code Intelligence 0.5.0

1. Finish or save edits in the old editor before changing plugin registrations.
   Disabling plugins is an explicit user action; migration never saves project
   files, disables another plugin, or replaces an open unsaved editor automatically.
2. In Orca **Settings → Plugins**, disable the combined **Qt Code Intelligence
   (Python, QML, C++)**. For a development folder, unload `plugins/qt-lsp` instead.
3. Load only the new folders you need using `orca plugin dev load <folder>`.
   Their local keys are `local.python-code-intelligence`,
   `local.cpp-code-intelligence` and `local.qml-code-intelligence`.
4. Reopen the file or select its new LSP view. The new packages register disjoint
   extensions, including `.tpp`, `.tcc`, `.ixx` and `.cppm` for C/C++.

Keep the legacy and replacement editors from being enabled together: their
default extension registrations overlap. The legacy output is retained unchanged
for existing installations and rollback. Catalog version 0.5.0 remains pinned to
its published commit; cloning `main` does not install the development split.

## Settings to select again

Orca stores each plugin's settings and workspace choices separately. The new
plugins cannot read the old plugin's private storage, and do not request extra
permissions to do so. Defaults work without a manual transfer; copy custom values
through the settings UI when needed:

| Previous setting/choice | New location |
| --- | --- |
| Selected Python interpreter, `python`, `projectEnvironments` | Python |
| `pythonDiagnostics`, `typeCheckingMode`, `pyrightPath`, `nodePath` | Python |
| `clangdPath`, `compilerGlobs` | C/C++ |
| Compilation database outside standard build folders | C/C++ → `compilationDatabase` (new) |
| `qtBin`, `qmllsPath` | QML |
| `remoteHosts`, `autoFindRemote`, `remoteRoots`, `sshPath`, `remoteNode`, selected host | Each language plugin independently |

Executable paths are host-specific. When using SSH, discovery runs on the remote
host; do not copy a local executable path as though it existed there. C/C++'s
compilation database setting is interpreted on the server's host and may be an
absolute folder or relative to that host's project root. An invalid explicit
folder produces an error rather than silently selecting another database.

The Python package reuses the existing machine-level basedpyright download cache.
New SSH agents keep preferences/known roots in `state-<plugin-id>.json` under the
existing agent cache directory. They validate their language/plugin identity and
do not overwrite another plugin's state. The legacy `state.json` remains intact.

## Development size measurements

Initial builds measured about **4.4 MiB Python**, **5.1 MiB C/C++**, **4.4 MiB QML**,
versus **5.4 MiB** for the combined legacy folder. Installing one package avoids
other language grammars, settings and launch adapters; installing all three takes
more disk because each folder contains its own Monaco/runtime assets. This is not
a claim of reduced total Orca RAM. Existing per-editor idle and preview limits remain.

The companion [C/C++ & CMake Kit](https://github.com/be0hhh/orca-cpp-kit) adds syntax
to Orca's regular editor. It does not provide clangd, definitions or completion.
Its CMake associations overlap with Qt Syntax; inspect highlighting preferences
if both syntax plugins are enabled. No code from that repository is bundled here.
