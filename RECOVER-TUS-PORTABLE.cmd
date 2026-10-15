@echo off
setlocal
color 0F
title TUS Companion - Reconnect university timetable
echo.
echo   TUS COMPANION - ONE-CLICK RECOVERY
echo   Preparing your authenticated browser and Cloudflare connection.
echo   GitHub and Microsoft may ask for official sign-in confirmation.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP 'tus-companion-recover.ps1'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/mrclombardo2-cyber/tus-companion/main/RECOVER-TUS-PORTABLE.ps1' -OutFile $p; & $p; if ($?) {exit 0} else {exit 1}"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo   Recovery needs attention. Review the error above.
if "%RESULT%"=="0" echo   Recovery completed. Open TUS Companion to confirm a fresh timetable.
echo.
pause
exit /b %RESULT%
