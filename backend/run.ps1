$ErrorActionPreference = "Stop"
$Config = Join-Path (Split-Path $PSScriptRoot -Parent) "config.ps1"
if (Test-Path $Config) { . $Config }
Set-Location $PSScriptRoot
if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    Write-Host "Virtual environment not found. Run ..\setup.ps1 first." -ForegroundColor Red
    exit 1
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TusPowerState {
    [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
}
"@ -ErrorAction SilentlyContinue
$ES_CONTINUOUS = [Convert]::ToUInt32("80000000", 16)
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
[TusPowerState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
try {
    & ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log
} finally {
    [TusPowerState]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
}
