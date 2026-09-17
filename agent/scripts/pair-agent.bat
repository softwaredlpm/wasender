@echo off
setlocal
title WASENDER Agent - Pair Device
echo =====================================================
echo     WASENDER Windows Agent - Device Pairing
echo =====================================================
echo.
echo Please enter the 8-character pairing code from your
echo WASENDER Web Dashboard (e.g. WAS-A1B2C3D4):
echo.
set /p PAIR_CODE="Pairing Code: "

if "%PAIR_CODE%"=="" (
    echo [ERROR] No pairing code entered.
    pause
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"
set "AGENT_EXE=%SCRIPT_DIR%..\dist\WASENDER-Agent.exe"

if exist "%AGENT_EXE%" (
    "%AGENT_EXE%" --pair %PAIR_CODE%
) else (
    cd /d "%SCRIPT_DIR%.."
    node src/index.js --pair %PAIR_CODE%
)

echo.
pause
