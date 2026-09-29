$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Write-Host "1/2 - Reconnecting the central TUS session..." -ForegroundColor Cyan
& .\reconnect-tus.ps1
Write-Host "2/2 - Encrypting and publishing the refreshed session to the cloud..." -ForegroundColor Cyan
$python = Join-Path $PSScriptRoot "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Python environment not found. Run .\setup.ps1 first." }
& $python .\cloud\tools\upload_session.py
Write-Host "Done. The next GitHub sync run will use the refreshed session." -ForegroundColor Green
