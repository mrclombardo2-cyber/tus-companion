$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
Set-Location $PSScriptRoot

$Root = $PSScriptRoot
$CloudConfigPath = Join-Path $Root ".cloud.local.json"
$Python = Join-Path $Root "backend\.venv\Scripts\python.exe"
$SessionState = Join-Path $Root "backend\.tus-session\storage_state.json"

function Step([string]$Text) {
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

if (-not (Test-Path $Python)) {
    throw "Python environment not found. Run .\setup.ps1 first."
}
if (-not (Test-Path $CloudConfigPath)) {
    throw ".cloud.local.json not found. Run .\GO-LIVE.ps1 once on this project first."
}

Step "Reconnect the central TUS/Microsoft session"
& (Join-Path $Root "reconnect-tus.ps1")
if ($LASTEXITCODE -ne 0) { throw "TUS/Microsoft reconnect did not complete." }
if (-not (Test-Path $SessionState)) { throw "No TUS storage_state.json was created." }

Step "Verify the local authenticated session"
Push-Location (Join-Path $Root "backend")
try {
    $statusText = (& $Python -m app.cli status 2>&1 | Out-String)
} finally {
    Pop-Location
}
if ($statusText -notmatch '(?m)^authenticated\s*$') {
    throw "The refreshed TUS session is not authenticated. Run the command again and complete Microsoft/MFA."
}
Write-Host "Local TUS session: authenticated" -ForegroundColor Green

Step "Load private Cloudflare reconnect configuration"
$cloud = Get-Content -Raw $CloudConfigPath | ConvertFrom-Json
foreach ($name in @("cloud_api_url","cloud_admin_token","session_cipher_key_b64")) {
    if (-not $cloud.PSObject.Properties.Name.Contains($name) -or -not $cloud.$name) {
        throw "Missing '$name' in .cloud.local.json. Run .\GO-LIVE.ps1 to repair the cloud configuration."
    }
}

$oldApi = $env:CLOUD_API_URL
$oldAdmin = $env:CLOUD_ADMIN_TOKEN
$oldCipher = $env:SESSION_CIPHER_KEY_B64

try {
    $env:CLOUD_API_URL = [string]$cloud.cloud_api_url
    $env:CLOUD_ADMIN_TOKEN = [string]$cloud.cloud_admin_token
    $env:SESSION_CIPHER_KEY_B64 = [string]$cloud.session_cipher_key_b64

    Step "Encrypt, upload and verify the refreshed session"
    & $Python (Join-Path $Root "cloud\collector\run_cloud_sync.py") --upload-local-session
    if ($LASTEXITCODE -ne 0) {
        throw "Cloudflare did not confirm the refreshed TUS session."
    }
}
finally {
    $env:CLOUD_API_URL = $oldApi
    $env:CLOUD_ADMIN_TOKEN = $oldAdmin
    $env:SESSION_CIPHER_KEY_B64 = $oldCipher
}

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " TUS SESSION RECONNECTED AND VERIFIED" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "Cloudflare has accepted the new encrypted session and a fresh catalogue sync was confirmed." -ForegroundColor White
Write-Host "Students do not need to sign in or do anything." -ForegroundColor Green
