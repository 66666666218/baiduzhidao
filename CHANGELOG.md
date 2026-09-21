# CHANGELOG

- [2026-09-22 02:48] FEAT: panlay 采集器 panlay-collect.js（投稿流免配额翻页+关键词搜索配额管理，实测入库16条）+ 共享库 pan-library.js + pan-crawl-batch 重写为 pansou API 直连版（词池1078/退避/0结果重试）+ 修复 pan-to-qa「undefined」历史bug + 主库清洗57条脏名 (Files: scripts/panlay-collect.js, scripts/pan-library.js, scripts/pan-crawl-batch.js, scripts/pan-to-qa.js, docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 02:21] FEAT: 网盘资源供给链路——pan-crawl-batch.js 批量采集器（183关键词池/去重/断点续爬/限速/质量预过滤，冒烟实测单关键词入库34条）+ panlay.com 登录链路（headed-edge-launcher.js 持久会话/panlay-login.js/panlay-explore.js，实测登录成功 Lv3） (Files: scripts/pan-crawl-batch.js, scripts/panlay-login.js, scripts/panlay-explore.js, electron/src/headed-edge-launcher.js, electron/src/edge-launcher.js, README.md, docs/自审日志.md)
