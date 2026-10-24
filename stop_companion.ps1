$ErrorActionPreference = 'Stop'
$jarvisStopRuntime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'desktop-companion/runtime/electron.exe'))
$jarvisStopProcesses = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $jarvisStopRuntime })
if ($jarvisStopProcesses.Count) {
    $jarvisStopProcesses | Stop-Process -Force
    Write-Host 'Jarvis companion stopped.'
} else { Write-Host 'Jarvis companion is already stopped.' }
