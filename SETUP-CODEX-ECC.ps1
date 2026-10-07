$ErrorActionPreference = "Stop"

$EccRepo = "affaan-m/ECC"
$EccRef = "v2.2.3"

function Invoke-CodexCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    & codex @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

Write-Host "TUS Companion - Codex + ECC setup" -ForegroundColor Cyan

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    throw "Codex CLI was not found in PATH. Install/update Codex first, then run this script again."
}

Invoke-CodexCommand -Arguments @("--version") -Description "Codex version check"

Write-Host "Adding/updating ECC marketplace at $EccRef..."
& codex plugin marketplace add $EccRepo --ref $EccRef
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Marketplace add returned a non-zero exit code. Verifying the existing marketplace before continuing..."
}

Invoke-CodexCommand -Arguments @("plugin", "marketplace", "list") -Description "Marketplace verification"

Write-Host "Installing/refreshing native ECC plugin..."
Invoke-CodexCommand -Arguments @("plugin", "add", "ecc@ecc") -Description "ECC plugin installation"

Write-Host "Verifying plugin registration..."
Invoke-CodexCommand -Arguments @("plugin", "list", "--json") -Description "ECC plugin verification"

Write-Host ""
Write-Host "Repository setup complete." -ForegroundColor Green
Write-Host "Next time Codex opens this repository:"
Write-Host "  1. Trust the project so .codex/config.toml is loaded."
Write-Host "  2. Open /plugins and confirm ECC is enabled."
Write-Host "  3. Open /hooks, review ECC hooks, and trust them only after review."
Write-Host '  4. Run $configure-ecc inside Codex.'
Write-Host ""
Write-Host "This script does not deploy TUS Companion or change Cloudflare/GitHub secrets."
