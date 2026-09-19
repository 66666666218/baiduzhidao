@echo off
chcp 65001 >nul
title 百度知道答题助手 v2 - 展示站
cd /d "%~dp0.."
echo ============================================
echo   百度知道答题助手 v2 - 展示站启动中
echo   浏览器访问: http://127.0.0.1:8930
echo   按 Ctrl+C 停止
echo ============================================
start "" http://127.0.0.1:8930
node site/server.js
pause
