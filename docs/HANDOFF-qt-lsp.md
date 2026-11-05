# Handoff: Qt Code Intelligence (Pyright + Orca + Ctrl+Click)

State as of 2026-11-05. Repo: `github.com/tungvu-vms/orca-qt-pack` (private, prepared for public).
Read `README.md` first (install, settings, SSH, security). This file is the working memory behind it.

## What it is

`plugins/qt-lsp` = Orca plugin **Qt Code Intelligence** (`tungvu-vms.qt-dev-python-lsp`, v0.5.0).
`trusted-worker` + three custom editors (`Python (LSP)`, `QML (LSP)`, `C++ (LSP)`, `priority: option`).
Source lives in `lsp-build/src`, built into `plugins/qt-lsp` by `cd lsp-build && npm ci && node build.mjs`.

| File | Role |
| --- | --- |
| `editor.ts` | Monaco frame: TextMate grammars (vscode-textmate + oniguruma WASM inlined), Dark+/Light+, semantic tokens, hover/definition/completion providers, status bar (⇄ host button, 🐍 interpreter / ⚙ restart) |
| `worker.ts` | Orca worker entry: routes each request to the local core or to a remote agent over SSH; host auto-find; per-project host memory; `orca file open --line` for Ctrl+Click tabs |
| `core.ts` | Language core used by worker and agent: workspace scan + attach by content hash, spawns basedpyright / qmlls / clangd, LSP plumbing |
| `interpreters.ts` | VS Code-order interpreter discovery (saved → .vscode → pyrightconfig → project venv → highest global) |
| `servers.ts` | qmlls / clangd discovery, build-dir search, project roots |
| `remote.ts`, `agent.ts`, `probe-script.ts` | SSH: read-only probe on `~/.ssh/config` hosts, then copy `agent-<sha>.mjs` to `~/.orca-qt-lsp` on the host that has the file |
| `pyright-install.ts` | npm-installs `basedpyright@1.40.2` next to the node it finds |

## Hard constraints learned the hard way

- **Custom-editor frames never receive the file path** (Orca design). The worker finds the file by content:
  editor sends sha1(LF text) + UTF-8 size (LF and CRLF); worker indexes workspaces by **size only** (stat, BFS,
  skip build/venv/node_modules/Library/AppData…, stop at first hit) and hashes only same-size candidates.
- **Frame ⇄ worker messages are capped (~1 MiB request, 256 KiB post).** Never send whole files: attach by hash,
  open large files from disk, send incremental edits, chunk uploads, cap diagnostics/semantic tokens.
  `lsp.peek` sends a **line window** around the target for big stubs (PySide6 `QtCore.pyi` ≈ 570 KB).
- **Never add files to `plugins/<name>/`** (node_modules, .d.ts…): Orca content-hashes the folder → "content hash
  mismatch", worker won't start. Orca typings live in `types/orca/`.
- **The worker runs with a stripped environment**: no `LOCALAPPDATA`/`APPDATA` on Windows. Derive paths from
  `USERPROFILE`; re-add them when spawning the `orca` CLI.
- **Plugin `editor.open` only takes a workspace-relative path and no line.** Ctrl+Click into a library inside a
  workspace (project venv, build) shells out to the bundled CLI: `orca file open <abs> --line N --worktree path:<ws> --focus`.
  Files outside every workspace (stdlib/typeshed) and remote files stay in a Monaco peek.
- Do **not** register `orca.on('editor.flush')` yourself — `orca.document.session()` already flushes; doubling it
  caused "Failed to save the file".
- Pyright must be **basedpyright** (plain Pyright has no semantic tokens). Spawn it as `node langserver.index.js --stdio`
  with `ELECTRON_RUN_AS_NODE=1`, cwd = plugin dir (cwd inside the project held temp dirs busy).
- `typeCheckingMode` defaults to **off** (user request, Pylance-like).
- Monaco semantic highlighting needs `StandaloneServices.get(IConfigurationService).updateValues([['editor.semanticHighlighting',{enabled:true}]])`.

## Security posture (keep it)

From the pre-publication review (all fixed in 0.5.0):
- never execute a file from the opened project to read its version; `.vscode`/pyrightconfig interpreters must sit
  in a real env (`pyvenv.cfg`/`conda-meta`); setting *Use project environments* (off = installed Pythons only);
- clangd `--query-driver` limited to toolchain folders (+ setting `compilerGlobs`), never `**/*gcc*`;
- SSH host names validated (`isValidHost`) and passed after `--`; remote node path validated;
- auto SSH search can be turned off and never guesses from files < 64 bytes;
- `lsp.peek` only reads files returned by go-to-definition in this session;
- Qt Tools quoting doubles typographic quotes PowerShell treats as `'`.

## Test and release

- E2E against a running Orca (Windows): `lsp-build/dev/e2e-worker.ps1`, `e2e-qt.ps1`, `interp-e2e.ps1`
  (load the dev plugin first: `orca plugin dev load plugins/qt-lsp`; results in `%TEMP%\lsp-e2e*.txt`).
  Remote: `node lsp-build/dev/remote-e2e.mjs <ssh-host> '<{hash,size,sizeCrlf}>' <line> <col>`.
- Qt Tools: `orca plugin test plugins/qt-tools` (11 tests).
- Type check worker+agent: tsc with `types/orca` mapped (see how `build.mjs` bundles; `npx tsc` per tsconfig).
- Release: bump `version` in the plugin's `orca-plugin.json`, commit, then
  `node tools/build-catalog.mjs --url https://github.com/tungvu-vms/orca-qt-pack.git --owner tungvu-vms`,
  commit `orca-catalog.json`, push. Installed copies update via Settings → Plugins → ↻ → Updates.

## Open items / ideas

1. Tab-open for Ctrl+Click into files **outside** any workspace (stdlib/typeshed) is impossible with the current
   Orca plugin API — would need an Orca feature (open arbitrary path / editor.open with line).
2. Bundles `editor/assets/chunk-*.js` (2.2 MiB) and `editor.js` (1.3 MiB) exceed the 1 MiB soft warning; consider
   trimming Monaco contributions.
3. Remote files: Ctrl+Click across hosts stays in peek (Orca cannot open a tab for another host's file via plugin).
4. Lockfile is committed (`lsp-build/package-lock.json`); a CI build that checks committed bundles against source
   would close the supply-chain gap noted in the review.
5. Before going public: decide commit author email (history still shows the company address).
