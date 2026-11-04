# Qt Developer Pack for Orca

Four [Orca](https://github.com/stablyai/orca) plugins for Qt / QML / PySide6 / PyQt developers working in Python and C++.

| Plugin | Kind | Asks for approval | What it does |
| --- | --- | --- | --- |
| **Qt Developer Syntax** (`qt-dev-syntax`) | `data` | No | Highlighting for `.qss`, `.qrc`, `.ui`, `.qtd`, `.qdoc`, `pysidedeploy.spec`, qmake (`.pro/.pri/.prf`), `.cmake`, `CMakeCache.txt`, `requirements.txt` |
| **Qt Developer Icons** (`qt-dev-icons`) | `data` | No | Material file icons (~470 file types) plus Qt icons for `.qml`, `.ui`, `.qrc`, `.qss`, `qmldir`, QDoc and PySide6 deploy specs; folder icons for `qml/`, `ui/`, `resources/`, `translations/`… Light and dark variants |
| **Qt Developer Tools** (`qt-dev-tools`) | `trusted-worker` | **Yes** | A "Qt Tools" panel listing the workspace's Qt files with Designer / uic / rcc / qmllint / Preview / Format / Linguist / lrelease / CMake configure + build / qmake / Run buttons; 8 Command Palette commands; `qmlformat` on save; `Ctrl+Shift+B` runs CMake build |
| **Qt Code Intelligence** (`qt-dev-python-lsp`) | `trusted-worker` | **Yes** | VS Code-style **Python (LSP)**, **QML (LSP)** and **C++ (LSP)** editor views: Ctrl+Click / F12 to go to definition (imports, functions, variables, Qt classes), hover, completion, diagnostics and semantic colors. Picks the project's Python interpreter like VS Code. Also works on files that live on another machine, over SSH |

Also install the official **QML Syntax** plugin (`stablyai.orca-qml`) from Settings → Plugins to get `.qml` and `qmldir`
highlighting in Orca's regular editor.

![Qt Tools panel](docs/panel-files.png)

## Install

### 1. Requirements

| Needed | For | How |
| --- | --- | --- |
| Orca ≥ 1.4.248 with plugins turned on (Settings → Plugins) | Everything | |
| Node.js ≥ 20 | Python (LSP) | https://nodejs.org — basedpyright installs itself the first time a Python file is opened |
| Qt ≥ 6.5 (with `qmlls`) under `C:\Qt` or `~/Qt` | QML (LSP), Qt Tools | Qt Online Installer, or set *Qt bin folder* |
| clangd | C++ (LSP) | Ships with **Qt Creator** (`C:\Qt\Tools\QtCreator\bin\clang\bin`) or LLVM; macOS: Xcode Command Line Tools; Linux: `apt install clangd` |
| `compile_commands.json` in the build folder | C++ (LSP) | CMake configure with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` (Qt Tools' *Configure* button sets it) |
| OpenSSH client, key login to the other machine, Node.js ≥ 18 there | Code on another machine (optional) | See [Code on another machine](#code-on-another-machine-ssh) |

On Windows, `setup/install-prereqs.ps1` checks all of this and installs basedpyright:
`powershell -ExecutionPolicy Bypass -File setup\install-prereqs.ps1`

### 2. Add the catalog and install

1. Orca → **Settings → Plugins → Add plugin → catalog**, URL `https://github.com/tungvu-vms/orca-qt-pack.git`, ref `main`.
   Or open this link and let Orca add the catalog:
   `orca://plugins/tungvu-vms.qt-dev-python-lsp?catalog=https://github.com/tungvu-vms/orca-qt-pack.git`
2. Install the plugins you want from the **Qt Developer Pack** catalog.
3. The two `trusted-worker` plugins (Qt Tools, Code Intelligence) run their own code with your user's access, so Orca
   asks you to approve them. Read [Security](#security) first.
4. **Settings → Appearance → Icon theme** → *Qt Developer Icons* (or the Light variant).

Orca checks the catalog for updates by itself; Settings → Plugins → ↻ checks now.

### 3. Use

- **Qt Tools:** the wrench icon in the right sidebar.
- **Code Intelligence:** open a `.py` / `.qml` / `.cpp` / `.h` file and pick **Python (LSP)** / **QML (LSP)** /
  **C++ (LSP)** in the view switcher next to **Source**.
  - Status bar: server state and problem count. 🐍 (Python) switches the interpreter; ⚙ (QML/C++) restarts the server
    (press it after the first CMake configure). ⇄ shows and changes which machine the project's code is on.
  - Ctrl+Click into a file inside an Orca workspace (your project, its venv, the build folder) opens it as an Orca tab at
    the definition line. Files outside every workspace (the Python standard library, typeshed) and files on another
    machine open in a peek view.

## Settings

**Qt Developer Tools:** Qt bin folder, Python binding (PySide6/PyQt6/PyQt5/C++), Python interpreter, format QML on save,
CMake generator and build type.

**Qt Code Intelligence:** Python interpreter, Python type checking, use project environments, basedpyright / Pyright path,
Node.js, Qt bin folder, qmlls, clangd, extra compiler globs for clangd, SSH options. Empty means "find it".

The Python interpreter is picked in VS Code's order: your choice for the project → `.vscode/settings.json` →
`pyrightconfig.json` / `pyproject.toml` → the project's venv (one directly in the project first, then the highest Python
version) → the highest installed Python.

**Type checking** is `off` by default, like VS Code's Pylance: only syntax errors and unresolved imports. Set
*Python type checking* to `basic`, `standard` or `strict` for more.

## Code on another machine (SSH)

The plugin runs on the machine that runs Orca and can only read that machine's disk. When the open file lives elsewhere
(an SSH workspace, or a machine paired through Orca, e.g. a MacBook showing a Windows PC's code), it:

1. Looks for the file read-only on every host in `~/.ssh/config`, in parallel (at most 40, key login only; Git hosts,
   `ProxyCommand` hosts and duplicate aliases are skipped; files under 64 bytes are never guessed). Nothing is installed
   while searching.
2. On the host that has the file, copies a small agent to `~/.orca-qt-lsp`, installs basedpyright there if missing and
   runs Pyright / qmlls / clangd on that machine, with its venv and build folders.
3. Remembers the host per Orca workspace, so the next open goes straight there (about 1–2 s).

The **⇄** button at the bottom left shows the current host; click it to choose *Automatic*, *This machine*, a host from
`~/.ssh/config`, or type `user@host`. Set *Find files on SSH hosts automatically* to `off` to only use hosts you pick.

Each other machine needs, once:
- Key-based SSH from the machine running Orca, with its host key accepted: `ssh -o BatchMode=yes <host> echo ok` must work.
- **Node.js ≥ 18** — found on `PATH`, Homebrew, `/usr/bin`, nvm, fnm, volta, asdf or a login shell; otherwise set
  *Remote node path*. QML and C++ need qmlls / clangd on that machine. A Windows host needs OpenSSH Server.

## Security

`trusted-worker` plugins run with your user account's access. What Qt Code Intelligence runs:

- **Language servers** from your machine: basedpyright (via Node.js), qmlls, clangd.
- **The project's Python environment.** With *Use project environments* on (the default, like VS Code), the project's
  venv and `.vscode` / `pyrightconfig` interpreter are used, and Pyright runs that `python` to read its library paths.
  Only interpreters inside a real environment (`pyvenv.cfg` or `conda-meta`) are considered, and the plugin never runs a
  project file just to read its version. Still, a project you clone controls its venv: only open projects you trust, or
  turn the setting off.
- **Compilers for clangd** only from toolchain folders (Qt, LLVM, Visual Studio, MSYS2, `/usr/bin`, Xcode…), never one
  named by a project's `compile_commands.json` elsewhere. Add more in *Extra compiler globs for clangd*.
- **SSH** to hosts in your `~/.ssh/config` with `BatchMode=yes` (never prompts), only when a file isn't on this machine.
  The search sends the file's SHA-1 and size and reads the remote disk; the agent is copied only to the host that has
  the file. Host names are validated before they reach `ssh`.
- **npm** installs `basedpyright@1.40.2` (exact version) into `%LOCALAPPDATA%\orca-qt-lsp` or `~/.local/share/orca-qt-lsp`.

Qt Developer Tools runs Qt tools (Designer, uic, rcc, qmllint, lupdate/lrelease, CMake, qmake, Python) only when you
press a button or run a command, plus `qmlformat` on save (can be turned off).

Report security issues privately through GitHub's *Report a vulnerability* on this repository.

## Development

```sh
npm install                       # typescript, @types/node, vscode-textmate (checks only, not shipped)
npx tsc -p plugins/qt-tools
orca plugin test plugins/qt-tools
orca plugin check plugins/qt-tools
orca plugin validate plugins/qt-syntax
node tools/tokenize-check.mjs plugins/qt-syntax samples/*

# Qt Code Intelligence: source in lsp-build/src, built into plugins/qt-lsp
cd lsp-build && npm ci && node build.mjs
orca plugin dev load plugins/qt-lsp
```

- **Never put anything else in `plugins/<name>/`** (`node_modules`, `.d.ts`…). Orca hashes the whole folder; extra files
  after approval stop the worker ("content hash mismatch"). Orca's typings live in `types/orca/`.
- `lsp-build/vendor/`: grammars and themes taken from VS Code; refresh with
  `node prepare-vendor.mjs "<VS Code>/resources/app/extensions"`.
- `lsp-build/dev/`: end-to-end scripts against a running Orca (`e2e-worker.ps1`, `e2e-qt.ps1`, `interp-e2e.ps1`,
  `remote-e2e.mjs`) and sample-project generators.
- `tools/normalize-syntaxes.mjs`, `tools/build-icon-theme.mjs`: see the comments in each file.

### Release

1. Change a plugin, **bump `version`** in its `orca-plugin.json`, commit.
2. `node tools/build-catalog.mjs --url https://github.com/tungvu-vms/orca-qt-pack.git --owner tungvu-vms`
3. Commit `orca-catalog.json` and push. Installed copies update themselves; a `trusted-worker` release that asks for more
   access waits for approval.

## Sources and licenses

| Component | Source | License |
| --- | --- | --- |
| qss, qrc, ui, qt-ts, qtd, qdoc, pysidedeploy grammars; Qt icons | Qt extension for VS Code (qt-labs/vscodeext) 1.16.0 | LGPL-3.0 |
| CMake, CMakeCache grammars | microsoft/vscode-cmake-tools 1.24.42 | MIT |
| pip-requirements grammar | microsoft/vscode-python 2026.10.0 | MIT |
| XML, INI, Java, C/C++ grammars, Dark+/Light+ themes | microsoft/vscode | MIT |
| MagicPython grammar | MagicStack | MIT |
| QML grammar | seanwu1105/vscode-qt-for-python (via stablyai/orca-plugins) | MIT |
| Monaco Editor, vscode-textmate, vscode-oniguruma | Microsoft | MIT (Oniguruma: BSD-2-Clause) |
| Material icons and base theme | stablyai/orca-plugins `material-icons` | MIT |
| qmake grammar, Qt Tools and Code Intelligence code, scripts | This repository | MIT |

Each plugin folder carries its license files and third-party notices. Language servers are not bundled: basedpyright
(MIT), qmlls (Qt) and clangd (LLVM) run from the user's machine.
