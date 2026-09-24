@echo off
REM ============================================================================
REM  Flickr-Gallery test runner  (ASCII only - cmd.exe mangles CJK here)
REM
REM    test-gallery.cmd            run every suite
REM    test-gallery.cmd smoke      regression suite only      (fast, ~40s)
REM    test-gallery.cmd events     full event coverage suite  (~8 min)
REM
REM  Both suites need the gallery server: start it first with start-gallery.cmd
REM  (the regression suite checks the server routes as well as the file:// page).
REM ============================================================================
setlocal
cd /d "%~dp0build"

set MODE=%~1
if "%MODE%"=="" set MODE=all

if /i "%MODE%"=="all"    goto :all
if /i "%MODE%"=="smoke"  goto :smoke
if /i "%MODE%"=="events" goto :events

echo Unknown suite: %MODE%
echo Usage: test-gallery.cmd [all^|smoke^|events]
exit /b 2

:smoke
echo.
echo === Regression suite (build\smoke.js) ===
node smoke.js
exit /b %errorlevel%

:events
echo.
echo === Event coverage + latency budgets (build\events-test.js) ===
node events-test.js
exit /b %errorlevel%

:all
echo.
echo === 1/2  Regression suite (build\smoke.js) ===
node smoke.js
if errorlevel 1 (
  echo.
  echo REGRESSION SUITE FAILED - stopping.
  exit /b 1
)
echo.
echo === 2/2  Event coverage + latency budgets (build\events-test.js) ===
node events-test.js
if errorlevel 1 (
  echo.
  echo EVENT SUITE FAILED.
  exit /b 1
)
echo.
echo ALL SUITES PASSED
exit /b 0
