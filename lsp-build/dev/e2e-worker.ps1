# Exercises the development worker through Orca's real frame bridge.
# Usage: pwsh -File lsp-build/dev/e2e-worker.ps1 [-RequirePySide6]
param([switch]$RequirePySide6)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$key = 'local.qt-dev-python-lsp'
$out = Join-Path $env:TEMP 'lsp-e2e.txt'
$orcaCli = if ($env:ORCA_CLI_COMMAND) { $env:ORCA_CLI_COMMAND } else { 'orca' }
'' | Set-Content $out
function Assert-Check($condition, [string]$message) {
  if (-not $condition) { throw $message }
  "PASS $message" | Tee-Object -FilePath $out -Append | Write-Host
}
function Req([string]$name, $obj) {
  $j = ConvertTo-Json -InputObject $obj -Compress -Depth 12
  $raw = & $orcaCli plugin dev request $key $name --data $j --timeout-ms 90000 --json
  if ($LASTEXITCODE -ne 0) { throw "$name failed: $raw" }
  $r = $raw | ConvertFrom-Json
  if (-not $r.ok) { throw "$name failed: $($r.error.message)" }
  return $r.result.result
}
function Attach-File([string]$file) {
  $text = [IO.File]::ReadAllText($file)
  $lf = $text.Replace("`r`n", "`n")
  $bytes = [Text.Encoding]::UTF8.GetBytes($lf)
  $sha = [Security.Cryptography.SHA1]::Create()
  try { $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
  $attached = Req 'lsp.attach' @{ language = 'python'; hash = $hash; size = $bytes.Length; sizeCrlf = $bytes.Length + ([regex]::Matches($lf, "`n")).Count }
  Assert-Check ($attached.ok -and $attached.path) "Attach $([IO.Path]::GetFileName($file)) by hash and byte sizes"
  Req 'lsp.open' @{ path = $attached.path; text = $text; version = 1 } | Out-Null
  return @{ path = $attached.path; text = $text }
}
try {
  $helper = Attach-File (Join-Path $repo 'samples/demo-app/helper.py')
  $main = Attach-File (Join-Path $repo 'samples/demo-app/main.py')
  $definition = Req 'lsp.definition' @{ path = $main.path; position = @{ line = 2; character = 20 } }
  Assert-Check (@($definition.locations).Count -gt 0) 'F12 resolves the project import'
  $hover = Req 'lsp.hover' @{ path = $helper.path; position = @{ line = 0; character = 6 } }
  Assert-Check ([string]$hover.markdown -match 'make_title') 'Hover returns function information'
  $references = Req 'lsp.references' @{ path = $helper.path; position = @{ line = 0; character = 6 }; includeDeclaration = $true }
  Assert-Check (@($references.locations).Count -ge 2) 'References include the declaration and callers'
  $signature = Req 'lsp.signatureHelp' @{ path = $main.path; position = @{ line = 6; character = 30 } }
  Assert-Check (@($signature.signatures).Count -gt 0) 'Signature help resolves an imported function'
  $symbols = Req 'lsp.documentSymbols' @{ path = $helper.path }
  Assert-Check (@($symbols.items | Where-Object name -eq 'make_title').Count -eq 1) 'Document symbols contain the function'
  $rename = Req 'lsp.rename' @{ path = $helper.path; position = @{ line = 0; character = 16 }; newName = 'display_name'; version = 1 }
  Assert-Check (-not $rename.rejectReason -and @($rename.edits).Count -eq 2) 'F2 returns local parameter edits without writing disk'
  $crossFile = Req 'lsp.rename' @{ path = $helper.path; position = @{ line = 0; character = 6 }; newName = 'new_title'; version = 1 }
  Assert-Check ($crossFile.rejectReason -and @($crossFile.edits).Count -eq 0) 'Cross-file rename is rejected without partial edits'
  if ($RequirePySide6) {
    $qt = Req 'lsp.definition' @{ path = $main.path; position = @{ line = 4; character = 10 } }
    Assert-Check (@($qt.locations | Where-Object { $_.path -match 'QtWidgets' }).Count -gt 0) 'PySide6 QApplication resolves in the selected interpreter'
  }
  "All worker checks passed. Report: $out" | Write-Host
} catch {
  "FAIL $($_.Exception.Message)" | Tee-Object -FilePath $out -Append | Write-Host
  exit 1
}
