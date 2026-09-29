$ErrorActionPreference = "Stop"
$Config = Join-Path $PSScriptRoot "config.ps1"
if (Test-Path $Config) { . $Config }
$Backend = Join-Path $PSScriptRoot "backend"
$Python = Join-Path $Backend ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    Write-Host "Virtual environment not found. Run .\setup.ps1 first." -ForegroundColor Red
    exit 1
}
Set-Location $Backend
Write-Host "TUS Companion: http://127.0.0.1:8000" -ForegroundColor Cyan

# Keep the machine awake while the central timetable source is running.
# This does not keep the display on and is released automatically on exit.
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
    & $Python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log
} finally {
    [TusPowerState]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
}
