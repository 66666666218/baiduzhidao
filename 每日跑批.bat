@echo off
chcp 65001 >nul
title 百度知道答题助手 v2 - 每日跑批（爬题 + 生成 + 提交 + 按题材上传）
cd /d "%~dp0"

rem 这条链是无人值守的完整跑批：爬题 → 抽题生成 → 提交 → 按题材分账号上传。
rem 提交环节由「数据目录」里的 settings.json 的「自动提交」开关决定；开关为关时只生成不提交。
rem 上传环节由下面的 UPLOAD_TABLE 决定；留空则跳过。

rem ── 数据目录 ─────────────────────────────────────────────────────────
rem 和 JS 侧保持同一套规则（见 electron\src\data-dir.js）：
rem   ZHIDAO_DATA_DIR 有值 → 用它；没设 → 用项目里的 运行缓存（开发模式数据）。
rem 想直接读到打包版（安装到 C 盘那个）的数据，就先把下面这行取消注释、指到 %APPDATA%：
rem   set "ZHIDAO_DATA_DIR=%APPDATA%\zhidao-answer-studio"
rem 注意 运行缓存\ 是 .gitignore 忽略的，**新电脑 clone 下来没有这个目录** —— 下面会自动建。
set "DATA_DIR=运行缓存"
if not "%ZHIDAO_DATA_DIR%"=="" set "DATA_DIR=%ZHIDAO_DATA_DIR%"

rem 比特环境名（建议留空）：留空 = 沿用软件设置页里的账号列表。
rem   若填写：爬题只用第一个（只读，一个号够用），提交用全部（逗号分隔可写多个）。
rem   提交时还会按设置页的「账号题材绑定」把带链接的答案严格一对一投递。
set "ZHIDAO_BIT_ENV="
rem 每个分类单次爬取上限；全量爬题把它调大或删掉这行
set "ZHIDAO_MAX_QUESTIONS=500"
rem 每批生成的回答条数
set "GENERATE_COUNT=20"
rem 第 3 步「按题材分账号上传」用的上传专用表（xlsx）。
rem   留空 = 跳过该步。表里哪几行归哪个账号，由设置页的「上传分类规则」+「账号题材绑定」决定。
set "UPLOAD_TABLE="

if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"
set "RUN_LOG=%DATA_DIR%\logs\跑批_%date:~0,4%%date:~5,2%%date:~8,2%.log"

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

if "%UPLOAD_TABLE%"=="" (
  echo [%date% %time%] === 第 3 步：已跳过（UPLOAD_TABLE 未设置）=== >> "%RUN_LOG%"
) else (
  echo [%date% %time%] === 第 3 步：按题材分账号上传（%UPLOAD_TABLE%）=== >> "%RUN_LOG%"
  node scripts\upload-by-topic.js "%UPLOAD_TABLE%" >> "%RUN_LOG%" 2>&1
  if errorlevel 1 (
    echo [%date% %time%] 按题材上传有失败（详见 %RUN_LOG%），跑批其余步骤已完成。
  )
)

echo [%date% %time%] === 跑批结束，日志见 %RUN_LOG% ===
echo 结果可在软件里查看。本次数据目录：%DATA_DIR%
echo   （开发模式默认是项目里的 运行缓存；打包版读 %AppData%\zhidao-answer-studio，是**另一份**数据。
echo     想让脚本直接读写打包版那份，请设 ZHIDAO_DATA_DIR 指过去。）
pause
