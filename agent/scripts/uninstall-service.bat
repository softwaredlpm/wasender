@echo off
setlocal
echo =====================================================
echo     WASENDER Windows Agent - Service Uninstaller
echo =====================================================
echo.

schtasks /delete /tn "WASENDER-Agent" /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [SUCCESS] WASENDER-Agent background task has been removed.
) else (
    echo.
    echo [ERROR] Failed to remove task or task did not exist.
)
pause
