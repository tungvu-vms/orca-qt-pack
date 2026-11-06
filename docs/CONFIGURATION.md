# Configuration and SSH

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

To hide all Python squiggles and diagnostic text in hovers, press **F1** inside
**Python (LSP)** and choose **Python: Toggle Diagnostics**, or turn off **Show Python
diagnostics** in the plugin's settings. This preference is saved and applies to open
Python editors immediately. Completion, type/documentation hovers and F12 keep working.

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

See [SECURITY.md](../SECURITY.md) for private reporting and trust boundaries.
