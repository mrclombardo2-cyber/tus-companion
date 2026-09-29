TUS Companion Cloud v14.2 hotfix

Fixes GO-LIVE.ps1 stopping at "Create/reuse the public GitHub repository" when
GitHub correctly reports that a candidate repository does not yet exist.

Install:
1. Copy GO-LIVE.ps1 to the project root.
2. Replace the existing file.
3. Run .\GO-LIVE.ps1 again.

Existing Cloudflare Worker, D1 database, encrypted TUS session and local .git are reused.
