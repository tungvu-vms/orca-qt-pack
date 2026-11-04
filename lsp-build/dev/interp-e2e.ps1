# Kiem tra lsp.interpreters / lsp.setInterpreter that trong Orca.
$key = 'local.qt-dev-python-lsp'
$out = "$env:TEMP\interp-e2e.txt"
'' | Set-Content $out
function Req($name, $obj, $t = 60000) {
  $j = $obj | ConvertTo-Json -Compress -Depth 6
  $r = orca plugin dev request $key $name --data $j --timeout-ms $t --json 2>$null | ConvertFrom-Json
  if ($r.ok) { return $r.result.result } else { "ERR $name : $($r.error.message)" | Add-Content $out; return $null }
}
orca repo add --path <repo>\samples\interp-cases --kind folder --json 2>$null | Out-Null
$f = '<repo>\samples\interp-cases\c-multi\main.py'
Req 'lsp.attach' @{ language = 'python'; text = [IO.File]::ReadAllText($f) } 90000 | Out-Null
$r = Req 'lsp.interpreters' @{ path = $f }
"c-multi root=$($r.root) current=$($r.current.label) [$($r.current.source)]" | Add-Content $out
"  list: $(($r.list | % { "$($_.label)[$($_.source)]" }) -join ' | ')" | Add-Content $out
$venv = ($r.list | ? { $_.label -like '.venv*' } | Select-Object -First 1).path
$s = Req 'lsp.setInterpreter' @{ path = $f; interpreter = $venv }
"after set .venv (3.12): $($s.current.label) [$($s.current.source)]" | Add-Content $out
$h = Req 'lsp.hover' @{ path = $f; position = @{ line = 0; character = 8 } }
"hover sys after switch: $((($h.markdown -split "`n") | ? { $_ -and $_ -notmatch '^```' } | Select-Object -First 1))" | Add-Content $out
$s = Req 'lsp.setInterpreter' @{ path = $f; interpreter = $null }
"after reset auto: $($s.current.label) [$($s.current.source)]" | Add-Content $out
$f2 = '<repo>\samples\demo-app\main.py'
Req 'lsp.attach' @{ language = 'python'; text = [IO.File]::ReadAllText($f2) } 90000 | Out-Null
$r2 = Req 'lsp.interpreters' @{ path = $f2 }
"demo-app current=$($r2.current.label) [$($r2.current.source)]" | Add-Content $out
