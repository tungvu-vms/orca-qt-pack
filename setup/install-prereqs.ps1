# Kiem tra va cai cac thanh phan ma Qt Developer Pack can tren may thanh vien (Windows).
# Chay: powershell -ExecutionPolicy Bypass -File setup\install-prereqs.ps1        (khong can quyen Administrator)
# Bao loi tieng Viet: chay trong Windows Terminal / PowerShell 7 de hien dau dung (conhost cu dung bang ma OEM).
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
# Tuy chon: -SkipPython  bo qua basedpyright (khong dung Python LSP)
param([switch]$SkipPython)
$ErrorActionPreference = 'Stop'
$ok = @(); $warn = @(); $todo = @()
function Has($n) { (Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1).Source }

# --- Orca ---
$orca = "$env:LOCALAPPDATA\Programs\orca\Orca.exe"
if (Test-Path $orca) {
  $v = [version]((Get-Item $orca).VersionInfo.ProductVersion)
  if ($v -ge [version]'1.4.248.0') { $ok += "Orca $v" } else { $todo += "Cập nhật Orca lên >= 1.4.248 (đang $v): Orca → Check for updates" }
} else { $todo += 'Cài Orca: https://github.com/stablyai/orca/releases (orca-windows-setup.exe)' }

# --- Git (Orca tai marketplace bang git) ---
if (Has git) {
  $ok += "git $((git --version) -replace 'git version ','')"
  $r = & git ls-remote https://github.com/tungvu-vms/orca-qt-pack.git HEAD 2>&1
  if ($LASTEXITCODE -eq 0) { $ok += 'Đọc được repo tungvu-vms/orca-qt-pack' }
  else { $todo += 'Không đọc được repo private: nhờ chủ repo mời làm collaborator, rồi đăng nhập GitHub cho git (gh auth login, hoặc chạy "git ls-remote https://github.com/tungvu-vms/orca-qt-pack.git" để Git Credential Manager hỏi đăng nhập)' }
} else { $todo += 'Cài Git for Windows: https://git-scm.com/download/win' }

# --- Python LSP: Node + basedpyright ---
if (-not $SkipPython) {
  $node = Has node
  if ($node) {
    $nv = [version]((& node --version).TrimStart('v'))
    if ($nv.Major -lt 20) { $todo += "Node.js $nv quá cũ: cài Node LTS >= 20 (https://nodejs.org)" } else { $ok += "Node.js $nv" }
    $prefix = Join-Path $env:LOCALAPPDATA 'orca-qt-lsp'
    $bp = Join-Path $prefix 'node_modules\basedpyright\langserver.index.js'
    if (-not (Test-Path $bp)) {
      Write-Host 'Cài basedpyright vào' $prefix '...'
      New-Item -ItemType Directory -Force $prefix | Out-Null
      & npm install --prefix $prefix basedpyright@1.40.2 --no-audit --no-fund --no-update-notifier --loglevel=error 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'npm install basedpyright thất bại' }
    }
    $ok += "basedpyright: $bp"
  } else { $todo += 'Python (LSP) cần Node.js LTS >= 20: https://nodejs.org (cài xong chạy lại script này)' }
}

# --- Qt: qmlls (QML LSP), Designer/uic/rcc (Qt Tools) ---
$qmlls = Get-ChildItem 'C:\Qt', "$env:USERPROFILE\Qt" -Recurse -Depth 3 -Filter qmlls.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if ($qmlls) { $ok += "qmlls: $($qmlls.FullName)" } else { $warn += 'Chưa có Qt >= 6.5 dưới C:\Qt: QML (LSP) và Qt Tools sẽ không chạy. Cài bằng Qt Online Installer (chọn kit + Qt Creator).' }

# --- clangd (C++ LSP) ---
$clangd = @('C:\Qt\Tools\QtCreator\bin\clang\bin\clangd.exe', "$env:USERPROFILE\Qt\Tools\QtCreator\bin\clang\bin\clangd.exe", 'C:\Program Files\LLVM\bin\clangd.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $clangd) { $clangd = Has clangd }
if ($clangd) { $ok += "clangd: $clangd" } else { $warn += 'Chưa có clangd: C++ (LSP) sẽ không chạy. Cài Qt Creator (kèm clangd) hoặc LLVM (https://github.com/llvm/llvm-project/releases).' }

Write-Host ''
Write-Host 'Đã có:' -ForegroundColor Green; $ok | ForEach-Object { Write-Host "  ✓ $_" }
if ($warn) { Write-Host 'Lưu ý:' -ForegroundColor Yellow; $warn | ForEach-Object { Write-Host "  ! $_" } }
if ($todo) { Write-Host 'Cần làm:' -ForegroundColor Red; $todo | ForEach-Object { Write-Host "  ✗ $_" } }
Write-Host ''
Write-Host 'Tiếp theo trong Orca: Settings → Plugins → Marketplaces → Add → https://github.com/tungvu-vms/orca-qt-pack.git (ref main), rồi cài plugin.'
if ($todo) { exit 1 }
