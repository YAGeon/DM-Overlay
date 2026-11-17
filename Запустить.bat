@echo off
chcp 65001 >nul
title ЛС — Discord / Telegram
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Первый запуск: устанавливаю зависимости, это займёт минуту...
  call npm.cmd install --no-audit --no-fund
  call npm.cmd install-scripts approve electron >nul 2>&1
  call npm.cmd rebuild electron >nul 2>&1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo Не удалось установить Electron. Проверь интернет и запусти файл ещё раз.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" .
