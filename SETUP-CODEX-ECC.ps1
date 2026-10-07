$ErrorActionPreference = "Stop"

$EccRepo = "affaan-m/ECC"
$EccRef = "v2.2.3"

Write-Host "TUS Companion - Codex + ECC setup" -ForegroundColor Cyan

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    throw "Codex CLI was not found in PATH. Install/update Codex first, then run this script again."
}

Write-Host "Codex:" (codex --version)

Write-Host "Adding/updating ECC marketplace at $EccRef..."
try {
    codex plugin marketplace add $EccRepo --ref $EccRef
} catch {
    Write-Host "Marketplace add returned an error; checking existing marketplace state..."
}

codex plugin marketplace list

Write-Host "Installing/refreshing native ECC plugin..."
codex plugin add ecc@ecc

Write-Host "Verifying plugin registration..."
codex plugin list --json

Write-Host ""
Write-Host "Repository setup complete." -ForegroundColor Green
Write-Host "Next time Codex opens this repository:"
Write-Host "  1. Trust the project so .codex/config.toml is loaded."
Write-Host "  2. Open /plugins and confirm ECC is enabled."
Write-Host "  3. Open /hooks, review ECC hooks, and trust them only after review."
Write-Host '  4. Run $configure-ecc inside Codex.'
Write-Host ""
Write-Host "This script does not deploy TUS Companion or change Cloudflare/GitHub secrets."
