@echo off
rem ASCII-only on purpose -- see the note in start.cmd
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

node "%~dp0tools\launcher.mjs" test
set EXITCODE=%errorlevel%

echo.
if "%EXITCODE%"=="0" (
    echo   All test suites passed.
) else (
    echo   Some tests failed - see the output above.
)

echo.
pause

endlocal
