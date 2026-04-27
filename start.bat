@echo off
chcp 65001 >nul
title XAlive Lite

for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('PATH','Machine')"') do set "MACHINE_PATH=%%i"
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('PATH','User')"') do set "USER_PATH=%%i"
set "PATH=%MACHINE_PATH%;%USER_PATH%"

echo.
echo  ======================================
echo       XAlive Lite đang khởi động
echo  ======================================
echo.
echo  Mo: http://localhost:4111
echo  Backend cũ trên port 4111 sẽ được dừng trước.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
if errorlevel 1 pause & exit /b 1
