# Handoff: Qt Code Intelligence (Pyright + Orca + Ctrl+Click)

State as of 2026-11-05. Repo: `github.com/tungvu-vms/orca-qt-pack` (private, prepared for public).
Read `README.md` first (install, settings, SSH, security). This file is the working memory behind it.

## Development changes after the initial review (not published)

- Python/PySide6 priority: references (Shift+F12), signature help, document symbols
  (Ctrl+Shift+O), line navigation (Ctrl+G), semantic occurrences and local-only F2 rename.
  `ide-providers.ts` registers Monaco providers; `protocol.ts` defines their contracts.
- Rename returns edits to Monaco, never writes files. Reject cross-file changes/file
  operations atomically; check LSP version and Monaco revision before applying.
- References/definitions share a URI-to-target navigation map. Register
  `standaloneReferenceSearch.js`: importing referencesController alone does not enable peek.
- Monaco 0.52.2 leaves Delayer rejections unobserved when closing references peek.
  `build.mjs` applies an explicit two-call cancellation patch with Monaco's own error
  handler; it fails if the upstream source changes. No node_modules edits are required.
- JSON byte budgets and surrogate-safe uploads live in `transport.ts`. Diagnostics,
  new results, completion, semantic tokens and peek are bounded. Responses are converted
  to pure JSON at the core boundary: Orca rejects properties whose value is undefined.
- Disabled project environments also filter saved and PATH project interpreters;
  workspace paths are excluded before version probes. SSH receives project-environment
  and type-checking policy (host-specific executable paths are not forwarded).
- Tests: `cd lsp-build; npm test; npm run typecheck; npm run test:ui; npm run check:build`.
  Optional `QT_LSP_TEST_PYTHON` enables real PySide6 integration; `QT_LSP_BROWSER` selects
  a browser. CI covers source checks and complete generated bundle parity.
- Version remains 0.5.0. These changes are development-only; catalog publication needs
  a release decision. Python formatting/Quick Fix, workspace rename and DAP debugging
  remain separate follow-up work.
- Review regressions now cover read-only peek editors, discarded buffers, actual
  byte-window coverage in large targets, refreshed previews, stale rename results,
  pending keystrokes during resync, and serialized SSH policy reloads. A full snapshot
  consumes queued edits that are already incorporated, preventing duplicate text.
- Quiet Python diagnostics: basedpyright 1.40 requests the root `basedpyright`
  configuration section and then reads `.analysis`; answering only `.analysis`
  sections silently left the server at `recommended`. Root sections now receive
  nested analysis options. In `off`, surface syntax and missing imports only.
  Boolean `pythonDiagnostics` controls all Python markers/diagnostic hover text;
  F1 → Python: Toggle Diagnostics persists it, synchronizes open frames and leaves
  completion/navigation enabled. The toggle does not restart SSH agents.
- Large-file regression: a user's 2381-line / 138537-byte file exposed that the old
  700k request budget used the result limit by mistake. Inputs now budget 48k bytes;
  uploads use <=36k serialized-byte pieces, with surrogate boundaries preserved.
  Initial large opens read disk. Initial/restart full syncs run on the incremental
  edit queue; keystrokes arriving during initialization or upload are preserved.
  Navigation retries `rate_limited` according to retryAfterMs within its deadline.
  Run `npm run test:ui:large`; the harness enforces 64 KiB with structured-clone accounting.
- Latency regression: concurrent initialization previously spawned six basedpyright
  processes for the same VMS root, each scanning the workspace. `starting` shares one
  in-flight startup per language/root; stopping a server invalidates its pending entry.
  Python indexing defaults exclude build/dist/out, environments and `.worktrees`.
  Hover/definition use request IDs and LSP cancellation when Monaco cancels; canceled
  requests also stop retrying admission. Semantic refresh is scoped/debounced per file.
  `dev/perf-worker.ps1 -Path <file> -Words @('symbol')` measures real worker round trips
  including CLI overhead. Browser real-file mode uses QT_LSP_UI_FILE, QT_LSP_UI_ROOT,
  QT_LSP_UI_SYMBOL and QT_LSP_TEST_PYTHON, reading source without writing it. Its Ctrl+Click
  metric ends at the reveal callback, before actual Orca tab opening. On the VMS file,
  measured first cold click ~7.5 s, subsequent clicks ~95 ms; do not claim instant cold startup.
