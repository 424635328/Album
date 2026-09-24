@echo off
rem ============================================================
rem  Gallery - STOP all running gallery server instances.
rem  The server auto-increments ports (8420..8440) when busy, so
rem  stale instances from earlier runs are cleaned up as well.
rem  Keep this file ASCII-only: cmd.exe parses .cmd with the OEM
rem  code page, so non-ASCII text here can break the script.
rem ============================================================
title Gallery - stopping server
cd /d "%~dp0"
chcp 65001 >nul

where pwsh >nul 2>nul
if errorlevel 1 (
  rem fall back to Windows PowerShell when pwsh is unavailable
  powershell -NoProfile -ExecutionPolicy Bypass -File "build\stop-server.ps1"
) else (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "build\stop-server.ps1"
)

echo.
pause
