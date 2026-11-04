# Tao du an mau de kiem tra tu chon interpreter (khong cai goi, chi tao venv rong bang python -m venv --without-pip).
$root = '<repo>\samples\interp-cases'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
$py314 = "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe"
$py312 = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
function Venv($dir, $py) { & $py -m venv --without-pip $dir | Out-Null }
function File($path, $text) { New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null; [IO.File]::WriteAllText($path, $text) }

# A: khong co venv -> global
File "$root\a-no-venv\main.py" "import sys`n"
# B: mot .venv o goc
File "$root\b-one-venv\main.py" "import sys`n"; Venv "$root\b-one-venv\.venv" $py314
# C: nhieu venv o goc: .venv (3.12) va venv (3.14) -> phai chon .venv theo quy uoc
File "$root\c-multi\main.py" "import sys`n"; Venv "$root\c-multi\.venv" $py312; Venv "$root\c-multi\venv" $py314
# D: monorepo, moi project con co venv rieng + pyproject
File "$root\d-mono\pyproject.toml" "[project]`nname='mono'`n"
File "$root\d-mono\svc_api\pyproject.toml" "[project]`nname='api'`n"; File "$root\d-mono\svc_api\app.py" "import sys`n"; Venv "$root\d-mono\svc_api\.venv" $py312
File "$root\d-mono\svc_ui\pyproject.toml" "[project]`nname='ui'`n"; File "$root\d-mono\svc_ui\app.py" "import sys`n"; Venv "$root\d-mono\svc_ui\.venv" $py314
# E: .vscode/settings.json chi dinh venv khac ten
File "$root\e-vscode\main.py" "import sys`n"; Venv "$root\e-vscode\envs\work" $py312; Venv "$root\e-vscode\.venv" $py314
File "$root\e-vscode\.vscode\settings.json" "{ `"python.defaultInterpreterPath`": `"`${workspaceFolder}/envs/work/Scripts/python.exe`" }"
Get-ChildItem $root -Recurse -Filter pyvenv.cfg | % { $_.DirectoryName.Replace("$root\", '') }
