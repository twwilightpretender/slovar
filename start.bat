@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Сервер словаря: http://127.0.0.1:8742/  (закройте это окно, чтобы остановить)
start "" "http://127.0.0.1:8742/"
call npm run dev
