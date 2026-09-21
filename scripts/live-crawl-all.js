"use strict";

/**
 * 真实环境全量爬题（10 万题目标·供给端）。
 * 顺序爬四分类全部页码，断点续爬，入库到应用真实题库（运行缓存/bank.json）。
 * 用法：node scripts/live-crawl-all.js [情感类,教育类,综合类,人物类]
 * 数据目录默认是项目里的 运行缓存（开发模式数据）；打包版界面读写的是 %AppData%\zhidao-answer-studio，
 * 想爬完直接在软件里看到，就设 ZHIDAO_DATA_DIR 指过去（两边题库互不相通，别爬错地方）。
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = process.env.ZHIDAO_DATA_DIR
  ? path.resolve(process.env.ZHIDAO_DATA_DIR)
  : path.join(root, "运行缓存");
const logFile = path.join(dataDir, "logs", "live-crawl.log");

const { Config } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { TaskManager } = require("../electron/src/tasks/manager");
const { runCrawlTask } = require("../electron/src/tasks/crawl");

const categories = (process.argv[2] || "情感类,教育类,综合类,人物类").split(",");
// 跑完要把这几项还原：这些键和 GUI 共用同一份 settings.json，
// 不还原就等于一次全量爬题把用户的应用设置永久改掉了（限量变成 100 万、翻页间隔变 1.5 秒…）。
const OVERRIDE_KEYS = ["closeAfter", "crawlStartPage", "pageDelayMs", "maxQuestions"];

// 全量爬题会临时覆写几项共用设置；这指向"撤销覆写"的函数，异常路径也要调用它。
let restoreFn = null;

(async () => {
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  const config = new Config(dataDir);
  const snapshot = {};
  const before = config.load();
  for (const key of OVERRIDE_KEYS) snapshot[key] = before[key];
  let store = null;
  const restore = () => {
    try {
      config.save(snapshot);
      if (store) store.releaseLock();
    } catch (error) {
      console.error("还原设置失败，请手动检查 运行缓存/settings.json：", error.message);
    }
  };
  restoreFn = () => {
    try {
      if (store) store.flushAll(); // 防抖尾部还压着最后几条入库记录，先落盘再放锁
    } catch {
      /* 落盘失败不掩盖原异常 */
    }
    restore();
  };
  process.on("SIGINT", () => { restoreFn(); process.exit(130); });
  process.on("SIGTERM", () => { restoreFn(); process.exit(143); });

  store = new Store(dataDir, { owner: "cli:live-crawl-all" });
  store.assertExclusive("live-crawl-all 全量爬题");
  // 环境和 API 地址跟着这份数据目录的设置走：写死 "测试组1" 的话，
  // 换一台机器/换一个环境名就只会报"找不到环境"，而用户在设置页明明配好了。
  const liveSettings = config.load();
  const envLabel = (process.env.ZHIDAO_BIT_ENV || (liveSettings.bitEnvs || [])[0]?.label || "").trim();
  if (!envLabel || envLabel === "[object Object]") {
    throw new Error(`这份数据目录（${dataDir}）里没有可用的比特环境名。在软件「设置」页填好环境名，或运行时带上 ZHIDAO_BIT_ENV=环境名。`);
  }
  const apiUrl = String(liveSettings.apiUrl || "http://127.0.0.1:54345").trim();
  // 默认全量；跑通链路时想少爬一点就设 ZHIDAO_MAX_QUESTIONS，不用改代码
  const maxQuestions = Math.max(1, Number(process.env.ZHIDAO_MAX_QUESTIONS) || 1000000);
  config.save({
    closeAfter: false,          // 分类之间保持环境打开
    crawlStartPage: 1,          // 题库去重会跳过已入库题
    pageDelayMs: 1500,          // 翻页间隔
    maxQuestions,               // 全量或限量
  });
  const browserPool = new BrowserPool(createAdapter({ apiUrl }));
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

  log(`=== 全量爬题启动：${categories.join("、")} · 数据目录 ${dataDir} · 环境 ${envLabel} · 每类上限 ${maxQuestions} ===`);
  let grandTotal = 0;
  const failedCategories = [];
  for (const category of categories) {
    if (manager.isRunning()) break;
    log(`--- 分类：${category} ---`);
    try {
      await manager.start("crawl", {
        bitEnvs: [{ label: envLabel }],
        category,
        crawlStartPage: 1,
        resume: false, // 题库级去重已足够；页级断点由 crawlOutput 内部进度维护
        pageDelayMs: 1500,
      }, async (ctx) => runCrawlTask(ctx, { browserPool, store, config, log, copy: async () => {} }));
    } catch (error) {
      failedCategories.push(category);
      log(`分类 ${category} 爬取异常：${error.message}`);
    }
    grandTotal = store.bankSize();
    log(`累计题库：${grandTotal} 条`);
  }
  await browserPool.closeAll().catch(() => {});
  log(`=== 全量爬题结束：题库总计 ${store.bankSize()} 条${failedCategories.length ? `，失败分类：${failedCategories.join("、")}` : ""} ===`);
  restoreFn();
  // 退出码要能反映失败：以前无论中间抛不抛异常都以 0 退出，调用方（计划任务/上层脚本）以为全成功。
  process.exit(failedCategories.length ? 1 : 0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  if (restoreFn) restoreFn(); // 覆写过的设置必须还原，最后一批入库也要落盘
  process.exit(1);
});
