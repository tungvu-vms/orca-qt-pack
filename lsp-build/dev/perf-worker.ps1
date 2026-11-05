# Measures real worker round trips, including CLI overhead. Does not change buffers.
param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][string[]]$Words,
  [int]$Runs = 2
)
$ErrorActionPreference = 'Stop'
$perfFile = (Resolve-Path -LiteralPath $Path).Path
$perfLines = [IO.File]::ReadAllLines($perfFile)
$perfCli = if ($env:ORCA_CLI_COMMAND) { $env:ORCA_CLI_COMMAND } else { 'orca' }
$perfFailed = $false
for ($perfRun = 1; $perfRun -le $Runs; $perfRun++) {
  foreach ($perfWord in $Words) {
    $perfLine = -1
    for ($perfIndex = $perfLines.Length - 1; $perfIndex -ge 0; $perfIndex--) {
      if ($perfLines[$perfIndex].Contains($perfWord)) { $perfLine = $perfIndex; break }
    }
    if ($perfLine -lt 0) { throw "Symbol not found: $perfWord" }
    $perfData = @{ path = $perfFile; position = @{ line = $perfLine; character = $perfLines[$perfLine].IndexOf($perfWord) + 1 } } | ConvertTo-Json -Compress -Depth 5
    foreach ($perfMethod in @('lsp.definition', 'lsp.hover')) {
      $perfTimer = [Diagnostics.Stopwatch]::StartNew()
      $perfReply = & $perfCli plugin dev request local.qt-dev-python-lsp $perfMethod --data $perfData --timeout-ms 30000 --json | ConvertFrom-Json
      $perfResult = $perfReply.result.result
      $perfValid = $perfReply.ok -and $(if ($perfMethod -eq 'lsp.definition') { @($perfResult.locations | Where-Object path).Count -gt 0 } else { [bool]$perfResult.markdown })
      if (-not $perfValid) { $perfFailed = $true }
      [pscustomobject]@{ run = $perfRun; word = $perfWord; method = $perfMethod; ms = $perfTimer.ElapsedMilliseconds; ok = $perfValid; error = $perfReply.error.message } | ConvertTo-Json -Compress
    }
  }
}
if ($perfFailed) { exit 1 }
