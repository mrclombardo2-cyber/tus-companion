param(
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$KeyPath,
  [string]$User = "ubuntu"
)
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$State = Join-Path $Root "backend\.tus-session\storage_state.json"
if (!(Test-Path $State)) { throw "No local TUS session found at $State. Run reconnect/login locally first." }
Write-Host "Uploading ONLY the authenticated Playwright storage state. Treat this file as a secret." -ForegroundColor Yellow
scp -i $KeyPath $State "${User}@${Server}:/tmp/tus-storage-state.json"
$remote = @'
set -e
sudo systemctl stop tus-companion
sudo mkdir -p /opt/tus-companion/app/backend/.tus-session
sudo install -o tuscompanion -g tuscompanion -m 600 /tmp/tus-storage-state.json /opt/tus-companion/app/backend/.tus-session/storage_state.json
rm -f /tmp/tus-storage-state.json
sudo -u tuscompanion env PLAYWRIGHT_BROWSERS_PATH=/opt/tus-companion/playwright-browsers bash -lc 'cd /opt/tus-companion/app/backend && /opt/tus-companion/venv/bin/python -m app.cli status'
sudo -u tuscompanion env PLAYWRIGHT_BROWSERS_PATH=/opt/tus-companion/playwright-browsers bash -lc 'cd /opt/tus-companion/app/backend && /opt/tus-companion/venv/bin/python -m app.cli catalog'
sudo systemctl start tus-companion
'@
ssh -i $KeyPath "${User}@${Server}" $remote
Write-Host "Session uploaded. If status printed 'authenticated', cloud collection is ready." -ForegroundColor Green
