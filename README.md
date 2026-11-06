# Developer Tools for Orca

Qt, QML, PySide6 and C++ development tools for [Orca](https://github.com/stablyai/orca).

| Plugin | Install for |
| --- | --- |
| **Python Code Intelligence** | Python backend, scripts, automation, PySide6/PyQt; uses basedpyright. |
| **C/C++ Code Intelligence** | Native C/C++ projects using clangd; Qt and CMake are optional. |
| **QML Code Intelligence** | Qt Quick projects using qmlls. |
| **Qt Developer Tools** | Designer, UI/resource compilation, QML tools, translations and Qt builds. |
| **Qt Developer Syntax** | Qt project files, QSS, Designer forms, qmake and CMake highlighting. |
| **Qt Developer Icons** | Optional Qt and Material icons, with light/dark themes. |

## Install only what you need

Use **Orca 1.4.248+** with plugins enabled. The three independent language plugins
are development builds (**0.1.0**); they have not been published to the catalog yet.
The catalog on `main` still provides the combined **Qt Code Intelligence 0.5.0**.

To try the independent plugins:

```sh
git clone --branch tungvu-vms/qt-lsp-codex https://github.com/tungvu-vms/orca-qt-pack.git
cd orca-qt-pack
```

Disable the old **Qt Code Intelligence (Python, QML, C++)** in Orca first, then load
only the folders you want. Each runs independently and requires approval:

| Language | Load from the repository root |
| --- | --- |
| Python | `orca plugin dev load plugins/python-lsp` |
| C/C++ | `orca plugin dev load plugins/cpp-lsp` |
| QML | `orca plugin dev load plugins/qml-lsp` |

These are development folders, so keep the checkout in place. See the
[migration guide](docs/MIGRATION.md) for settings and the legacy plugin.

Optional Qt Tools, Syntax and Icons are available from **Settings → Plugins →
Add plugin → Catalog**, URL `https://github.com/tungvu-vms/orca-qt-pack.git`, ref `main`.
Choose the icon theme in **Settings → Appearance → Icon theme**. A Python backend
or non-Qt C++ project needs none of the Qt plugins.

Choose your workflow: [Python / PySide6](#python--pyside6) · [C++](#c) · [Qt / QML](#qt--qml).

## Navigation and editing

Select the language's **LSP** view if a tab uses Source. Shortcuts in the independent language editors:

| Action | Shortcut |
| --- | --- |
| Go to definition | F12 or Ctrl+Click (Cmd+Click on macOS) |
| List usages at a declaration | Ctrl+Click / Cmd+Click on the declared name |
| Find references | Shift+F12 |
| Find symbols in the file | Ctrl+Shift+O / Cmd+Shift+O |
| Show parameter hints | Ctrl+Shift+Space / Cmd+Shift+Space |
| Rename in the current file / undo | F2 / Ctrl+Z (Cmd+Z) |
| Editor commands | F1 |

Double-click a reference to open its file and line. Cross-file rename is not supported.
Library files outside every workspace and SSH results stay in a read-only peek.
The first lookup may take a few seconds while the language server analyzes imports.

## Python / PySide6

**Requires:** Node.js 20+ and a Python environment with your project's dependencies.
basedpyright installs automatically on first use.

1. Open `.py`, `.pyi` or `.pyw` files in **Python (LSP)**.
2. Use the interpreter button below the editor to select your environment. For Qt
   types, select one with **PySide6** or the PyQt binding your project uses installed.
3. Use **F1 → Python: Toggle Diagnostics** to hide or show Python warnings.

For Designer and UI/resource compilation, optionally install **Qt Tools** and choose your Python binding.

## C++

**Requires:** clangd, available with Qt Creator or LLVM, and your compiler toolchain.

1. Configure CMake with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` to generate `compile_commands.json`.
2. Open source/header files in **C++ (LSP)** for definitions, hover and completion.
3. For external/custom build layouts, set **Compilation database folder**. Restart clangd after build configuration changes.

Meson, Make/Bear and other build systems can also supply the database; `.clangd` and
`compile_flags.txt` are supported by clangd. Optional [C/C++ & CMake Kit](https://github.com/be0hhh/orca-cpp-kit)
adds regular-editor syntax for template/module files and CMake; it does not replace clangd.

## Qt / QML

**Requires:** Qt 6.5+ with `qmlls` and the project's Qt kit/import paths.

1. Set **Qt bin folder** in plugin settings if Qt is not detected automatically.
2. Configure the project, open `.qml` files in **QML (LSP)**, then restart qmlls from the status bar.
3. Open **Qt Tools** from the sidebar wrench for Designer, QML lint/format, resources and translations.

For QML highlighting in Orca's regular editor, also install **QML Syntax** (`stablyai.orca-qml`).

## Settings and security

Plugin settings control interpreters, Qt/tool paths, diagnostics and SSH discovery.
See [configuration and SSH](docs/CONFIGURATION.md) for setup details.

Qt Tools and Code Intelligence run with your account's permissions. Only use trusted
projects and environments; disable project environments or automatic SSH discovery
when needed. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Development

Use Node.js 24 for development.

```sh
npm ci --ignore-scripts
npm --prefix lsp-build ci --ignore-scripts
npm --prefix lsp-build run build
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for browser/native tests and the
[maintainer guide](docs/HANDOFF-qt-lsp.md) for architecture and release steps.

## Sources and licenses

Copyright © 2026 **Tùng Vũ**. Original code is [MIT licensed](LICENSE).
Third-party components retain their own licenses; see [sources and notices](docs/THIRD_PARTY.md).
