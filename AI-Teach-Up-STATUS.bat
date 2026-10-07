@echo off
title AI Teach-Up STATUS
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\show-status.ps1"
echo.
pause
