@echo off
rem ============================================================
rem  Gallery launcher
rem
rem    double-click          -> menu: pick the folder to browse
rem                              1,2,3...  remembered folders
rem                              N         browse for a new folder (dialog)
rem                              Q         quit
rem    drag a folder onto it -> open that folder directly
rem    with arguments        -> start-gallery.cmd "D:\Photos" --rebuild
rem
rem  The folder list lives in  folders.json  next to this file:
rem  edit it by hand any time; folders you open are added automatically.
rem
rem  Options: --rebuild (force rebuild the dataset)
rem           --no-open (do not launch the browser)
rem           --port N  (use a specific port, default 8420)
rem           --menu    (force the menu even when input is piped)
rem           --list    (just print the folder list and exit)
rem           --debug   (verbose logging: progress, hot reload, client events)
rem           --quiet   (only errors)
rem
rem  Logging: default level is "info". Set GALLERY_LOG=debug|info|warn|error
rem  for the same effect without command line flags.
rem
rem  Keep this file ASCII-only: cmd.exe parses .cmd with the OEM code
rem  page, so non-ASCII characters here can break the script.
rem ============================================================
title Gallery
setlocal
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

node build\launch.js %*

echo.
pause
