@echo off
setlocal
cd /d "%~dp0"
echo.
echo ============================================================
echo  TUS COMPANION - RECOVER LIVE TIMETABLE SOURCE
echo ============================================================
echo.
echo A Microsoft/TUS window may open.
echo Complete only the normal sign-in / MFA if Microsoft asks.
echo Everything else is automatic.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0RECONNECT-AND-PUBLISH.ps1"
set code=%ERRORLEVEL%
echo.
if not "%code%"=="0" (
  echo Recovery did not complete. Keep this window open and copy the error.
) else (
  echo Recovery completed successfully.
)
echo.
pause
exit /b %code%
