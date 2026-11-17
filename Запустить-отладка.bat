@echo off
chcp 65001 >nul
title ЛС — Discord / Telegram - отладка
cd /d "%~dp0"
call "node_modules\.bin\electron.cmd" .
echo.
echo Приложение закрыто. Код выхода: %errorlevel%
pause