- Sustained-navigation regression: per-target-line Monaco model URIs retained a
  fresh copy of a large preview at each Ctrl-hover, growing from ~9 to ~28 MiB
  after 20 to 80 targets even after GC. Preview URIs now identify actual returned
  windows/full files. LRU bounds idle models to six / 4 MiB text storage, with live
  model references pinned and evicted targets rehydrated through the resolver.
  Stress checks retained ~4 MiB for 80 symbols in one large file and ~5 MiB across
  80 large target files. These are isolated editor heap measurements, not proof
  that every cause of whole-app lag is fixed. `npm run test:ui:stress` guards both.
  `monaco-workarounds.mjs` also releases a model reference that arrives after a
  reference group was closed, and duplicates from concurrent group resolution.
  The resolver pins models before asynchronous acquisition to prevent eviction races.
- Idle-worker navigation recovery: document-read RPCs now carry the editor revision.
  A fresh/restarted worker requests resync instead of answering against disk at draft
  coordinates. The frame coalesces recovery on the edit queue, reuploads the unsaved
  draft and retries once. No disk save is performed. Browser regression replaces the
  source with an unsaved class import/call, restarts the real core and verifies that
  Ctrl+Click still opens its definition. A real-file mode can check every occurrence
  using QT_LSP_UI_ALL_POSITIONS=1 (used for SettingScreenQSettings in VMS.py).
- Explicit Ctrl/Cmd-click now records the modifier at mouse-down and performs the
  navigation on a short, unmodified-in-content mouse-up even if Ctrl was released
  first. Monaco's native gesture discarded this case. The capture handler owns the
  click to avoid duplicate native navigation, clears state after outside release,
  blur/cancellation/new press, and cancels lookup after content edits. Workspace
  clicks open through reveal directly, without waiting for a hover preview; F12
  and library/remote peek remain available. Only explicit clicks/reveals emit
  `[navigation]` logs so missing input vs lookup vs tab opening can be distinguished.
  Regressions cover early Ctrl release, blocked preview and stale outside presses.

## Research follow-up: VS Code responsiveness (not implemented)

The public VS Code/basedpyright client differs from the current plugin in several
ways that should be measured before adding a custom project-wide index:

1. **File-based cancellation and background analysis.** In basedpyright 1.40.2,
   `server.ts:createBackgroundAnalysis` returns no background analyzer unless
   `getCancellationFolderName()` is configured. The VS Code client passes
   `--cancellationReceive=file:<unique-folder>` and writes per-request cancellation
   files. This lets running synchronous analysis observe cancellation without
   waiting to read a JSON-RPC notification. The plugin still launches with only
   `--stdio`; its current `$/cancelRequest` support does not enable this worker.
   Implement cancellation-file lifecycle on the language-server machine, including
   SSH agents, then measure foreground responsiveness and memory before claiming a gain.
2. **Incremental synchronization.** Editor-to-worker changes are incremental, but
   worker-to-server `sendFull` still sends full document text. Consider LSP range
   edits with CRLF/UTF-16 tests and full resync only for recovery.
3. **Definition request reuse and preview loading.** Share matching in-flight
   queries; any result cache must invalidate on relevant source/dependency changes.
   `resolveLocations` currently waits for `lsp.peek` before opening a target. Separate
   location lookup, preview loading and actual Orca CLI tab-open timings.
4. **Indexing scope.** Pylance's symbol index mainly supports auto-imports and
   workspace symbol search. Semantic navigation also needs the analyzer's import
   graph and type results. Pylance documents a default limit of 2000 user *files*,
   not lines, and persisted indices for third-party libraries, not user-file indices.
   These Pylance-specific settings are not automatically supported by basedpyright.

