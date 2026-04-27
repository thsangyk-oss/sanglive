@echo off
chcp 65001 >nul
title SangLive

for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('PATH','Machine')"') do set "MACHINE_PATH=%%i"
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('PATH','User')"') do set "USER_PATH=%%i"
set "PATH=%MACHINE_PATH%;%USER_PATH%"

echo.
echo  ======================================
echo       SangLive đang khởi động
echo  ======================================
echo.
echo  Mo: http://localhost:8788
echo  Backend cũ trên port 8788 sẽ được dừng trước.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
if errorlevel 1 pause & exit /b 1
