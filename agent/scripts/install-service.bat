@echo off
setlocal
echo =====================================================
echo     WASENDER Windows Agent - Service Installer
echo =====================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "AGENT_EXE=%SCRIPT_DIR%..\dist\WASENDER-Agent.exe"

if not exist "%AGENT_EXE%" (
    set "AGENT_EXE=%SCRIPT_DIR%..\src\index.js"
    echo [NOTICE] Packaged executable not found in dist\.
    echo Configuring Task Scheduler with node %AGENT_EXE%...
    schtasks /create /tn "WASENDER-Agent" /tr "node \"%AGENT_EXE%\"" /sc onlogon /rl highest /f
) else (
    echo [OK] Registering %AGENT_EXE% with Windows Task Scheduler...
    schtasks /create /tn "WASENDER-Agent" /tr "\"%AGENT_EXE%\"" /sc onlogon /rl highest /f
)

if %ERRORLEVEL% EQU 0 (
    echo.
    echo =====================================================
    echo [SUCCESS] WASENDER-Agent background task installed!
    echo It will start automatically when any user logs in.
    echo To start it immediately, run:
    echo   schtasks /run /tn "WASENDER-Agent"
    echo =====================================================
) else (
    echo.
    echo [ERROR] Failed to register task. Please run this script as Administrator.
)
pause
