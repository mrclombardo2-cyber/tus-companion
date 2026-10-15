$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Repository = 'mrclombardo2-cyber/tus-companion'
$Workflow = 'recover-tus-from-browser.yml'
$WorkRoot = Join-Path $env:LOCALAPPDATA 'TUSCompanionRecovery'
$Project = Join-Path $WorkRoot 'project'
$Python = Join-Path $Project 'backend\.venv\Scripts\python.exe'
$Storage = Join-Path $Project 'backend\.tus-session\storage_state.json'
$Temp = Join-Path $WorkRoot 'download'
$SecretCreated = $false
$GhExe = ''

function Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

try {
    New-Item -ItemType Directory -Force -Path $WorkRoot, $Project | Out-Null
    Step 'Checking GitHub command-line access'
    $Gh = Get-Command gh.exe -ErrorAction SilentlyContinue
    if (-not $Gh) { $Gh = Get-Command gh -ErrorAction SilentlyContinue }
    if (-not $Gh) {
        $Winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $Winget) { throw 'GitHub CLI is needed: https://cli.github.com/' }
        Write-Host 'Installing GitHub CLI (one-time)...'
        & $Winget.Source install --id GitHub.cli --exact --source winget --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI installation failed. Install from https://cli.github.com/' }
        $GhPath = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
        if (-not (Test-Path $GhPath)) { throw 'GitHub CLI installed. Restart this launcher once.' }
        $GhExe = $GhPath
    } else { $GhExe = $Gh.Source }

    & $GhExe auth status --hostname github.com *> $null
    if ($LASTEXITCODE -ne 0) {
        Step 'Authorize your GitHub account once using the official browser'
        & $GhExe auth login --hostname github.com --web --git-protocol https
        if ($LASTEXITCODE -ne 0) { throw 'GitHub authorization was not completed.' }
    }
    $LoggedIn = (& $GhExe api user --jq .login 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $LoggedIn) { throw 'Cannot verify GitHub authorization.' }
    Write-Host "GitHub authorized as $LoggedIn" -ForegroundColor Green

    Step 'Downloading the latest trusted recovery source from your repository'
    if (Test-Path $Temp) { Remove-Item $Temp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Temp | Out-Null
    $ZipPath = Join-Path $Temp 'project.zip'
    Invoke-WebRequest -Uri "https://github.com/$Repository/archive/refs/heads/main.zip" -OutFile $ZipPath -UseBasicParsing
    Expand-Archive -Path $ZipPath -DestinationPath $Temp -Force
    $Unpacked = Join-Path $Temp 'tus-companion-main'
    if (-not (Test-Path (Join-Path $Unpacked 'backend\requirements.txt'))) { throw 'Invalid project archive.' }
    Copy-Item -Path (Join-Path $Unpacked '*') -Destination $Project -Recurse -Force

    Step 'Preparing the TUS sign-in browser (first run takes longer)'
    if (-not (Test-Path $Python)) {
        $Py = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($Py) {
            & $Py.Source -3 -m venv (Join-Path $Project 'backend\.venv')
        } else {
            $Py = Get-Command python.exe -ErrorAction SilentlyContinue
            if (-not $Py) {
                $Winget = Get-Command winget.exe -ErrorAction SilentlyContinue
                if (-not $Winget) { throw 'Install Python 3.12 from https://www.python.org/downloads/windows/' }
                Write-Host 'Installing Python 3.12 (one-time)...'
                & $Winget.Source install --id Python.Python.3.12 --exact --source winget --accept-package-agreements --accept-source-agreements
                if ($LASTEXITCODE -ne 0) { throw 'Could not install Python 3.12.' }
                $Installed = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
                if (-not (Test-Path $Installed)) { throw 'Python installed. Restart this launcher once.' }
                & $Installed -m venv (Join-Path $Project 'backend\.venv')
            } else {
                & $Py.Source -m venv (Join-Path $Project 'backend\.venv')
            }
        }
        if ($LASTEXITCODE -ne 0) { throw 'Could not prepare Python.' }
    }
    if (-not (Test-Path $Python)) { throw 'Python environment is unavailable.' }
    $DependencyFlag = Join-Path $WorkRoot 'deps-installed-v1'
    if (-not (Test-Path $DependencyFlag)) {
        & $Python -m pip install --disable-pip-version-check --no-input -r (Join-Path $Project 'backend\requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the TUS browser dependencies.' }
        & $Python -m playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw 'Could not install Chromium.' }
        Set-Content -Path $DependencyFlag -Value (Get-Date).ToString('o') -Encoding UTF8
    }

    Step 'Checking current Microsoft/TUS session'
    Push-Location (Join-Path $Project 'backend')
    try {
        $Status = (& $Python -m app.cli status 2>&1 | Out-String)
        if ($Status -notmatch '(?m)^authenticated\s*$') {
            Write-Host 'Official Microsoft/TUS login will open. Enter credentials or MFA ONLY if the official page asks.' -ForegroundColor Yellow
            & $Python -m app.cli login
            if ($LASTEXITCODE -ne 0) { throw 'The university sign-in was not completed.' }
            $Status = (& $Python -m app.cli status 2>&1 | Out-String)
            if ($Status -notmatch '(?m)^authenticated\s*$') { throw 'University sign-in could not be verified.' }
        }
    } finally { Pop-Location }
    if (-not (Test-Path $Storage)) { throw 'Authenticated browser state was not saved.' }
    $Parsed = Get-Content $Storage -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $Parsed.cookies) { throw 'No session cookies were produced.' }

    Step 'Sending the session through encrypted GitHub Actions Secrets'
    $SessionBytes = [IO.File]::ReadAllBytes($Storage)
    $Encoded = [Convert]::ToBase64String($SessionBytes)
    # gh encrypts the secret locally using the repository public key.
    # Neither the password nor raw browser cookies enter workflow inputs or GitHub commits.
    $Encoded | & $GhExe secret set TUS_RECOVERY_STATE_B64 --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw 'GitHub refused the secure temporary session secret.' }
    $SecretCreated = $true
    Remove-Variable Encoded,SessionBytes -ErrorAction SilentlyContinue

    $EarliestRun = (Get-Date).ToUniversalTime().AddMinutes(-1)
    Step 'Running automatic session restoration on Cloudflare'
    & $GhExe workflow run $Workflow --repo $Repository --ref main
    if ($LASTEXITCODE -ne 0) { throw 'GitHub could not start the recovery workflow.' }
    $RunId = ''
    for ($Attempt = 0; $Attempt -lt 25 -and -not $RunId; $Attempt++) {
        Start-Sleep -Seconds 3
        $RunsJson = & $GhExe run list --repo $Repository --workflow $Workflow --event workflow_dispatch --limit 10 --json databaseId,createdAt,status
        if ($LASTEXITCODE -ne 0) { continue }
        $Recent = $RunsJson | ConvertFrom-Json | Where-Object { [DateTime]$_.createdAt -ge $EarliestRun } | Sort-Object createdAt -Descending | Select-Object -First 1
        if ($Recent) { $RunId = [string]$Recent.databaseId }
    }
    if (-not $RunId) { throw 'Run started, but could not be located. Open GitHub Actions.' }
    Write-Host "Tracking: https://github.com/$Repository/actions/runs/$RunId"
    & $GhExe run watch $RunId --repo $Repository --exit-status
    if ($LASTEXITCODE -ne 0) { throw 'Source session was not verified. Check the linked GitHub Actions run.' }

    Write-Host ''
    Write-Host 'TUS SESSION RECONNECTED AND VERIFIED' -ForegroundColor Green
    Write-Host 'Cloudflare accepted the session and confirmed fresh catalog data.' -ForegroundColor Green
    Write-Host 'App: https://tus-companion.tusathlone.workers.dev/'
} catch {
    Write-Host ''
    Write-Host "Recovery failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Check: https://github.com/$Repository/actions" -ForegroundColor Yellow
    exit 1
} finally {
    if ($SecretCreated) {
        Write-Host 'Removing temporary browser session secret from GitHub...'
        & $GhExe secret delete TUS_RECOVERY_STATE_B64 --repo $Repository
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'Delete TUS_RECOVERY_STATE_B64 in repository Settings > Secrets and variables > Actions.'
        }
    }
    if (Test-Path $Temp) { Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue }
}
