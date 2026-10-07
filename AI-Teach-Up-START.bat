@echo off
title AI Teach-Up START
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-consoles.ps1"
if errorlevel 1 (
  echo.
  echo Failed to start AI Teach-Up.
  pause
)
