$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\backend"
& ".\.venv\Scripts\python.exe" -m app.cli login
