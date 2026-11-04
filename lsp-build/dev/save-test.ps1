# Tests saving a file in the Python (LSP) editor on a COPY (orca plugin shot --act runs on a temp folder).
# Minimizes the Orca window during the test, then restores it.
# Usage: pwsh lsp-build/dev/save-test.ps1   (output in %TEMP%\save-test.txt, screenshot in docs/lsp-save.png)
$repo = Resolve-Path "$PSScriptRoot\..\.."
$out = "$env:TEMP\save-test.txt"
'' | Set-Content $out
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }
'@
$h = (Get-Process Orca | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1).MainWindowHandle
[W]::ShowWindow($h, 6) | Out-Null   # SW_MINIMIZE
Start-Sleep -Milliseconds 800
try {
  $act = '[{"click":[200,12]},{"key":"End"},{"key":"Enter"},{"key":"z"},{"key":"z"},{"key":"s","modifiers":["control"]}]'
  $r = orca plugin shot (Join-Path $repo 'plugins\qt-lsp') --editor (Join-Path $repo 'samples\demo-app\scratch_save.py') --theme dark --width 900 --in-place --act $act --out (Join-Path $repo 'docs\lsp-save.png') --json 2>$null | ConvertFrom-Json
  "shot ok=$($r.ok) errors=$($r.result.errors -join ' ; ') err=$($r.error.message)" | Add-Content $out
} finally {
  [W]::ShowWindow($h, 9) | Out-Null  # SW_RESTORE
}
$l = orca plugin logs local.qt-dev-python-lsp --json 2>$null | ConvertFrom-Json
foreach ($x in ($l.result.lines | Select-Object -Last 6)) { "log $($x.level): $($x.line.Substring(0, [Math]::Min(200, $x.line.Length)))" | Add-Content $out }
