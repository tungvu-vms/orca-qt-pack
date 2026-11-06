# Independently installable language plugins

Status: development implementation. The three independent folders are built and
validated from shared source. The existing catalog and frozen combined plugin
remain unchanged until a separate release decision.

## Intent and chosen approach

Users should install Python, C/C++ or QML support independently. General Python
backend and native C/C++ projects must not require Qt or expose Qt-only settings.
Qt applications compose the language plugins they need with optional Qt tools.

Two approaches were considered: rename the combined plugin to Code Intelligence,
or split the language plugins while sharing their implementation source. The
selected direction is independent installation with shared source. Renaming alone
would preserve the combined installation and settings. A separately installed
Common Core is deferred: this design does not assume cross-plugin RPC/dependency
features or introduce another required installation step.

## Proposed packages

Names and IDs below are implementation proposals; publisher remains `tungvu-vms`.

| Name | Plugin ID | Output folder | Owns |
| --- | --- | --- | --- |
| Python Code Intelligence | `python-code-intelligence` | `plugins/python-lsp` | `.py`, `.pyi`, `.pyw`; basedpyright |
| C/C++ Code Intelligence | `cpp-code-intelligence` | `plugins/cpp-lsp` | C/C++ source and header extensions; clangd |
| QML Code Intelligence | `qml-code-intelligence` | `plugins/qml-lsp` | `.qml`; qmlls |

Qt Tools, Qt Syntax and Icons retain their IDs and remain optional. The repository
URL remains unchanged so existing links continue working. Propose a neutral catalog
display name, **Developer Tools for Orca**, when the new packages are released.
No package needs any of the other language packages to provide its editor.

Examples: a FastAPI project installs Python only; a non-Qt native library installs
C/C++ only; a Qt Quick C++ application installs C/C++, QML and optionally Qt Tools;
a PySide6/QML application installs Python, QML and optionally Qt Tools.

## Shared source, independent execution

Keep a single source implementation for Monaco providers, document sessions,
transport budgets, cancellation, navigation/peek, cache lifecycle and SSH transport.
Build three self-contained plugin folders. Runtime imports must stay inside their
own folder; no sibling assets, shared writable files or required Common plugin.

Separate language adapters own server discovery, command-line construction,
initialization/configuration and language-specific dependency installation.
The worker and remote agent accept only their configured language, including
requests supplied directly to handlers, not just requests from their editor page.
Reject unsupported languages before scanning roots, creating agents or spawning
servers. A preview from another language may show plain text; it must not start
another language's server or fetch another plugin's grammar.

Each build registers one editor and includes only its language configuration and
grammar family. QML includes its embedded JavaScript grammar; C/C++ includes C and
macro grammars; Python includes MagicPython/RegExp. Common Monaco/WASM assets can
be duplicated between packages because Orca loads isolated plugin folders. Record
sizes for each package and their combined installation; do not claim a total RAM
reduction from splitting alone. A language server is reused per project within
its plugin, not shared across independent plugin workers.

Do not make three copies of the TypeScript source. Extend the build/parity checks
to cover the complete outputs of all new folders, and leave unrelated plugin
files intact. Preserve license notices for every component each package ships.

## Per-language configuration

Python retains interpreter selection, project-environment policy, type-checking
mode, diagnostic toggle, basedpyright path and local Node path. It supports normal
Python projects and environments without PySide6. PySide6/PyQt support comes from
the selected environment's stubs, with no special Qt dependency or setup prompt.

C/C++ retains the configured clangd path and compiler-driver allowlist. Prefer
an explicitly configured server, then PATH, then known installation fallbacks;
Qt Creator is a fallback, not a requirement. Support `compile_commands.json`,
`.clangd` and `compile_flags.txt`; offer an optional compilation-database folder
for build systems/layouts outside current CMake-style discovery. Resolve relative
database paths against the project root. Honor an explicit missing/invalid path
with a clear error rather than silently choosing another database. Never run
project configure/build scripts during discovery. Compiler execution remains
restricted to trusted toolchain paths/user-configured allowlists.

QML retains Qt bin and qmlls settings, with Qt kit/import/build configuration.
QML-specific controls and missing-Qt messages appear only in this plugin.
Qt Designer, uic/rcc, translations and build commands remain in Qt Tools.

All language plugins expose the necessary SSH/host controls independently.
Automatic host discovery and interpreter-execution defaults retain current
behavior for this change; changing those policies is a separate decision.
Do not add formatters, linters, debugging or package-manager management as part
of this split.

## State and compatibility

Orca settings/storage are plugin-scoped. Do not read another plugin's private
storage from disk, add broad permissions or promise automatic migration.
Document the corresponding old/new settings and ask existing users to reselect
their interpreter, host and executable paths once. New defaults work without
Qt for Python/C++. Existing document sessions must remain the sole save owner.

Namespace remote agent state by plugin ID; include language identity in the
agent handshake and validate it on both ends. Agent source hashes distinguish
uploaded executables. Two language plugins connected to the same SSH host must
not overwrite each other's interpreter choices, roots or state file. Share the
existing machine-level basedpyright installation only where already supported;
separate installation state from language-plugin session/preferences state.

Keep `plugins/qt-lsp` as a frozen legacy combined build during development. Do
not remove users' installed plugin, automatically disable it or switch away
from an unsaved editor. Test new packages with the legacy plugin disabled.
The migration guide requires disabling the old combined plugin before enabling
the replacement editors, avoiding duplicate extension ownership/default views.
Activating all three new plugins together must register each extension once.

No version bump, catalog edits, visibility changes, force push or release occurs
while implementing and testing the development split. New manifests may use an
initial development version `0.1.0`; they are not catalog releases. Preserve the
existing historical catalog entries and pins. The release decision will choose
how to label/retire the legacy listing and publish the new entries; the catalog
generator must not silently repin the legacy release to a newer unchanged version.

## Acceptance and validation

- Each package validates and loads alone; its manifest contains one language's
  editor/settings and needs no peer language plugin.
- Python tests use a non-Qt project without PySide6. References, completion,
  unsaved edits and local rename work; no Qt/clangd/qmlls process is started.
- C/C++ tests use a non-Qt executable/library with real clangd and a compilation
  database. Headers, definitions and hover work without Qt or a Python interpreter;
  cover an explicitly selected external database folder and invalid paths.
- QML tests use a minimal Qt Quick project and qmlls; Qt imports, definitions and
  diagnostics work without requiring a Python environment.
- Unsupported-language requests, including forwarded SSH requests, fail without
  starting unrelated servers. Same-host agent state remains independent.
- The three new packages coexist without duplicate editor ownership or language
  server startups. Legacy coexistence is documented and checked during migration.
- Preserve the existing normal/large-file, Unicode/chunking, stale-response,
  cancellation, restart-recovery, references/rename and preview-memory regressions.
  Add language-specific browser/worker checks and retain native-host limitations
  when reporting results.
- Record build bytes, installed files, cold/warm lookup times and retained heap
  for one package and all three. Compare with the combined baseline; structural
  isolation is required even if all-three installation uses more disk or RAM.

## Implementation sequence

1. Introduce tested language adapters and request/state isolation in shared source.
2. Build and validate the three independent manifests/assets/workers/agents.
3. Exercise Python, non-Qt C/C++ and QML independently, then together, including SSH
   isolation through local test fixtures (no unrequested connections to real hosts).
4. Update documentation, migration mapping and CI; rebuild and review generated
   parity/size results. Keep releases and catalog publication as a separate step.
