TUS Companion Cloud v14.3 hotfix

Fixes GO-LIVE.ps1 stopping on:
  error: No such remote 'origin'

Cause: PowerShell promoted Git's expected stderr to a terminating error when
origin had not been created yet. The script now checks whether the remote exists
before reading it.

Install:
1. Copy GO-LIVE.ps1 over the existing file in the project root.
2. Run from the project root:
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\GO-LIVE.ps1

Existing Cloudflare/D1/session/Git state is reused. Do not delete .git or any
session/data folders.
