@echo off
rem Keep this file ASCII-only on purpose: cmd.exe reads .cmd using the system
rem codepage, so non-ASCII text here risks mojibake. All user-facing Chinese
rem output comes from tools/launcher.mjs -- Node writes to the console via
rem WriteConsoleW, which is codepage-independent.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [ERROR] Node.js not found.
    echo   Please install Node.js 18 or newer: https://nodejs.org
    echo.
    pause
    exit /b 1
)

node "%~dp0tools\launcher.mjs" %*
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
    echo.
    echo   Launcher exited with code %EXITCODE%
    echo.
    pause
)

endlocal
