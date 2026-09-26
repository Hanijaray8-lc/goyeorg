@echo off
title Goyee Backend Server Daemon
cd /d "%~dp0"
:loop
echo [%date% %time%] Starting Goyee Backend Server...
node Server.js
echo [%date% %time%] Server stopped. Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto loop
