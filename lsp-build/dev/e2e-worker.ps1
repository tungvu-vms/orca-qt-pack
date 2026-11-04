# Test worker LSP that trong Orca: open -> definition/hover/completion/diagnostics tren samples/demo-app/main.py
$ErrorActionPreference = 'Continue'
$key = 'local.qt-dev-python-lsp'
$path = '<repo>\samples\demo-app\main.py'
$out = "$env:TEMP\lsp-e2e.txt"
'' | Set-Content $out
function Req($name, $obj) {
  $j = $obj | ConvertTo-Json -Compress -Depth 6
  $r = orca plugin dev request $key $name --data $j --timeout-ms 60000 --json 2>$null | ConvertFrom-Json
  if ($r.ok) { return $r.result.result } else { "ERR $name : $($r.error.message)" | Add-Content $out; return $null }
}
$text = [IO.File]::ReadAllText($path)
Req 'lsp.attach' @{ language = 'python'; hash = (-join ([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text.Replace("`r`n","`n"))) | % { $_.ToString('x2') })) } | Out-Null
Req 'lsp.open' @{ path = $path; text = $text; version = 1 } | Out-Null
Start-Sleep 3
$lines = $text -split "`n"
$cases = @(
  @{ name = 'import make_title (L3)'; line = 2; word = 'make_title' },
  @{ name = 'QApplication (L5)';      line = 4; word = 'QApplication' },
  @{ name = 'make_title call (L7)';   line = 6; word = 'make_title' },
  @{ name = 'APP_VERSION (L7)';       line = 6; word = 'APP_VERSION' },
  @{ name = 'win variable (L7)';      line = 6; word = 'win' },
  @{ name = 'sys module (L1)';        line = 0; word = 'sys' }
)
foreach ($c in $cases) {
  $col = $lines[$c.line].IndexOf($c.word) + 1
  $pos = @{ line = $c.line; character = $col }
  $d = Req 'lsp.definition' @{ path = $path; position = $pos }
  $h = Req 'lsp.hover' @{ path = $path; position = $pos }
  $locs = (@($d.locations) | ? { $_.path } | % { "$((Split-Path $_.path -Leaf)):$($_.range.start.line + 1) ws=$($_.inWorkspace)" }) -join ' | '
  $hv = (($h.markdown -split "`n") | ? { $_ -and $_ -notmatch '^```' } | select -First 1)
  "{0,-26} def=[{1}] hover=[{2}]" -f $c.name, $locs, $hv | Add-Content $out
}
$comp = Req 'lsp.completion' @{ path = $path; position = @{ line = 5; character = 10 } }
"completion after 'win = QMa': $(@($comp.items).Count) items; first: $(($comp.items | select -First 5 | % label) -join ', ')" | Add-Content $out
$diag = Req 'lsp.diagnostics' @{ path = $path }
"diagnostics: $(@($diag.items).Count) -> $(($diag.items | select -First 3 | % { "L$($_.range.start.line+1) $($_.message)" }) -join ' || ')" | Add-Content $out
