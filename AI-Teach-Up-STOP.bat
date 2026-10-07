@echo off
title AI Teach-Up STOP
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-consoles.ps1"
echo.
ping 127.0.0.1 -n 3 >nul
