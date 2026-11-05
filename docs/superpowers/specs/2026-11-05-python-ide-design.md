# Python/PySide6 editing in Orca

The user selected Python/PySide6 navigation and editing as the immediate priority.
Extend the existing Monaco editor and basedpyright bridge so everyday code exploration
and local refactoring work on unsaved text, with familiar VS Code interactions.

## Approach

Keep Monaco, the shared local/SSH core, and existing document sessions. Replacing the
editor or embedding VS Code would duplicate Orca's tabs, persistence and trust model.
Build/run remains in Qt Tools; a debugger requires a separate DAP integration.

## Behavior

- Shift+F12: references, including other project files, with previews and navigation.
- Ctrl+Shift+Space and typing `(` / `,`: signature help, active parameter and docs.
- Ctrl+Shift+O: document symbols, preserving class/method hierarchy.
- Highlight occurrences of the current symbol.
- F2: semantic rename within the current file; apply through Monaco with undo.
  Reject cross-file edits and file operations atomically with an explanatory message.
  Reject stale results when the document changes during a request.
- Preserve existing definition, hover, diagnostics, completion and theme behavior.
- Completion must preserve snippets and additional same-document edits (auto imports).

## Constraints and verification

Keep version 0.5.0. The source/build update may be committed and pushed for review;
catalog publication remains a separate release decision.
Frames still attach using content hash and byte sizes; never add development files
inside plugin folders. Only server-authorized locations can be previewed. Responses
and uploads must fit the message limits even for Vietnamese, emoji and escaped text.
Keep interpreter discovery from executing project files for version detection and
honor project-environment policy locally and when forwarding to SSH agents.

Use real basedpyright integration tests on temporary Python fixtures, focused
transport/interpreter regressions, the existing Qt Tools suite and Orca static checks.
Load the resulting development plugin and exercise the worker in the running Orca.
Static checks alone do not establish keyboard/UI behavior; report that limit explicitly.
