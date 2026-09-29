$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

# Windows PowerShell 5.1 can otherwise negotiate an obsolete TLS version when
# Invoke-RestMethod talks to workers.dev. Keep existing protocols and add TLS 1.2.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # On newer PowerShell versions this setting may be unnecessary.
}

Set-Location $PSScriptRoot

$Root = $PSScriptRoot
$WorkerDir = Join-Path $Root "cloud\worker"
$CloudConfigPath = Join-Path $Root ".cloud.local.json"
$SessionState = Join-Path $Root "backend\.tus-session\storage_state.json"
$Python = Join-Path $Root "backend\.venv\Scripts\python.exe"
$WorkerConfig = Join-Path $WorkerDir "wrangler.toml"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Step([string]$Text) {
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Ensure-Tool([string]$Command, [string]$WingetId, [string]$FriendlyName) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$FriendlyName is missing and winget is not available. Install $FriendlyName, reopen PowerShell, then run .\GO-LIVE.ps1 again."
    }
    Write-Host "$FriendlyName is missing. Installing it with winget..." -ForegroundColor Yellow
    & winget install --id $WingetId -e --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "winget could not install $FriendlyName (exit $LASTEXITCODE)." }
    Refresh-ProcessPath
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$FriendlyName was installed but is not visible in this PowerShell session. Close PowerShell, reopen it, and run .\GO-LIVE.ps1 again."
    }
}

function New-RandomBytes([int]$Count) {
    $bytes = New-Object byte[] $Count
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return $bytes
}

function New-HexToken([int]$Bytes = 32) {
    return ([BitConverter]::ToString((New-RandomBytes $Bytes))).Replace("-", "").ToLowerInvariant()
}

function New-Base64Key([int]$Bytes = 32) {
    return [Convert]::ToBase64String((New-RandomBytes $Bytes))
}

function Read-CloudConfig {
    $h = @{}
    if (Test-Path $CloudConfigPath) {
        $obj = Get-Content -Raw $CloudConfigPath | ConvertFrom-Json
        foreach ($prop in $obj.PSObject.Properties) { $h[$prop.Name] = $prop.Value }
    }
    return $h
}

function Save-CloudConfig([hashtable]$Config) {
    Write-NoBom $CloudConfigPath (($Config | ConvertTo-Json -Depth 5) + "`n")
}

function Invoke-Wrangler {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
    & $script:Wrangler @Args
    if ($LASTEXITCODE -ne 0) { throw "Wrangler failed: $($Args -join ' ') (exit $LASTEXITCODE)." }
}

function Invoke-JsonGet([string]$Uri, [int]$Attempts = 6) {
    $lastError = $null
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 30
        } catch {
            $lastError = $_
            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ($curl) {
                try {
                    $raw = (& $curl.Source --fail --silent --show-error --location --connect-timeout 15 --max-time 30 $Uri 2>&1 | Out-String)
                    if ($LASTEXITCODE -eq 0 -and $raw.Trim()) {
                        return ($raw | ConvertFrom-Json)
                    }
                } catch {
                    $lastError = $_
                }
            }
            if ($i -lt $Attempts) { Start-Sleep -Seconds 5 }
        }
    }
    throw "HTTPS check failed after $Attempts attempts for $Uri. Last error: $($lastError.Exception.Message)"
}

function Test-GitHubRepo([string]$RepoFull) {
    # A missing repository is an expected condition while choosing the first
    # available public repo name. PowerShell 7 can promote native stderr/nonzero
    # exits to terminating errors when ErrorActionPreference is Stop, so probe
    # GitHub with Continue semantics and return false cleanly on 404/GraphQL miss.
    $oldErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $global:LASTEXITCODE = 1
        & $script:Gh repo view $RepoFull --json name --jq .name 1>$null 2>$null
        $repoExit = $LASTEXITCODE
        return ($repoExit -eq 0)
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }
}

