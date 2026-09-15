"use strict";

/**
 * 真实环境全量爬题（10 万题目标·供给端）。
 * 顺序爬四分类全部页码，断点续爬，入库到应用真实题库（运行缓存/bank.json）。
 * 用法：node scripts/live-crawl-all.js [情感类,教育类,综合类,人物类]
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "运行缓存");
const logFile = path.join(dataDir, "logs", "live-crawl.log");

const { Config } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { TaskManager } = require("../electron/src/tasks/manager");
const { runCrawlTask } = require("../electron/src/tasks/crawl");

const categories = (process.argv[2] || "情感类,教育类,综合类,人物类").split(",");

(async () => {
  const config = new Config(dataDir);
  config.save({
    closeAfter: false,          // 分类之间保持环境打开
    crawlStartPage: 1,          // 题库去重会跳过已入库题
    pageDelayMs: 1500,          // 翻页间隔
    maxQuestions: 1000000,      // 不限量：目标是全量
  });
  const store = new Store(dataDir);
  const browserPool = new BrowserPool(createAdapter({ apiUrl: "http://127.0.0.1:54345" }));
  const manager = new TaskManager();

  const log = (message) => {
    const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      /* 忽略 */
    }
  };

  log(`=== 全量爬题启动：${categories.join("、")} ===`);
  let grandTotal = 0;
  for (const category of categories) {
    if (manager.isRunning()) break;
    log(`--- 分类：${category} ---`);
    try {
      await manager.start("crawl", {
        bitEnvs: [{ label: "测试组1" }],
        category,
        crawlStartPage: 1,
        resume: false, // 题库级去重已足够；页级断点由 crawlOutput 内部进度维护
        pageDelayMs: 1500,
      }, async (ctx) => runCrawlTask(ctx, { browserPool, store, config, log, copy: async () => {} }));
    } catch (error) {
      log(`分类 ${category} 爬取异常：${error.message}`);
    }
    grandTotal = store.bankSize();
    log(`累计题库：${grandTotal} 条`);
  }
  await browserPool.closeAll().catch(() => {});
  log(`=== 全量爬题结束：题库总计 ${store.bankSize()} 条 ===`);
  process.exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  process.exit(1);
});
