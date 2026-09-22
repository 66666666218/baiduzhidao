# CHANGELOG

- [2026-09-22 13:05] FIX: 断点恢复 meta 回填崩溃 + 转存 referer 指向分享页；判定账号处于转存封禁期（errno=2 全量复现，与请求形态无关） (Files: scripts/pan-transfer-pipeline.js, electron/src/netdisk/transfer.js, docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 12:10] FEAT: netdisk-share-existing.js——网盘已有资源免转存直接自有分享并生成上传专用表（8/8成功，公网验证通过） (Files: scripts/netdisk-share-existing.js, docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 11:25] FIX: 转存协议按真UI抓包校准（fsidlist+type=1，sekey/bdstoken走query）——errno=2真因是账号超容(-171.5GB，百度误报"文件已存在")；管线新增容量预检与复检 (Files: electron/src/netdisk/transfer.js, scripts/pan-transfer-pipeline.js, docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 06:30] FEAT: 转存确权管线一键全转（五阶段并发批处理+断点+风控自愈）+ transfer.js 执行器架构（浏览器上下文过风控/POST verify/shorturl list）+ qa-template-lib 共享库重构 (Files: scripts/pan-transfer-pipeline.js, scripts/qa-template-lib.js, scripts/mass-qa-template.js, electron/src/netdisk/transfer.js, docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 05:10] FEAT: mass-qa-template.js 按 user 答题模板批量生成问答——4万资源→39402条合格（8分片），命名解析/标题轮换/规则化简介/质量门槛 (Files: scripts/mass-qa-template.js, 运行缓存/答题模板QA/(gitignore), docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 04:15] CHORE: 提交总量放开——开发版配置 accountDailyLimit=0/maxQuestionsPerEnv=500，实测设100传100（2/3账号验证）；打包版配置未动 (Files: 运行缓存/settings.json(gitignore), docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 03:55] FIX: 自动提交多账号时总量被爬题参数隐蔽截断为10条——提交容量改由「每账号每日限额」单独控制，新增回归单测（146全过） (Files: electron/src/tasks/submit.js, tests/unit/core.test.js, docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 02:48] FEAT: panlay 采集器 panlay-collect.js（投稿流免配额翻页+关键词搜索配额管理，实测入库16条）+ 共享库 pan-library.js + pan-crawl-batch 重写为 pansou API 直连版（词池1078/退避/0结果重试）+ 修复 pan-to-qa「undefined」历史bug + 主库清洗57条脏名 (Files: scripts/panlay-collect.js, scripts/pan-library.js, scripts/pan-crawl-batch.js, scripts/pan-to-qa.js, docs/自审日志.md, CHANGELOG.md)
- [2026-09-22 02:21] FEAT: 网盘资源供给链路——pan-crawl-batch.js 批量采集器（183关键词池/去重/断点续爬/限速/质量预过滤，冒烟实测单关键词入库34条）+ panlay.com 登录链路（headed-edge-launcher.js 持久会话/panlay-login.js/panlay-explore.js，实测登录成功 Lv3） (Files: scripts/pan-crawl-batch.js, scripts/panlay-login.js, scripts/panlay-explore.js, electron/src/headed-edge-launcher.js, electron/src/edge-launcher.js, README.md, docs/自审日志.md)
