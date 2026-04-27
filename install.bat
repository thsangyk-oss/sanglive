@echo off
chcp 65001 >nul
title SangLive Install

where node >nul 2>nul
if errorlevel 1 (
  echo [LỖI] Chưa có Node.js. Cài Node.js 20 LTS trước.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 pause & exit /b 1

echo.
echo Cài đặt xong. Bấm shortcut SangLive ngoài Desktop để mở app.
pause
