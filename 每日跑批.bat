@echo off
chcp 65001 >nul
title 百度知道答题助手 v2 - 每日跑批（只爬题+生成，不提交）
cd /d "%~dp0"

rem 这一份是"供给端"自动化：先把四个分类的新题爬进 运行缓存\bank.json，
rem 再从题库里抽题生成回答写进 运行缓存\answers.json。
rem 提交环节由 运行缓存\settings.json 里的「自动提交」开关决定；
rem 该开关为关时，daily-batch 只生成不提交（脚本已按这个开关收口）。

rem 比特浏览器环境名（在软件设置页里填的那个名字），改这一行
set "ZHIDAO_BIT_ENV=测试组1"
rem 每个分类单次爬取上限；全量爬题把它调大或删掉这行
set "ZHIDAO_MAX_QUESTIONS=500"
rem 每批生成的回答条数
set "GENERATE_COUNT=20"

if not exist "运行缓存\logs" mkdir "运行缓存\logs"
set "RUN_LOG=运行缓存\logs\跑批_%date:~0,4%%date:~5,2%%date:~8,2%.log"

echo [%date% %time%] === 第 1 步：爬题（情感类、教育类、综合类、人物类）=== >> "%RUN_LOG%"
node scripts\live-crawl-all.js 情感类,教育类,综合类,人物类 >> "%RUN_LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] 爬题失败，已停止；生成步骤未执行。详见 %RUN_LOG%
  pause
  exit /b 1
)

echo [%date% %time%] === 第 2 步：抽题生成回答（%GENERATE_COUNT% 条）=== >> "%RUN_LOG%"
node scripts\daily-batch.js %GENERATE_COUNT% >> "%RUN_LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] 生成失败，详见 %RUN_LOG%
  pause
  exit /b 1
)

echo [%date% %time%] === 跑批结束，日志见 %RUN_LOG% ===
echo 结果可在软件里查看（开发模式读 运行缓存；打包版读 %AppData% 是另一份数据）。
pause
