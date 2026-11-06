# Editor performance implementation plan

User approved sequential implementation and careful verification after reviewing
resource use. Keep Orca document sessions, source content, navigation and isolated
frames intact. Keep catalog/version changes separate. Execute in the existing
worktree and update PR #1 after verification.

1. Measure a repeatable baseline in the built browser editor: initial attach,
   visible/hidden RPC counts, editor heap after repeated navigation and close.
   Avoid attributing whole-app RAM to the plugin.
2. Add activity tracking using page visibility and viewport intersection. Defer
   grammar/LSP startup until visible; retain unsaved sessions; queue hidden edits;
   suppress hidden providers/semantic refresh and apply latest state on resume.
   Verify real parent-frame CSS hiding, rapid hide/show, and unsaved replacement.
3. Move heavy work away from the UI. Configure basedpyright's supported
   file-cancellation/background-analysis path with scoped cleanup; preserve stdio
   cancellation for other servers. Then move TextMate/Oniguruma grammar evaluation
   into a dedicated worker with bounded cached line results in the frame, stale
   response rejection, disposal and failure fallback. Keep Python/QML/C++ colors.
4. Run source/type checks, real language-server tests, keyboard/large-file tests,
   sustained navigation and repeated multi-page open/close. Measure latency/heap
   separately. Validate and load the dev plugin; report native-host limits honestly.

Tests are written and observed failing before implementation. Save compact measured
results and decisions below rather than repeatedly re-running unchanged suites.

## Progress

- Baseline: existing retained-preview checks ~4–6 MiB after 80 targets. Whole Orca
  snapshot from the prior turn ~1.85 GiB with no language servers running; that is
  not a per-plugin memory measurement.
- Inspection: TextMate currently evaluates synchronously with a 500 ms per-line
  allowance. basedpyright is still launched with --stdio alone. New background
  paths must be verified independently before claims of resource improvement.

## Completed 2026-11-06

- Hidden startup regression observed before implementation: two attach/open RPCs;
  now zero. Hidden changes/diagnostics produce no new RPCs. After 30 seconds the
  grammar worker terminates; showing the frame recreates it and syncs its draft.
  Initial hidden replacements use the original attachment snapshot, avoiding a
  hash lookup against an unsaved draft. Five rapid hide/show cycles retain one
  attachment. Monaco/model allocation still happens before the visibility wait.
- Python enables the exact basedpyright file-cancellation ABI. Abort and timeout
  markers remain until the server responds, then are removed; exit/spawn failure
  removes only this client's unique temp folder. A CPU-bound fixture observes
  cancellation without reading stdin. Real basedpyright logs `BG: Background
  analysis(1) started`. Other language servers keep stdio cancellation.
- TextMate/Oniguruma moved into one dedicated worker per active frame. Grammar
  imports remain lazy. Monaco's pinned internal background-tokenization store
  receives revisioned batches; synchronous requests use a cheap cache bounded
  to 2000 entries / approximately 4 MiB per language. Edits reuse the unchanged
  prefix; stale revisions and disposed models discard responses. Closing the
  last model releases its worker. Failures restore Python/C++ built-in tokenizers
  and a subsequent install can retry. QML has no built-in grammar fallback.
- Review caught and verified fixes for hidden initial drafts, multiline state
  across overlong lines, and explicit restoration of overwritten tokenizers.
  Cold regex compilation sometimes exhausted a 10 ms limit; use a 50 ms worker
  allowance and one 200 ms retry, never cache incomplete states. Lines over
  20000 UTF-16 units skip grammar evaluation and retain incoming state; syntax
  coloring on these exceptional lines is approximate. Regex time limits are
  cooperative, not a hard wall-clock ceiling; the frame remains separate.
- Validation: TypeScript; 21/21 tests including real PySide6; normal/large editor
  keyboard suites; 80 previews in one large target (~4 MiB retained) and 80
  different large targets (~7 MiB, flat at 20/40/60/80). All passed.
- Thirty 2400-line model/editor open-close cycles: approximately 1.0 MiB retained
  frame heap after GC, zero remaining grammar workers. Thirty actual built-editor
  iframe open-close cycles: approximately 0.05 MiB retained parent heap after GC.
  These are bounded regression checks, not a full-app hours-long soak test.
- Native Orca editor check passed, Qt Tools 11/11 passed, worker E2E passed with
  PySide6 explicitly selected temporarily; the sample's original global selection
  was restored. Its first PySide6 assertion failed under that global interpreter
  because PySide6 is absent there. No source/project configuration files changed.
- Native worker command includes --cancellationReceive=file:orca-*. Temporary
  diagnostics confirmed the grammar worker returned comment tokens and native DOM
  had mtk9 / rgb(106,153,85); the diagnostics were removed before final build.
- Real VMS.py / SettingScreenQSettings: all five browser Ctrl-click locations
  resolved to src/utils/setting_screen_qsetting.py:10. First two callbacks took
  3048/2943 ms, later callbacks 104/92/92 ms. This measures reveal callback latency,
  not native tab-visible latency or the user's physical click. CLI worker round
  trips (including CLI overhead) were 421–635 ms warm definition, ~450 ms hover.
  VMS.py SHA-256 remained 1C79122F3A7EC7527E968B4D801E32DAC6CC426824DAD1CC67840BD50F3969E3.
- Bundle parity: 29 files / 5.3 MiB; editor.js soft warning removed after moving
  WASM out of the frame. The 2.20 MiB shared Monaco chunk warning remains.
- Ruling: keep Python background analysis enabled for responsiveness and
  cancellation, without claiming reduced server RAM. Worker model mirrors also
  use memory; total Orca RAM/CPU improvement requires a comparable full-app trace.
  Preserve existing catalog/version 0.5.0; update development PR #1 only.
- Windows CI exposed `write EPIPE` during server shutdown. A real subprocess
  regression reproduced the uncaught error before the fix. Stdin errors now
  reject pending requests and stop the child; explicit kill immediately blocks
  subsequent requests, notifications and late success/error replies. Cancellation
  folders and exit callbacks still wait for child exit. Four regressions cover
  the broken pipe, stream failure and both late-reply outcomes; test cleanup also
  kills fixture children on timeout.
- Shutdown-fix validation: 25/25 integration/logic tests with real PySide6,
  typecheck, byte parity of all 29 generated files, plugin check, native worker
  E2E with PySide6 and normal/large/stress/activity/lifecycle/TextMate browser
  suites passed. The 80-preview checks retained approximately 5 MiB for one
  target and 7 MiB for different targets. Thirty editor/model cycles retained
  1.1 MiB with zero grammar workers; thirty iframe cycles retained 0.08 MiB in
  the parent. No fixture server processes remained after tests.
