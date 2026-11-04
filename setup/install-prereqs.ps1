# Checks for and installs what the Qt Developer Pack needs on a Windows machine.
# Run: powershell -ExecutionPolicy Bypass -File setup\install-prereqs.ps1        (no Administrator rights needed)
# Option: -SkipPython  skip basedpyright (if you do not use the Python LSP)
param([switch]$SkipPython)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
$ok = @(); $warn = @(); $todo = @()
function Has($n) { (Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1).Source }

# --- Orca ---
$orca = "$env:LOCALAPPDATA\Programs\orca\Orca.exe"
if (Test-Path $orca) {
  $v = [version]((Get-Item $orca).VersionInfo.ProductVersion)
  if ($v -ge [version]'1.4.248.0') { $ok += "Orca $v" } else { $todo += "Update Orca to >= 1.4.248 (found $v): Orca → Check for updates" }
} else { $todo += 'Install Orca: https://github.com/stablyai/orca/releases (orca-windows-setup.exe)' }

# --- Git (optional; Orca fetches git catalogs with git) ---
if (Has git) { $ok += "git $((git --version) -replace 'git version ','')" }
else { $warn += 'Git not found: install Git for Windows if Orca cannot fetch the catalog (https://git-scm.com/download/win)' }

# --- Python LSP: Node + basedpyright ---
if (-not $SkipPython) {
  $node = Has node
  if ($node) {
    $nv = [version]((& node --version).TrimStart('v'))
    if ($nv.Major -lt 20) { $todo += "Node.js $nv is too old: install Node LTS >= 20 (https://nodejs.org)" } else { $ok += "Node.js $nv" }
    $prefix = Join-Path $env:LOCALAPPDATA 'orca-qt-lsp'
    $bp = Join-Path $prefix 'node_modules\basedpyright\langserver.index.js'
    if (-not (Test-Path $bp)) {
      Write-Host 'Installing basedpyright into' $prefix '...'
      New-Item -ItemType Directory -Force $prefix | Out-Null
      & npm install --prefix $prefix basedpyright@1.40.2 --no-audit --no-fund --no-update-notifier --loglevel=error 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'npm install basedpyright failed' }
    }
    $ok += "basedpyright: $bp"
  } else { $todo += 'The Python LSP needs Node.js LTS >= 20: https://nodejs.org (then run this script again)' }
}

# --- Qt: qmlls (QML LSP), Designer/uic/rcc (Qt Tools) ---
$qmlls = Get-ChildItem 'C:\Qt', "$env:USERPROFILE\Qt" -Recurse -Depth 3 -Filter qmlls.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if ($qmlls) { $ok += "qmlls: $($qmlls.FullName)" } else { $warn += 'No Qt >= 6.5 under C:\Qt: the QML LSP and Qt Tools will not work. Install it with the Qt Online Installer (pick a kit + Qt Creator).' }

# --- clangd (C++ LSP) ---
$clangd = @('C:\Qt\Tools\QtCreator\bin\clang\bin\clangd.exe', "$env:USERPROFILE\Qt\Tools\QtCreator\bin\clang\bin\clangd.exe", 'C:\Program Files\LLVM\bin\clangd.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $clangd) { $clangd = Has clangd }
if ($clangd) { $ok += "clangd: $clangd" } else { $warn += 'clangd not found: the C++ LSP will not work. Install Qt Creator (ships clangd) or LLVM (https://github.com/llvm/llvm-project/releases).' }

Write-Host ''
Write-Host 'Found:' -ForegroundColor Green; $ok | ForEach-Object { Write-Host "  ✓ $_" }
if ($warn) { Write-Host 'Warnings:' -ForegroundColor Yellow; $warn | ForEach-Object { Write-Host "  ! $_" } }
if ($todo) { Write-Host 'To do:' -ForegroundColor Red; $todo | ForEach-Object { Write-Host "  ✗ $_" } }
Write-Host ''
Write-Host 'Next, in Orca: Settings → Plugins → Add plugin → catalog → https://github.com/tungvu-vms/orca-qt-pack.git, then install the plugins.'
if ($todo) { exit 1 }
