# Python IDE Implementation Plan

> Implement inline in this existing Orca worktree using executing-plans and TDD.

**Goal:** Make Python/PySide6 navigation and local editing usable like VS Code.
**Architecture:** Monaco providers call the existing shared LSP core through typed RPCs.
**Tech Stack:** TypeScript, Monaco 0.52.2, basedpyright, esbuild, node:test.
**Spec:** ../specs/2026-11-05-python-ide-design.md

## Global Constraints

- No version bump or catalog changes. Commit and push the source/build update for review.
- No development files in plugins/qt-lsp; generated bundles only.
- Preserve Orca document sessions, undo and read-only state.
- Frames never receive an initial file path; use the existing content-hash attachment.
- Local rename only; no partial application of cross-file edits.

## Review Focus

- Unsaved changes and edits arriving while a provider request is pending.
- UTF-8 / JSON expansion, emoji boundaries, many results and long paths.
- Cross-file references choosing the selected target rather than the last result.
- Rename edits targeting another file or including resource operations.
- Project Python paths leaking into installed-interpreter discovery.

### Task 1: Core language operations and bounded transport

**Files:** protocol.ts, core.ts, new transport.ts, dev/ide.test.mjs, dev/test.mjs.
**Produces:** lsp.references, lsp.signatureHelp, lsp.documentSymbols,
lsp.documentHighlights, lsp.prepareRename, lsp.rename (local edits only).

- [x] Write and run real basedpyright tests; observe missing handlers fail.
- [x] Add typed bounded results, server capabilities and safe local rename.
- [x] Preserve completion snippets/auto imports and bound outgoing payloads.
- [x] Verify unsaved rename, cross-file rejection, references, signatures and symbols.

### Task 2: Monaco interactions and policy regressions

**Files:** editor.ts, new ide-providers.ts, interpreters.ts, worker.ts.
**Consumes:** Task 1 RPC types and shared transport helpers.

- [x] Register providers and Monaco contributions using standard shortcuts.
- [x] Resolve reference/definition targets through one navigation map.
- [x] Reject stale rename results, retain document-session persistence and undo.
- [x] Add regressions for disabled saved environments and project paths on PATH.
- [x] Fix policy propagation and interpreter selection; verify regressions pass.

### Task 3: Build, usable verification and documentation

**Files:** package.json, dev/e2e-worker.ps1, README.md, docs/HANDOFF-qt-lsp.md.

- [x] Make E2E attachment send byte sizes and failures produce a failing exit code.
- [x] Run the complete added suite and Qt Tools tests; rebuild committed bundles.
- [x] Run Orca plugin checks, load development plugin and exercise worker RPCs.
- [x] Document shortcuts, setup for PySide6 and current rename/debug limits.
- [x] Review the final diff and report verified behavior and remaining UI checks.

Verification after the follow-up fixes: 17/17 logic/integration tests with a trusted
PySide6 interpreter; the normal and large-file browser keyboard/recovery suites;
Qt Tools 11/11;
typecheck, Orca static checks and real worker E2E passed. All 27 generated plugin
files match a repeat build. Two bundle soft warnings remain (2.20 / 1.35 MiB).
The browser tests simulate Orca's document session and enforce its JSON boundary;
the actual worker bridge is tested separately. Full desktop shortcut routing and
save/close behavior under a user's real session remain a manual check.
