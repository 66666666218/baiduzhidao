@echo off
chcp 65001 >nul
title 百度知道答题助手 v2 - 每日跑批（爬题 + 生成 + 提交 + 按题材上传）
cd /d "%~dp0"

rem 这条链是无人值守的完整跑批：爬题 → 抽题生成 → 提交 → 按题材分账号上传。
rem 提交环节由 运行缓存\settings.json 里的「自动提交」开关决定；开关为关时只生成不提交。
rem 上传环节由下面的 UPLOAD_TABLE 决定；留空则跳过。

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
echo 结果可在软件里查看（开发模式读 运行缓存；打包版读 %AppData% 是另一份数据）。
pause
