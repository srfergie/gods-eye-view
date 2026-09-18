@echo off
rem ============================================================
rem  God's Eye View - one-click launcher (Windows)
rem  Double-click this file to start the app and open it.
rem  The server window stays open; close it to stop the app.
rem ============================================================
setlocal
cd /d "%~dp0"

rem Port comes from .env (PORT=5180). Change here if you change .env.
set "GEV_PORT=5180"

rem Check Node is available.
where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js / npm was not found on your PATH.
  echo Install Node 24.14+ from https://nodejs.org and try again.
  pause
  exit /b 1
)

rem Install dependencies on first run (skipped if already present).
if not exist "node_modules" (
  echo First run: installing dependencies, please wait...
  call npm ci
)

echo Starting God's Eye View server on http://localhost:%GEV_PORT%
start "God's Eye View server" cmd /k npm run dev

rem Give the dev server a few seconds to come up, then open the browser.
timeout /t 6 /nobreak >nul
start "" "http://localhost:%GEV_PORT%"

endlocal
