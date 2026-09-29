$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\backend"
if (-not (Test-Path ".venv")) { python -m venv .venv }
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
& ".\.venv\Scripts\python.exe" -m playwright install chromium
if (-not (Test-Path ".\secrets\vapid_private.pem") -or -not (Test-Path ".\secrets\vapid_public.txt")) {
    & ".\.venv\Scripts\python.exe" -m app.cli vapid-generate
} else {
    Write-Host "Using existing Web Push (VAPID) keys." -ForegroundColor DarkGray
}
Write-Host "`nA browser will open for the ONE central TUS source login." -ForegroundColor Cyan
Write-Host "Do not click the TUS Student or Student Set - by Name controls: the collector does those automatically." -ForegroundColor DarkGray
Write-Host "Only complete the Microsoft sign-in / MFA when Microsoft asks for it." -ForegroundColor DarkGray
& ".\.venv\Scripts\python.exe" -m app.cli login
Write-Host "`nBuilding Department / Student Group catalogue in the background (headless)..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m app.cli catalog
Write-Host "`nSetup complete." -ForegroundColor Green
Write-Host "Start from project root with .\run.ps1, OR from backend with .\run.ps1" -ForegroundColor Green
