@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator privileges...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if "%~1"=="" (
  set /p DOMAIN=Domain (example: rank.example.com): 
) else (
  set "DOMAIN=%~1"
)

if "%~2"=="" (
  set /p EMAIL=Email: 
) else (
  set "EMAIL=%~2"
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-windows.ps1" -Domain "%DOMAIN%" -Email "%EMAIL%"
if errorlevel 1 pause
pause
