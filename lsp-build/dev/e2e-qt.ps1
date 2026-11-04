# Tests the real LSP worker in Orca for QML (qmlls) and C++ (clangd) on samples/qt-quick-app.
# Usage: pwsh lsp-build/dev/e2e-qt.ps1   (plugin loaded with `orca plugin dev`; run make-qt-sample.ps1 first; output in %TEMP%\lsp-e2e-qt.txt)
$repo = Resolve-Path "$PSScriptRoot\..\.."
$key = 'local.qt-dev-python-lsp'
$root = Join-Path $repo 'samples\qt-quick-app'
$out = "$env:TEMP\lsp-e2e-qt.txt"
'' | Set-Content $out
function Req($name, $obj, $t = 90000) {
  $j = $obj | ConvertTo-Json -Compress -Depth 6
  $r = orca plugin dev request $key $name --data $j --timeout-ms $t --json 2>$null | ConvertFrom-Json
  if ($r.ok) { return $r.result.result } else { "ERR $name : $($r.error.message)" | Add-Content $out; return $null }
}
orca repo add --path $root --kind folder --json 2>$null | Out-Null
$cases = @(
  @{ lang = 'qml'; file = 'Main.qml'; probes = @(@{ w = 'ApplicationWindow'; l = 3 }, @{ w = 'CounterButton'; l = 10 }, @{ w = 'counter.clicks'; l = 14 }, @{ w = 'label'; l = 14 }) },
  @{ lang = 'cpp'; file = 'main.cpp'; probes = @(@{ w = 'Backend'; l = 7 }, @{ w = 'increment'; l = 8 }, @{ w = 'QGuiApplication'; l = 6 }, @{ w = 'backend.h'; l = 2 }) },
  @{ lang = 'cpp'; file = 'backend.cpp'; probes = @(@{ w = 'increment'; l = 6 }, @{ w = 'm_count'; l = 8 }, @{ w = 'countChanged'; l = 9 }, @{ w = 'QStringLiteral'; l = 12 }) }
)
foreach ($c in $cases) {
  $p = Join-Path $root $c.file
  $text = [IO.File]::ReadAllText($p)
  $a = Req 'lsp.attach' @{ language = $c.lang; hash = (-join ([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text.Replace("`r`n","`n"))) | % { $_.ToString('x2') })) }
  "== $($c.file) [$($c.lang)] attach ok=$($a.ok) server=$($a.server) root=$($a.workspace) $($a.message)" | Add-Content $out
  if (-not $a.ok) { continue }
  Req 'lsp.open' @{ path = $p; text = $text; version = 1 } | Out-Null
  Start-Sleep 4
  $lines = $text -split "`n"
  foreach ($pr in $c.probes) {
    $col = $lines[$pr.l].IndexOf($pr.w); if ($pr.w -like '*.*') { $col = $col + $pr.w.IndexOf('.') + 1 }
    $pos = @{ line = $pr.l; character = [Math]::Max(0, $col + 1) }
    $d = Req 'lsp.definition' @{ path = $p; position = $pos }
    $h = Req 'lsp.hover' @{ path = $p; position = $pos }
    $locs = (@($d.locations) | ? { $_.path } | % { "$((Split-Path (Split-Path $_.path) -Leaf))/$((Split-Path $_.path -Leaf)):$($_.range.start.line + 1) ws=$($_.inWorkspace)" }) -join ' | '
    $hv = [string]((([string]$h.markdown) -replace '```\w*', '' -split "`n") | ? { $_.Trim() } | Select-Object -First 1)
    "  {0,-16} def=[{1}] hover=[{2}]" -f $pr.w, $locs, ($hv -replace '\s+', ' ').Trim() | Add-Content $out
  }
  $s = Req 'lsp.semanticTokens' @{ path = $p }
  $dg = Req 'lsp.diagnostics' @{ path = $p }
  "  semantic=$(@($s.data).Count / 5) tokens; diagnostics=$(@($dg.items).Count) $((@($dg.items) | Select-Object -First 2 | % { "L$($_.range.start.line+1): $($_.message)" }) -join ' || ')" | Add-Content $out
}
$cp = Join-Path $root 'main.cpp'
$comp = Req 'lsp.completion' @{ path = $cp; position = @{ line = 8; character = 12 }; trigger = '.' }
"completion backend. : $(@($comp.items).Count) items; $((@($comp.items) | Select-Object -First 6 | % label) -join ', ')" | Add-Content $out
