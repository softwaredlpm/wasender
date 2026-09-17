@echo off
setlocal
title WASENDER Windows Agent
echo =====================================================
echo     WASENDER Windows Agent - Local Service
echo     Local BUSY Accounting ^& WhatsApp Automation
echo =====================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "AGENT_EXE=%SCRIPT_DIR%..\dist\WASENDER-Agent.exe"

if exist "%AGENT_EXE%" (
    echo [OK] Found packaged agent: %AGENT_EXE%
    "%AGENT_EXE%" %*
) else (
    echo [INFO] Running in development mode using Node.js...
    cd /d "%SCRIPT_DIR%.."
    node src/index.js %*
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Agent exited with code %ERRORLEVEL%
    pause
)
