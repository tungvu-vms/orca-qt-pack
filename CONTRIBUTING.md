# Contributing

Use Node.js **24.19.0** (the CI version), Git and an installed Chromium browser.
Use Orca's CLI for native plugin checks. Python/PySide6, Qt and clangd are optional
for their respective integration checks; do not install them into plugin folders.

```sh
npm ci --ignore-scripts
npm --prefix lsp-build ci --ignore-scripts
npm run check
orca plugin test plugins/qt-tools
orca plugin check plugins/qt-lsp
```

`npm run check` checks source hygiene, type-checks Qt Tools and all LSP sources,
runs the real basedpyright regression suite and sample grammar checks, and verifies
the complete generated plugin file set. Tests use temporary projects and keep unsaved buffers in memory.
Set `QT_LSP_TEST_PYTHON` to a trusted Python with PySide6 to enable the optional
Qt stub test. An installed Python without PySide6 cannot pass that test.

Build source changes before browser checks:

```sh
npm --prefix lsp-build run build
npm --prefix lsp-build run test:ui
npm --prefix lsp-build run test:ui:large
npm --prefix lsp-build run test:ui:stress
npm --prefix lsp-build run test:ui:activity
npm --prefix lsp-build run test:ui:lifecycle
npm --prefix lsp-build run test:ui:textmate
```

Set `QT_LSP_BROWSER` when Edge/Chrome/Chromium is outside the standard locations.
The browser harness runs the built Monaco editor and real LSP core, simulating
only the Orca document bridge. It does not prove a physical click in Orca's window
or measure time until a native tab is visible.

Load the development plugin with `orca plugin dev load plugins/qt-lsp`. On Windows,
`pwsh -File lsp-build/dev/e2e-worker.ps1` tests the running worker; add
`-RequirePySide6` after selecting a Python that has PySide6. `e2e-qt.ps1` and
`probe-ls.mjs` are manual Qt/clangd diagnostic probes, not CI test gates.
`remote-e2e.mjs` requires an explicitly chosen SSH host and may install the agent
and basedpyright there. Do not run it against a host without authorization.

Generated bundles belong in `plugins/qt-lsp`; test output belongs in ignored
`lsp-build/dist-test` or system temporary folders. Never add dependencies, typings
or local notes to `plugins/<name>`: Orca hashes the whole folder. Keep both lockfiles
and generated bundles in the same change as source/dependency updates.

The [maintainer guide](docs/HANDOFF-qt-lsp.md) records architecture and integration
constraints. Preserve all upstream licenses and provenance when refreshing vendor
grammars or icons. [Publication preparation](docs/PUBLICATION.md) is separate from
code review; a PR does not change the catalog or make this repository public.
