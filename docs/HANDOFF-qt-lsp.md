# Qt Code Intelligence: maintainer guide

The catalog release is **0.5.0**. Development features described in [README](../README.md)
are on the development branch and need a separate versioned catalog release.
See [CONTRIBUTING](../CONTRIBUTING.md) for repeatable builds and checks, and
[public preparation](PUBLICATION.md) before changing repository visibility.

## Architecture

`plugins/qt-lsp` = Orca plugin **Qt Code Intelligence** (`tungvu-vms.qt-dev-python-lsp`, v0.5.0).
`trusted-worker` + three custom editors (`Python (LSP)`, `QML (LSP)`, `C++ (LSP)`, `priority: default`).
The development editors now open supported Python/QML/C/C++ files by default; Source remains selectable.
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

## Integration constraints

- **Custom-editor frames never receive the file path** (Orca design). The worker finds the file by content:
  editor sends sha1(LF text) + UTF-8 size (LF and CRLF); worker indexes workspaces by **size only** (stat, BFS,
  skip build/venv/node_modules/Library/AppData…, stop at first hit) and hashes only same-size candidates.
- **Frame inputs are capped at 64 KiB; worker results at 1 MiB; posts at 256 KiB.** The installed Orca's
  `plugin-frame-bridge` confirms the input cap and a shared 120 requests / 10 seconds budget.
  Account for structured-clone costs (8 bytes per number, array/object overhead), not JSON alone.
  Never send whole files: attach by hash,
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
- LSP stdin errors close the client and stop its child without crashing the plugin worker. Explicit kill rejects pending requests immediately and blocks late replies; cancellation-folder cleanup and `onExit` follow the actual child exit.
- Monaco semantic highlighting needs `StandaloneServices.get(IConfigurationService).updateValues([['editor.semanticHighlighting',{enabled:true}]])`.

## Security posture (keep it)

Maintain these controls in both local and SSH execution:
- never execute a file from the opened project to read its version; `.vscode`/pyrightconfig interpreters must sit
  in a real env (`pyvenv.cfg`/`conda-meta`); setting *Use project environments* (off = installed Pythons only);
- clangd `--query-driver` limited to toolchain folders (+ setting `compilerGlobs`), never `**/*gcc*`;
- SSH host names validated (`isValidHost`) and passed after `--`; remote node path validated;
- auto SSH search can be turned off and never guesses from files < 64 bytes;
- `lsp.peek` only reads files returned by go-to-definition in this session;
- Qt Tools quoting doubles typographic quotes that PowerShell treats as `'`.

## Test and release

- E2E against a running Orca (Windows): `lsp-build/dev/e2e-worker.ps1` and `e2e-qt.ps1`
  (load the dev plugin first: `orca plugin dev load plugins/qt-lsp`; results in `%TEMP%\lsp-e2e*.txt`).
  Remote: `node lsp-build/dev/remote-e2e.mjs <ssh-host> '<{hash,size,sizeCrlf}>' <line> <col>`.
- Qt Tools: `orca plugin test plugins/qt-tools` (11 tests).
- Type check worker+agent: tsc with `types/orca` mapped (see how `build.mjs` bundles; `npx tsc` per tsconfig).
- Release: bump `version` in the plugin's `orca-plugin.json`, commit, then
  `node tools/build-catalog.mjs --url https://github.com/tungvu-vms/orca-qt-pack.git --owner tungvu-vms`,
  commit `orca-catalog.json`, push. Installed copies update via Settings → Plugins → ↻ → Updates.


## Editor lifecycle and navigation

`editor-activity.ts` combines document visibility and viewport intersection, including
CSS-hidden parent frames. Monaco and the document model exist before first activation;
grammar/LSP startup waits until visible. Hidden editors coalesce draft changes and
pause new reads, diagnostics rendering and semantic refresh. Resume synchronizes the
latest draft without a disk save. Retain the initial document snapshot for hash
attachment if the hidden draft changes before activation.

`textmate.worker.ts` evaluates TextMate/Oniguruma away from the UI thread. The pinned
Monaco 0.52.2 background-tokenization bridge rejects stale revisions, batches updates,
and bounds the frame cache to 2000 entries / approximately 4 MiB per language. Grammar
imports are lazy. Workers stop after 30 seconds hidden or when the last model closes.
Failures restore built-in Python/C++ tokenizers and permit retry; QML has no built-in
fallback. Cooperative regex budgets are 50 ms plus one 200 ms retry; incomplete states
are discarded. Lines over 20000 UTF-16 units receive approximate coloring while retaining
the incoming multiline state. These limits do not provide a hard regex time ceiling.

Python's `--cancellationReceive=file:orca-<unique>` argument enables basedpyright's
background analyzer. The shared client writes per-request cancellation markers on abort
and timeout; late responses remove them. Only the owning temporary folder is removed
after process exit. Other language servers use ordinary JSON-RPC cancellation.

Ctrl/Cmd-click captures the modifier at mouse-down and opens workspace definitions
without waiting for a hover preview. If the only definition contains the clicked
position in the current file, use Monaco's Peek References action. Shift+F12 remains
available. References are limited to files known to the language server; project ignores
can exclude files. Idle-worker recovery resynchronizes the unsaved revision before lookup.

Preview models reuse actual returned windows, with live references pinned and an idle
LRU capped at six models / 4 MiB text. A result arriving after disposal must release its
reference. `monaco-workarounds.mjs` checks and patches known upstream lifecycle defects;
revalidate the patch and private service APIs before upgrading Monaco.

## Measurements and limitations

Repeatable browser checks exercise 2400-line files, 80 previews in one target and across
80 large files, 30 editor/model cycles, and 30 iframe cycles. Representative local runs
retained roughly 4–7 MiB after preview stress, ~1 MiB after model cycles, and less than
0.1 MiB in the parent after iframe cycles, following GC. Closed editors left no grammar
workers. These are isolated regression measurements, not total Orca memory or an
hours-long soak test. Background analysis and model mirrors can consume additional RAM.
Cold project lookups can take several seconds; warm definition callbacks in one large
project measured ~0.1 seconds. Callback timing excludes native tab display latency.

## Further work

- Opening files outside every workspace or on another host remains a peek until Orca
  offers a suitable tab-open API.
- The shared Monaco chunk is approximately 2.20 MiB and exceeds the 1 MiB soft warning.
  Profile contributions before trimming; keep navigation, completion and peek covered.
- Editor-to-worker changes are incremental; worker-to-language-server synchronization
  still sends full text. Range edits need CRLF/UTF-16 regression coverage.
- Workspace rename, formatting/Quick Fix and debugger support are separate features.

## Primary references

- [basedpyright background analyzer gate](https://github.com/DetachHead/basedpyright/blob/v1.40.2/packages/pyright-internal/src/server.ts)
- [basedpyright file cancellation](https://github.com/DetachHead/basedpyright/blob/v1.40.2/packages/vscode-pyright/src/cancellationUtils.ts)
- [VS Code definition navigation](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/gotoSymbol/browser/goToCommands.ts)
- [Pyright analyzer design](https://github.com/microsoft/pyright/blob/main/docs/internals.md)
- [clangd indexing](https://clangd.llvm.org/design/indexing)
- [Qt QML language server](https://doc.qt.io/qt-6/qtqml-tooling-qmlls.html)

The plugin already uses Monaco, vscode-textmate and vscode-oniguruma. A full VS Code
workbench or additional extension hosts do not automatically improve resource use.
Compare selective services or transport migrations against the current architecture,
keeping Orca document sessions as the sole persistence owner.
