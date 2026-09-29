$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Config = Join-Path $Root "config.ps1"
if (Test-Path $Config) { . $Config }

$Backend = Join-Path $Root "backend"
$Python = Join-Path $Backend ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    Write-Host "Virtual environment not found. Run .\setup.ps1 first." -ForegroundColor Red
    exit 1
}

function Test-App {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 2
        return $r.status -eq "ok"
    } catch { return $false }
}

if (-not (Test-App)) {
    Write-Host "Starting TUS Companion locally..." -ForegroundColor Cyan
    Start-Process powershell.exe -WorkingDirectory $Root -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $Root "run.ps1")
    )
    $ready = $false
    1..30 | ForEach-Object {
        Start-Sleep -Milliseconds 500
        if (Test-App) { $ready = $true; return }
    }
    if (-not $ready -and -not (Test-App)) {
        Write-Host "The local app did not start on port 8000." -ForegroundColor Red
        exit 1
    }
}

$Tools = Join-Path $Root "tools"
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
$Cloudflared = Join-Path $Tools "cloudflared.exe"
if (-not (Test-Path $Cloudflared)) {
    Write-Host "Downloading Cloudflare Tunnel client from the official release..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $Cloudflared
}

Write-Host "" 
if ($env:CLOUDFLARE_TUNNEL_TOKEN) {
    Write-Host "Starting the configured permanent Cloudflare Tunnel..." -ForegroundColor Green
    Write-Host "The public hostname is the hostname configured for this tunnel in Cloudflare." -ForegroundColor Cyan
    & $Cloudflared tunnel run --token $env:CLOUDFLARE_TUNNEL_TOKEN
} else {
    Write-Host "Starting a temporary HTTPS public link for testing..." -ForegroundColor Green
    Write-Host "Copy the https://...trycloudflare.com address printed below." -ForegroundColor Cyan
    Write-Host "This link works only while this window and the PC remain online." -ForegroundColor DarkYellow
    Write-Host "For a stable release URL, configure CLOUDFLARE_TUNNEL_TOKEN in config.ps1 (see docs\PUBLISH.md)." -ForegroundColor DarkYellow
    & $Cloudflared tunnel --url http://127.0.0.1:8000
}