function Assert-NoSecretsStaged {
    $staged = @(& $script:Git diff --cached --name-only)
    $forbidden = @(
        '.cloud.local.json',
        'config.ps1',
        'backend/.tus-session/',
        'backend/.tus-browser-profile/',
        'backend/data/',
        'backend/secrets/',
        'backend/fixtures/',
        'cloud/worker/.dev.vars',
        'cloud/worker/.env'
    )
    foreach ($file in $staged) {
        $n = ($file -replace '\\','/')
        foreach ($bad in $forbidden) {
            if ($n -eq $bad -or $n.StartsWith($bad)) {
                & $script:Git reset -- $file *> $null
                throw "SECURITY STOP: sensitive path was about to be committed: $file"
            }
        }
    }
}

try {
    Step "Prerequisites"
    Ensure-Tool "git" "Git.Git" "Git"
    Ensure-Tool "gh" "GitHub.cli" "GitHub CLI"
    Ensure-Tool "node" "OpenJS.NodeJS.LTS" "Node.js LTS"
    Refresh-ProcessPath

    $script:Git = (Get-Command git -ErrorAction Stop).Source
    $script:Gh = (Get-Command gh -ErrorAction Stop).Source
    $Npm = (Get-Command npm -ErrorAction Stop).Source

    if (-not (Test-Path $Python)) {
        Write-Host "The local Python environment is missing. Running the existing TUS setup once..." -ForegroundColor Yellow
        & (Join-Path $Root "setup.ps1")
        if (-not (Test-Path $Python)) { throw "Local Python setup did not complete." }
    }

    if (-not (Test-Path $SessionState)) {
        Write-Host "No TUS source session was found. Opening the normal TUS/Microsoft reconnect flow once..." -ForegroundColor Yellow
        & (Join-Path $Root "reconnect-tus.ps1")
        if (-not (Test-Path $SessionState)) { throw "TUS source session was not created." }
    }

    Step "Verify the central TUS source session"
    Push-Location (Join-Path $Root "backend")
    try {
        $statusText = (& $Python -m app.cli status 2>&1 | Out-String)
    } finally { Pop-Location }
    if ($statusText -notmatch '(?m)^authenticated\s*$') {
        Write-Host "The saved TUS session needs a normal Microsoft/TUS sign-in before it can move to the cloud." -ForegroundColor Yellow
        & (Join-Path $Root "reconnect-tus.ps1")
        if (-not (Test-Path $SessionState)) { throw "TUS reconnect did not create a source session." }
        Push-Location (Join-Path $Root "backend")
        try { $statusText = (& $Python -m app.cli status 2>&1 | Out-String) } finally { Pop-Location }
        if ($statusText -notmatch '(?m)^authenticated\s*$') { throw "TUS source session is still not authenticated." }
    }
    Write-Host "TUS source session: authenticated" -ForegroundColor Green

    Step "Cloudflare tools"
    Push-Location $WorkerDir
    try {
        & $Npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    } finally { Pop-Location }

    $script:Wrangler = Join-Path $WorkerDir "node_modules\.bin\wrangler.cmd"
    $WebPush = Join-Path $WorkerDir "node_modules\.bin\web-push.cmd"
    if (-not (Test-Path $script:Wrangler)) { throw "Wrangler was not installed correctly." }
    if (-not (Test-Path $WebPush)) { throw "web-push was not installed correctly." }

    Step "Cloudflare login"
    Push-Location $WorkerDir
    try {
        & $script:Wrangler whoami *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Your browser will open for Cloudflare login. Complete the normal Cloudflare sign-in/consent there." -ForegroundColor Yellow
            & $script:Wrangler login
            if ($LASTEXITCODE -ne 0) { throw "Cloudflare login did not complete." }
        }
    } finally { Pop-Location }

    Step "Cloudflare D1 database"
    $toml = Get-Content -Raw $WorkerConfig
    if ($toml -notmatch '\[\[d1_databases\]\]') {
        Push-Location $WorkerDir
        try {
            & $script:Wrangler d1 create tus-companion-db --jurisdiction eu --binding DB --update-config
            if ($LASTEXITCODE -ne 0) {
                Write-Host "The database name may already exist in this Cloudflare account. Reusing it..." -ForegroundColor Yellow
                $listRaw = (& $script:Wrangler d1 list --json | Out-String)
                if ($LASTEXITCODE -ne 0) { throw "Could not list Cloudflare D1 databases." }
                $dbs = $listRaw | ConvertFrom-Json
                $db = @($dbs) | Where-Object { $_.name -eq 'tus-companion-db' } | Select-Object -First 1
                if (-not $db) { throw "D1 database creation failed and tus-companion-db was not found." }
                $dbId = $db.uuid
                if (-not $dbId) { $dbId = $db.id }
                if (-not $dbId) { throw "Could not read the D1 database id." }
                $tomlNow = Get-Content -Raw $WorkerConfig
                $block = "`n[[d1_databases]]`nbinding = `"DB`"`ndatabase_name = `"tus-companion-db`"`ndatabase_id = `"$dbId`"`n"
                Write-NoBom $WorkerConfig ($tomlNow.TrimEnd() + "`n" + $block)
            }
        } finally { Pop-Location }
    } else {
        Write-Host "D1 binding already present; reusing it." -ForegroundColor DarkGray
    }

    Push-Location $WorkerDir
    try {
        Invoke-Wrangler d1 execute tus-companion-db --remote --file "migrations/0001_init.sql" --yes
    } finally { Pop-Location }

    Step "Generate/reuse private cloud keys"
    $cloud = Read-CloudConfig
    if (-not $cloud.ContainsKey('cloud_admin_token') -or -not $cloud['cloud_admin_token']) {
        $cloud['cloud_admin_token'] = New-HexToken 32
    }
    if (-not $cloud.ContainsKey('session_cipher_key_b64') -or -not $cloud['session_cipher_key_b64']) {
        $cloud['session_cipher_key_b64'] = New-Base64Key 32
    }
    if (-not $cloud.ContainsKey('vapid_public_key') -or -not $cloud['vapid_public_key'] -or
        -not $cloud.ContainsKey('vapid_private_key') -or -not $cloud['vapid_private_key']) {
        $vapidRaw = (& $WebPush generate-vapid-keys --json | Out-String)
        if ($LASTEXITCODE -ne 0) { throw "Could not generate VAPID keys." }
        $vapid = $vapidRaw | ConvertFrom-Json
        $cloud['vapid_public_key'] = $vapid.publicKey
        $cloud['vapid_private_key'] = $vapid.privateKey
    }
    if (-not $cloud.ContainsKey('vapid_subject') -or -not $cloud['vapid_subject']) {
        $cloud['vapid_subject'] = 'mailto:admin@example.com'
    }
    Save-CloudConfig $cloud

    Step "Deploy Cloudflare Worker + PWA"
    $cfSecrets = [ordered]@{
        ADMIN_TOKEN = [string]$cloud['cloud_admin_token']
        VAPID_PUBLIC_KEY = [string]$cloud['vapid_public_key']
        VAPID_PRIVATE_KEY = [string]$cloud['vapid_private_key']
        VAPID_SUBJECT = [string]$cloud['vapid_subject']
    }
    $cfSecretPath = Join-Path $env:TEMP ("tus-companion-cloud-secrets-" + $PID + ".json")
    Write-NoBom $cfSecretPath (($cfSecrets | ConvertTo-Json -Depth 4) + "`n")
    try {
        Push-Location $WorkerDir
        try {
            $deployLines = @(& $script:Wrangler deploy --secrets-file $cfSecretPath 2>&1 | Tee-Object -Variable _deployEcho)
            $deployExit = $LASTEXITCODE
        } finally { Pop-Location }
        if ($deployExit -ne 0) { throw "Cloudflare Worker deployment failed (exit $deployExit)." }
    } finally {
        Remove-Item $cfSecretPath -Force -ErrorAction SilentlyContinue
    }

    $deployText = ($deployLines -join "`n")
    $urlMatch = [regex]::Match($deployText, 'https://[A-Za-z0-9._-]+\.workers\.dev')
    if ($urlMatch.Success) {
        $cloudUrl = $urlMatch.Value.TrimEnd('/')
    } elseif ($cloud.ContainsKey('cloud_api_url') -and $cloud['cloud_api_url']) {
        $cloudUrl = ([string]$cloud['cloud_api_url']).TrimEnd('/')
    } else {
        throw "The Worker was deployed, but its workers.dev URL could not be detected from Wrangler output. Run .\GO-LIVE.ps1 again; the second deploy normally exposes it immediately."
    }
    $cloud['cloud_api_url'] = $cloudUrl
    Save-CloudConfig $cloud

    $health = Invoke-JsonGet -Uri ($cloudUrl + '/health')
    if ($health.status -ne 'ok') { throw "Worker health check did not return OK." }
    Write-Host "Worker online: $cloudUrl" -ForegroundColor Green

    Step "Encrypt and publish the TUS source session"
    & $Python (Join-Path $Root "cloud\tools\upload_session.py")
    if ($LASTEXITCODE -ne 0) { throw "Encrypted TUS source-session upload failed." }

    Step "GitHub login"
    & $script:Gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Your browser will open for GitHub login. Complete the normal GitHub authorization there." -ForegroundColor Yellow
        & $script:Gh auth login --hostname github.com --git-protocol https --web
        if ($LASTEXITCODE -ne 0) { throw "GitHub login did not complete." }
    }
    & $script:Gh auth setup-git
    if ($LASTEXITCODE -ne 0) { throw "GitHub could not configure Git authentication." }

    $ghUserRaw = (& $script:Gh api user | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Could not read the authenticated GitHub account." }
    $ghUser = $ghUserRaw | ConvertFrom-Json
    $login = [string]$ghUser.login
    $userId = [string]$ghUser.id
    if (-not $login) { throw "GitHub login name is empty." }

    Step "Create/reuse the public GitHub repository"
    if (-not (Test-Path (Join-Path $Root '.git'))) {
        & $script:Git init
        if ($LASTEXITCODE -ne 0) { throw "git init failed." }
    }
    & $script:Git branch -M main
    & $script:Git config user.name $login
    & $script:Git config user.email ("$userId+$login@users.noreply.github.com")

    if ($cloud.ContainsKey('github_repo') -and $cloud['github_repo']) {
        $repoFull = [string]$cloud['github_repo']
    } else {
        $candidates = @('tus-companion', 'tus-companion-athlone', 'tus-companion-cloud')
        $repoFull = $null
        foreach ($candidate in $candidates) {
            $candidateFull = "$login/$candidate"
            if (-not (Test-GitHubRepo $candidateFull)) { $repoFull = $candidateFull; break }
        }
        if (-not $repoFull) { $repoFull = "$login/tus-companion-" + (Get-Date -Format 'yyyyMMddHHmm') }
        $cloud['github_repo'] = $repoFull
        Save-CloudConfig $cloud
    }

    & $script:Git add -A
    if ($LASTEXITCODE -ne 0) { throw "git add failed." }
    Assert-NoSecretsStaged
    $pending = @(& $script:Git status --porcelain)
    if ($pending.Count -gt 0) {
        & $script:Git commit -m "TUS Companion cloud v14"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
    }

    $repoExists = Test-GitHubRepo $repoFull

    # Probe remotes without calling `git remote get-url origin` when origin does
    # not exist. With ErrorActionPreference=Stop, Git's harmless
    # "No such remote 'origin'" stderr can otherwise terminate the whole deploy.
    $origin = ''
    $oldErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $remoteNames = @(& $script:Git remote 2>$null)
        if ($LASTEXITCODE -eq 0 -and ($remoteNames -contains 'origin')) {
            $origin = ((& $script:Git remote get-url origin 2>$null | Out-String).Trim())
        }
    } catch {
        $origin = ''
    } finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }

    if (-not $repoExists) {
        if ($origin) { & $script:Git remote remove origin }
        & $script:Gh repo create $repoFull --public --source $Root --remote origin --push
        if ($LASTEXITCODE -ne 0) { throw "GitHub repository creation/push failed." }
    } else {
        $wantedOrigin = "https://github.com/$repoFull.git"
        if (-not $origin) {
            & $script:Git remote add origin $wantedOrigin
        } elseif ($origin -notmatch [regex]::Escape($repoFull)) {
            & $script:Git remote set-url origin $wantedOrigin
        }
        & $script:Git push -u origin main
        if ($LASTEXITCODE -ne 0) { throw "GitHub push failed." }
    }

    Step "Configure GitHub Actions secrets"
    $ghSecretsPath = Join-Path $env:TEMP ("tus-companion-gh-secrets-" + $PID + ".env")
    $ghSecretsText = @(
        "CLOUD_API_URL=$cloudUrl",
        "CLOUD_ADMIN_TOKEN=$($cloud['cloud_admin_token'])",
        "SESSION_CIPHER_KEY_B64=$($cloud['session_cipher_key_b64'])",
        "VAPID_PRIVATE_KEY=$($cloud['vapid_private_key'])",
        "VAPID_SUBJECT=$($cloud['vapid_subject'])"
    ) -join "`n"
    Write-NoBom $ghSecretsPath ($ghSecretsText + "`n")
    try {
        & $script:Gh secret set -f $ghSecretsPath --repo $repoFull
        if ($LASTEXITCODE -ne 0) { throw "GitHub Actions secrets could not be configured." }
    } finally {
        Remove-Item $ghSecretsPath -Force -ErrorAction SilentlyContinue
    }

    # The monthly keepalive workflow needs write permission to commit one tiny
    # heartbeat file so GitHub does not disable schedules after long inactivity.
    & $script:Gh api --method PUT -H "Accept: application/vnd.github+json" "/repos/$repoFull/actions/permissions/workflow" -f default_workflow_permissions=write -F can_approve_pull_request_reviews=false --silent
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Warning: could not set default workflow permission to write. Timetable sync still works; the monthly keepalive may need manual permission later." -ForegroundColor Yellow
    }

    Step "Run the first cloud catalogue sync"
    & $script:Gh workflow run sync.yml --repo $repoFull
    if ($LASTEXITCODE -ne 0) { throw "Could not start the first GitHub sync workflow." }

    $runId = $null
    for ($i = 0; $i -lt 12 -and -not $runId; $i++) {
        Start-Sleep -Seconds 3
        $runId = ((& $script:Gh run list --repo $repoFull --workflow sync.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null | Out-String).Trim())
    }
    if ($runId) {
        Write-Host "Waiting for the first catalogue run to finish. This first run is the slowest because Chromium is prepared once." -ForegroundColor DarkGray
        & $script:Gh run watch $runId --repo $repoFull --exit-status
        $firstRunOk = ($LASTEXITCODE -eq 0)
    } else {
        $firstRunOk = $false
    }

    if ($firstRunOk) {
        try {
            $catalog = Invoke-JsonGet -Uri ($cloudUrl + '/api/catalog') -Attempts 3
            $departmentCount = @($catalog.departments).Count
            Write-Host "Cloud catalogue ready: $departmentCount department(s)." -ForegroundColor Green
        } catch {
            Write-Host "First workflow passed, but the catalogue check could not be read yet." -ForegroundColor Yellow
        }
    } else {
        Write-Host "The site is deployed, but the first GitHub sync did not finish successfully. Open the Actions link printed below to inspect/re-run it." -ForegroundColor Yellow
    }

    Write-Host "`n============================================================" -ForegroundColor Green
    Write-Host " TUS COMPANION CLOUD IS DEPLOYED" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "Public app : $cloudUrl" -ForegroundColor White
    Write-Host "Health     : $cloudUrl/health" -ForegroundColor White
    Write-Host "GitHub     : https://github.com/$repoFull" -ForegroundColor White
    Write-Host "Actions    : https://github.com/$repoFull/actions" -ForegroundColor White
    Write-Host "`nYour PC is no longer required to keep the public app online." -ForegroundColor Green
    Write-Host "If the TUS source session expires later, run: .\RECONNECT-AND-PUBLISH.ps1" -ForegroundColor Cyan
    Write-Host "Do not share .cloud.local.json, TUS session files, GitHub secrets, or Cloudflare secrets." -ForegroundColor DarkGray
}
catch {
    Write-Host "`nGO-LIVE stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Nothing sensitive was intentionally printed. Fix the indicated step and run .\GO-LIVE.ps1 again; the script is designed to reuse what was already created." -ForegroundColor Yellow
    exit 1
}
