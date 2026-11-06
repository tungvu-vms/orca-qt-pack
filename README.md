# Qt Developer Pack for Orca

Qt, QML, PySide6 and C++ development tools for [Orca](https://github.com/stablyai/orca).

| Plugin | Features |
| --- | --- |
| **Qt Developer Syntax** | Highlighting for Qt project files, QSS, Designer forms, resources, qmake and CMake. |
| **Qt Developer Icons** | Qt and Material file/folder icons, with light and dark themes. |
| **Qt Developer Tools** | Designer, UI/resource compilation, QML lint/format, translations and CMake build commands. |
| **Qt Code Intelligence** | Python/QML/C++ definitions, references, hover, completion, diagnostics and semantic colors. |

## Install

1. Use **Orca 1.4.248+** and enable plugins in **Settings → Plugins**.
2. Choose **Add plugin → Catalog** and enter:

   ```text
   URL: https://github.com/tungvu-vms/orca-qt-pack.git
   Ref: main
   ```

3. Install the plugins you need. Qt Tools and Code Intelligence require approval to run code.
4. Select **Qt Developer Icons** in **Settings → Appearance → Icon theme**.

Choose your workflow: [Python / PySide6](#python--pyside6) · [C++](#c) · [Qt / QML](#qt--qml).

**Release status:** the catalog currently publishes Code Intelligence **0.5.0**.
The latest editing/navigation fixes and automatic LSP views are development-only.
To try this checkout:

```sh
orca plugin dev load plugins/qt-lsp
```

## Navigation and editing

Select the language's **LSP** view if a tab uses Source. Development editor shortcuts:

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

For Designer and UI/resource compilation, choose your Python binding in **Qt Tools** settings.
On Windows, [install-prereqs.ps1](setup/install-prereqs.ps1) checks tools and installs basedpyright.

## C++

**Requires:** clangd, available with Qt Creator or LLVM, and your compiler toolchain.

1. Configure CMake with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` to generate `compile_commands.json`.
2. Open source/header files in **C++ (LSP)** for definitions, hover and completion.
3. Restart clangd using the status-bar button after configuring or changing build settings.

The **Qt Tools** panel provides CMake configure/build commands for Qt projects.

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
