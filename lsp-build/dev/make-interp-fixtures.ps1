# Creates sample projects for testing interpreter auto-selection (installs no packages, only empty venvs via python -m venv --without-pip).
# Usage: pwsh lsp-build/dev/make-interp-fixtures.ps1   (needs Python 3.12 and 3.14 from python.org under %LOCALAPPDATA%\Programs\Python)
$repo = Resolve-Path "$PSScriptRoot\..\.."
$root = Join-Path $repo 'samples\interp-cases'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
$py314 = "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe"
$py312 = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
function Venv($dir, $py) { & $py -m venv --without-pip $dir | Out-Null }
function File($path, $text) { New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null; [IO.File]::WriteAllText($path, $text) }

# A: no venv -> global
File "$root\a-no-venv\main.py" "import sys`n"
# B: one .venv at the root
File "$root\b-one-venv\main.py" "import sys`n"; Venv "$root\b-one-venv\.venv" $py314
# C: several venvs at the root: .venv (3.12) and venv (3.14) -> .venv must win by convention
File "$root\c-multi\main.py" "import sys`n"; Venv "$root\c-multi\.venv" $py312; Venv "$root\c-multi\venv" $py314
# D: monorepo, each subproject has its own venv + pyproject
File "$root\d-mono\pyproject.toml" "[project]`nname='mono'`n"
File "$root\d-mono\svc_api\pyproject.toml" "[project]`nname='api'`n"; File "$root\d-mono\svc_api\app.py" "import sys`n"; Venv "$root\d-mono\svc_api\.venv" $py312
File "$root\d-mono\svc_ui\pyproject.toml" "[project]`nname='ui'`n"; File "$root\d-mono\svc_ui\app.py" "import sys`n"; Venv "$root\d-mono\svc_ui\.venv" $py314
# E: .vscode/settings.json points at a venv with a different name
File "$root\e-vscode\main.py" "import sys`n"; Venv "$root\e-vscode\envs\work" $py312; Venv "$root\e-vscode\.venv" $py314
File "$root\e-vscode\.vscode\settings.json" "{ `"python.defaultInterpreterPath`": `"`${workspaceFolder}/envs/work/Scripts/python.exe`" }"
Get-ChildItem $root -Recurse -Filter pyvenv.cfg | % { $_.DirectoryName.Replace("$root\", '') }
