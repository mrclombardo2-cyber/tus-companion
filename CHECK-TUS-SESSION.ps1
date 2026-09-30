$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
Set-Location $PSScriptRoot

$ConfigPath = Join-Path $PSScriptRoot ".cloud.local.json"
if (-not (Test-Path $ConfigPath)) {
    throw ".cloud.local.json not found. Run .\GO-LIVE.ps1 once on this project first."
}

$cloud = Get-Content -Raw $ConfigPath | ConvertFrom-Json
if (-not $cloud.cloud_api_url) { throw "cloud_api_url is missing from .cloud.local.json." }

$base = ([string]$cloud.cloud_api_url).TrimEnd("/")
$health = Invoke-RestMethod -Uri ($base + "/health?check=" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -Method Get -TimeoutSec 30

Write-Host ""
Write-Host "TUS Companion cloud status" -ForegroundColor Cyan
Write-Host "Worker version : $($health.version)"
Write-Host "Last cycle     : $($health.collector.last_cycle_finished_at)"
Write-Host "Cycle errors   : $($health.collector.last_cycle_errors)"

$sourceError = [string]$health.collector.source_session_error
if ($sourceError) {
    Write-Host "Source session : RECONNECT REQUIRED" -ForegroundColor Red
    Write-Host "Reason         : $sourceError" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Run: .\RECONNECT-AND-PUBLISH.ps1" -ForegroundColor Cyan
    exit 2
}

Write-Host "Source session : OK" -ForegroundColor Green
Write-Host ""
Write-Host "No administrator action is required." -ForegroundColor Green
exit 0
