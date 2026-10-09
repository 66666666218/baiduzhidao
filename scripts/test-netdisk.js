"use strict";

/**
 * 网盘链实操测试：搜资源 → 转存 → 按题材拆表 → 上传 → 查收录。
 *
 * 用项目自己的任务函数，作用在打包版数据目录上。
 * 账号题材绑定与搜索词用参数指定（不动用户配置——他们的绑定表名字对不上）。
 *
 * 用法：node scripts/test-netdisk.js [条数=10]
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
// 数据目录：优先 ZHIDAO_DATA_DIR（与 scripts/live-crawl-all.js 同一约定），
// 否则用打包版的默认位置。**不要写死本机路径**——这套要拿到新电脑新环境跑。
const dataDir = process.env.ZHIDAO_DATA_DIR
  ? path.resolve(process.env.ZHIDAO_DATA_DIR)
  : path.join(process.env.APPDATA || "", "zhidao-answer-studio");
const limit = Math.max(1, Number(process.argv[2]) || 10);
const ENV = process.env.TEST_ENV || "测试组1";
const TOPIC = process.env.TEST_TOPIC || "游戏";
const KEYWORDS = (process.env.TEST_KEYWORDS || "游戏 网盘,手游 网盘").split(",").map((s) => s.trim()).filter(Boolean);

const { Config } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { TaskManager } = require("../electron/src/tasks/manager");
const { runBatchTransferTask } = require("../electron/src/tasks/batch-transfer");
const { runTopicUploadTask } = require("../electron/src/tasks/upload-batch");
const { crawlSearchResources } = require("../electron/src/netdisk/search-crawler");
const workbench = require("../electron/src/netdisk/workbench");
const excel = require("../electron/src/storage/excel");

let storeRef = null;
let exiting = false;
const exit = (code) => {
  if (exiting) return;
  exiting = true;
  try { if (storeRef) storeRef.flushAll(); } catch { /* 忽略 */ }
  try { if (storeRef) storeRef.releaseLock(); } catch { /* 忽略 */ }
  process.exit(code);
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => exit(1));

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

(async () => {
  const config = new Config(dataDir);
  const settings = config.load();
  const store = new Store(dataDir, { owner: "cli:test-netdisk" });
  storeRef = store;
  store.assertExclusive("test-netdisk 网盘链测试");
  const browserPool = new BrowserPool(createAdapter({ apiUrl: settings.apiUrl }));
  const log = (m) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${m}`);
  const manager = new TaskManager();
  const accountTopics = { [ENV]: TOPIC };

  log(`环境 ${ENV} | 题材 ${TOPIC} | 关键词 ${KEYWORDS.join("、")} | 上限 ${limit} 条`);

  // ---------- 1) 搜资源（纯协议，不开浏览器）----------
  log("=== 1/5 搜资源（纯协议）===");
  const search = await crawlSearchResources({ keywords: KEYWORDS, pages: 1, limit, onLog: log });
  log(`搜到 ${search.rows.length} 条（去重后）`);
  if (!search.rows.length) { log("没搜到资源，停止。"); exit(1); }

  const resTable = path.join(dataDir, "搜资源", `测试_资源表_${stamp()}.xlsx`);
  fs.mkdirSync(path.dirname(resTable), { recursive: true });
  const resRows = search.rows.map((r) => ({ 资源名: r.name, 链接: r.link, 提取码: r.pwd, 问题链接: r.questionUrl, 来源关键词: r.source }));
  excel.writeWorkbook(resTable, resRows, "搜资源", ["资源名", "链接", "提取码", "问题链接", "来源关键词"]);
  log(`资源表：${resTable}（${resRows.length} 行）`);

  // ---------- 2) 转存 ----------
  log("=== 2/5 转存（表驱动纯协议）===");
  const xfer = await manager.start("batch-transfer", {
    filePath: resTable,
    bitEnvs: [ENV],
    destDir: "/来自资源批量转存",
    outName: `测试_上传专用表_${stamp()}`,
    perEnv: 50, cc: 2, delayMin: 1, delayMax: 2, makeShare: true,
  }, async (ctx) => runBatchTransferTask(ctx, { browserPool, store, config, log, dataDir }));
  log(`转存完成：成功 ${xfer.count} 条，失败 ${xfer.failed} 条 | 上传专用表：${xfer.outputPath}`);
  if (!xfer.outputPath || !fs.existsSync(xfer.outputPath)) { log("没有产出上传专用表，停止。"); exit(1); }

  // ---------- 3) 按题材拆表 + 上传 ----------
  log("=== 3/5 按题材拆表并上传 ===");
  const upload = await manager.start("upload-by-topic", {
    filePath: xfer.outputPath,
    bitEnvs: [ENV],
    accountTopics,
    topicRules: settings.topicRules,
    batchRows: 500,
    maxBatches: 999,
  }, async (ctx) => runTopicUploadTask(ctx, { browserPool, log, dataDir }));
  log(`上传完成：${upload.uploaded} 行`);
  for (const a of upload.accounts || []) log(`  ${a.envLabel}（${a.topic}）：${a.error ? `失败 ${a.error}` : `上传 ${a.uploaded} 行`}`);
  if (upload.splitDir) log(`题材分表：${upload.splitDir}`);
  log(`提交前体检：${JSON.stringify(upload.preflight)}`);

  // ---------- 4) 等待平台审核 ----------
  log("=== 4/5 等待平台处理（60 秒）===");
  await new Promise((r) => setTimeout(r, 60000));

  // ---------- 5) 查收录 ----------
  log("=== 5/5 查收录（工作台接口）===");
  const handle = await browserPool.acquire(ENV);
  const chromium = require("playwright-core").chromium;
  const browser = await chromium.connectOverCDP(handle.cdpUrl);
  const cookies = await browser.contexts()[0].cookies(workbench.WB_HOST);
  await browser.close().catch(() => {});
  await browserPool.release(ENV, { close: false }).catch(() => {});
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const info = workbench.pickUserInfo(await workbench.fetchWorkbenchJson("/qa/api/bulkqa/userinfo", cookie));
  log(`账号 ${info.name} | 剩余额度 ${info.remainingQuota}`);
  const resp = await workbench.fetchWorkbenchJson("/qa/api/bulkqa/tasks?page=1&pageSize=5", cookie);
  const tasks = workbench.pickTaskList(resp);
  log(`最近 ${tasks.length} 个上传任务：`);
  for (const t of tasks) log(`  · ${workbench.formatTask(t)}`);

  await browserPool.closeAll().catch(() => {});
  log("=== 网盘链测试结束 ===");
  exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  if (error.stack) console.error(error.stack.split("\n").slice(0, 6).join("\n"));
  exit(1);
});