Use a representative cold/warm benchmark on the real VMS project. Record P50/P95
for lookup, preview and tab-visible separately, including edits and dependency
changes. A warm lookup P95 below 200 ms is a proposed target, not a measured guarantee.

Primary sources checked:
- [basedpyright 1.40.2 server background gate](https://github.com/DetachHead/basedpyright/blob/v1.40.2/packages/pyright-internal/src/server.ts#L33)
- [basedpyright VS Code cancellation strategy](https://github.com/DetachHead/basedpyright/blob/v1.40.2/packages/vscode-pyright/src/cancellationUtils.ts#L69)
- [VS Code definition-link behavior](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.ts)
- [Pyright analyzer architecture](https://github.com/microsoft/pyright/blob/main/docs/internals.md)
- [Pylance indexing](https://github.com/microsoft/pylance-release/blob/main/docs/settings/python_analysis_indexing.md)
- [Pylance index persistence](https://github.com/microsoft/pylance-release/blob/main/docs/settings/python_analysis_persistAllIndices.md)

### Reusable VS Code components and embedding options

The current plugin already embeds Monaco (the editor extracted from VS Code),
vscode-textmate and vscode-oniguruma. Adding a full VS Code workbench is a different
integration project; it is not an established performance fix for this plugin.

| Component | Useful role here | Integration limits / performance evidence |
| --- | --- | --- |
| [Microsoft Monaco](https://github.com/microsoft/monaco-editor) | Existing editor, providers, undo, peek and editor workers | Only its public API is versioned; private services need pinned compatibility. Monaco does not directly run arbitrary VS Code extensions. |
| [Microsoft vscode-jsonrpc / language-server-protocol](https://github.com/microsoft/vscode-languageserver-node) | Replace hand-written stdio framing/request bookkeeping with a maintained transport/protocol implementation | vscode-jsonrpc is standalone. The full vscode-languageclient targets the VS Code extension environment; an Orca adapter is still needed. No automatic analyzer speedup should be claimed. |
| [CodinGame monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api) | Selective VS Code model/files/configuration/TextMate services; model references dispose when unused | Requires virtual filesystem and host adaptation. Keep Orca's document sessions as the persistence owner; do not add a competing save path. More services/extension hosts may increase startup and memory; benchmark a small spike first. |
| [TypeFox monaco-languageclient](https://github.com/TypeFox/monaco-languageclient) | Established Monaco-to-language-server integration and examples | Current documented stack aligns with Monaco 0.57.0, while this plugin uses 0.52.2. Migration requires a compatibility upgrade and adaptation to Orca's framed bridge, not a drop-in import. |
| [TextMate worker service](https://github.com/CodinGame/monaco-vscode-api/wiki/Getting-started-guide) | Move heavy grammar work away from the UI thread | Current textmate.ts calls tokenizeLine synchronously in the frame. Its existing editor.worker does not offload that custom tokenizer. Profile typing before/after; worker messaging and model mirrors also have costs. |

Prioritize a measured file-cancellation/background-analysis prototype and UI-thread
tokenization profiling, then transport/model-service migration where it removes
custom lifecycle logic. Shared editor/model services across Orca's separate isolated
file frames require host support; placing another full runtime in each frame does
not create sharing automatically.

Keep language-specific engines: [clangd](https://clangd.llvm.org/design/indexing)
already has dynamic/background indices and persistent .idx shards driven by
compile_commands.json. [qmlls](https://doc.qt.io/qt-6/qtqml-tooling-qmlls.html) needs
the right Qt kit, import/build paths and generated type information. A generic
VS Code UI does not replace these engines or their project configuration.

The development manifest now uses `priority: default` for all three LSP editors,
as requested. Existing tabs/preferences can retain their chosen view; Source is
still available. The published main catalog remains a separate release.

## What it is

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

## Hard constraints learned the hard way

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
4. Lockfile and CI bundle checks are present in the development checkout; run the workflow after publishing the branch.
5. Before going public: decide commit author email (history still shows the company address).
