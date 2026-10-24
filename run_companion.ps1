$ErrorActionPreference = 'Stop'
$companionRoot = Join-Path $PSScriptRoot 'desktop-companion'
$companionRuntime = Join-Path $companionRoot 'runtime/electron.exe'
if (-not (Test-Path -LiteralPath $companionRuntime)) {
    Write-Host 'Install the desktop runtime once: python desktop-companion/install_runtime.py'
    exit 1
}
$env:JARVIS_PYTHON = (Get-Command python).Source
# Keep an inherited Electron tooling environment from switching the app to Node mode.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# This is the visible interactive companion. Its backend alone runs hidden.
Start-Process -FilePath $companionRuntime -ArgumentList ('"' + $companionRoot + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Normal
