@echo off
rem Abre Bajalo. Necesita Node.js (https://nodejs.org).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   No se encontro Node.js. Instalalo desde https://nodejs.org y volve a intentar.
    echo.
    pause
    exit /b 1
)

node "app\server.js"
if errorlevel 1 pause
