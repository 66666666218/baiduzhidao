"use strict";

/**
 * 按题材分账号上传（CLI）：上传专用表 → 按分类规则给每行派生题材 → 拆给各账号 → 投递到答主工作台。
 *
 * 用法：node scripts/upload-by-topic.js <上传专用表.xlsx> [每批行数=500] [批数上限=999]
 *
 * 账号列表、账号题材绑定、分类规则全部读 运行缓存/settings.json——与软件设置页共用同一份配置，
 * 这样 GUI 里配好一次，跑批脚本不用再抄一遍参数。
 *
 * 与 daily-batch.js 一样，退出前必须 flush：Store 是防抖写盘，直接 process.exit 会丢最后几条。
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "运行缓存");
const srcFile = String(process.argv[2] || "").trim().replace(/^"|"$/g, "");
const batchRows = Math.max(1, Number(process.argv[3]) || 500);
const maxBatches = Math.max(1, Number(process.argv[4]) || 999);

if (!srcFile || !fs.existsSync(srcFile)) {
  console.error("用法: node scripts/upload-by-topic.js <上传专用表.xlsx> [每批行数=500] [批数上限=999]");
  console.error(`（给定的表格不存在：${srcFile || "未填写"}）`);
  process.exit(1);
}

const { Config } = require("../electron/src/config");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { runTopicUploadTask } = require("../electron/src/tasks/upload-batch");

const log = (message) => {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(dataDir, "logs", "upload-by-topic.log"), line + "\n", "utf8");
  } catch {
    /* 日志写不进去不影响上传 */
  }
};

(async () => {
  const config = new Config(dataDir);
  const settings = config.load();

  const bitEnvs = (settings.bitEnvs || []).map((env) => env.label || env).filter(Boolean);
  if (!bitEnvs.length) {
    log("设置里的「比特环境名称」为空，无法上传。请先在软件设置页填写账号。");
    process.exit(1);
  }
  const topicMap = settings.accountTopics || {};
  if (!Object.keys(topicMap).length) {
    log("没有账号绑定题材：请到软件设置页「账号题材绑定」按「账号=题材」填好（题材名要与分类规则里的分类名一致）。");
    process.exit(1);
  }
  if (!String(settings.topicRules || "").trim()) {
    log("设置里的「上传分类规则」为空，无法拆分上传表。");
    process.exit(1);
  }

  const browserPool = new BrowserPool(createAdapter({ apiUrl: settings.apiUrl }));
  const ctx = {
    payload: {},
    livePayload: () => ({
      filePath: srcFile,
      bitEnvs,
      accountTopics: topicMap,
      topicRules: settings.topicRules,
      batchRows,
      maxBatches,
    }),
    shouldStop: () => false,
    shouldPause: () => false,
    pausePoint: async () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };

  const result = await runTopicUploadTask(ctx, { browserPool, log, dataDir });
  log(`=== 按题材上传结束：共 ${result.uploaded} 行，涉及 ${(result.accounts || []).length} 个账号 ===`);
  for (const account of result.accounts || []) {
    log(`  ${account.envLabel}（${account.topic || "未绑定"}）：${account.error ? `失败 ${account.error}` : `上传 ${account.uploaded} 行`}`);
  }
  if ((result.topicTables || []).length) {
    log(`题材分表已保存到：${result.splitDir}`);
    for (const table of result.topicTables) log(`  ${table.topic} → ${table.file}`);
  }
  process.exit(result.uploaded > 0 ? 0 : 1);
})().catch((error) => {
  console.error("FATAL:", error.message);
  if (error.stack) console.error(error.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
