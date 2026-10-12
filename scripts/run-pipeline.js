"use strict";

/**
 * 无人值守地跑「一键全自动」——走的是**真编排器**（src/workflows/auto-pipeline.js），
 * 任务函数也是真的（src/tasks/*），所以阶段报告、跳过原因、本轮产出清单、
 * 账号并发提示都跟你在软件里点「开始」完全一致。
 *
 * 用法：
 *   node scripts/run-pipeline.js                                  # 默认只跑网盘链（搜资源→转存→上传→查收录）
 *   node scripts/run-pipeline.js --stages=crawl,pick,generate,submit,transfer,upload
 *   node scripts/run-pipeline.js --stages=transfer --table=资源表.xlsx --per-env=10 --cc=2
 *   node scripts/run-pipeline.js --categories=情感类 --max-questions=5 --pick-count=5 --submit-limit=3
 *   ZHIDAO_DATA_DIR=xxx node scripts/run-pipeline.js
 *
 * `--set=k=v,k2=v2` 可以临时改设置项 —— **跑完会自动还原**，
 * 不会把你的设置留在被改过的状态（这一条是特意做的：脚本改用户设置又不还原，很容易让人莫名其妙）。
 *
 * ⚠️ 会上传/提交的内容**真的会发到平台**。先看清开头的"本次将做什么"。
 */

const path = require("path");
const { resolveDataDir } = require("../electron/src/data-dir");

const root = path.resolve(__dirname, "..");
const dataDir = resolveDataDir(root);

const { Config, CATEGORIES } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { Logger } = require("../electron/src/log");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { LlmClient } = require("../electron/src/llm/client");
const excel = require("../electron/src/storage/excel");
const fs = require("fs");
const { createAutoPipeline } = require("../electron/src/workflows/auto-pipeline");
const { resolveNetdiskRoles } = require("../electron/src/domain/account-topic");
const { AccountManager } = require("../electron/src/browser/account-manager");
const { parseAccountProxies, dispatcherFor } = require("../electron/src/netdisk/proxy");
const { credentialOf } = require("../electron/src/netdisk/manager");
const { makePickQuestions } = require("../electron/src/tasks/pick");
const { runCrawlTask } = require("../electron/src/tasks/crawl");
const { runGenerateTask } = require("../electron/src/tasks/generate");
const { runSubmitTask } = require("../electron/src/tasks/submit");
const { runSearchResourcesTask } = require("../electron/src/tasks/search-resources");
const { runCheckPublishedTask } = require("../electron/src/tasks/check-published");
const { runBatchTransferTask } = require("../electron/src/tasks/batch-transfer");
const { runTopicUploadTask } = require("../electron/src/tasks/upload-batch");

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? "true" : m[2]] : [a, "true"];
}));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

const config = new Config(dataDir);
const store = new Store(dataDir, { owner: "run-pipeline" });
const logger = new Logger(path.join(dataDir, "logs"));
const browserPool = new BrowserPool(createAdapter({ apiUrl: config.load().apiUrl }), {
  mode: () => (String(config.load().browserMode || "bit") === "headless" ? "headless" : "bit"),
  credentialOf: (envLabel) => credentialOf(dataDir, envLabel),
});
const accountManager = new AccountManager({ store, dailyLimit: 0 });
// 生成答案要用它（与 app-context 里同一套配置来源：设置页的 AI Key / 地址 / 模型），
// 用量也走同一个 store.addUsage 记账 —— 否则"今日 token 预算"在脚本里不生效。
const llm = new LlmClient({
  concurrency: config.load().aiConcurrency,
  apiKey: config.load().aiApiKey,
  baseUrl: config.load().aiBaseUrl,
  model: config.load().aiModel,
  systemPrompt: config.load().systemPrompt,
  maxTokens: config.load().aiMaxTokens,
  temperature: config.load().aiTemperature,
  onUsage: (entry) => store.addUsage(entry),
});

// ---- 临时改设置，跑完还原 ----
const overridden = {};
for (const kv of list(argv.set)) {
  const i = kv.indexOf("=");
  if (i < 0) continue;
  const key = kv.slice(0, i).trim();
  const value = num(kv.slice(i + 1).trim(), kv.slice(i + 1).trim());
  overridden[key] = config.load()[key];
  config.save({ [key]: value });
}
const restoreSettings = () => {
  const keys = Object.keys(overridden);
  if (!keys.length) return;
  config.save(overridden);
  console.log(`（已还原临时改动的设置：${keys.join("、")}）`);
};

const settings = config.load();
const bitEnvs = (settings.bitEnvs || []).map((e) => e.label || e).filter(Boolean);
if (!bitEnvs.length) throw new Error("设置里没有账号（bitEnvs 为空）：先在「账号凭证」把账号加进来。");

const proxies = parseAccountProxies(settings.accountProxies || "");
const deps = {
  config, store, dataDir, browserPool, accountManager, llm,
  log: (message) => { logger.log(message); console.log("   " + String(message).replace(/\n/g, "\n   ")); },
  credentialOf: (envLabel) => credentialOf(dataDir, envLabel),
  proxyOf: (envLabel) => { try { return dispatcherFor(proxies[envLabel]); } catch { return undefined; } },
  emitEvent: () => {},
  autosavePath: path.join(dataDir, "autosave", `pipeline_${Date.now()}.csv`),
};
fs.mkdirSync(path.dirname(deps.autosavePath), { recursive: true });

const emit = (channel, message) => deps.log(message);
const startTask = async (name, payload, runner) => runner({
  payload,
  livePayload: () => payload,
  shouldStop: () => false,
  updateLiveSettings: () => {},
  delay: async (min, max, label) => {
    const lo = Math.max(0, Number(min) || 0), hi = Math.max(lo, Number(max) || lo);
    const ms = lo + Math.random() * (hi - lo);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  },
  report: () => {},
  emitItem: () => {},
  pausePoint: async () => {},
});

const pipeline = createAutoPipeline({
  config,
  startTask,
  taskDeps: () => deps,
  // 与界面同一个实现（src/tasks/pick.js）。脚本不弹保存对话框，所以输出路径由编排显式给出。
  pickQuestions: makePickQuestions({ store, config, emit, defaultSaveDir: dataDir }),
  emit,
  pulse: () => {},
  dataDir,
  taskRunners: {
    crawl: runCrawlTask,
    generate: runGenerateTask,
    submit: runSubmitTask,
    checkPublished: runCheckPublishedTask,
    searchResources: runSearchResourcesTask,
    batchTransfer: runBatchTransferTask,
    topicUpload: runTopicUploadTask,
  },
  CATEGORIES,
  excel,
  fs,
  path,
  resolveNetdiskRoles,
  credentialOf: (envLabel) => credentialOf(dataDir, envLabel),
  credentialHint: (envLabel) => require("../electron/src/netdisk/manager").credentialHint(dataDir, envLabel),
});

async function main() {
  const stages = list(argv.stages).length ? list(argv.stages) : ["transfer", "upload"];
  const roles = resolveNetdiskRoles(bitEnvs, { transferEnvs: settings.transferEnvs, uploadEnvs: settings.uploadEnvs });
  const categories = list(argv.categories).length ? list(argv.categories) : CATEGORIES;
  const payload = {
    stages,
    bitEnvs,
    transferEnvs: roles.transferEnvs,
    uploadEnvs: roles.uploadEnvs,
    categories,
    pickCount: num(argv["pick-count"], settings.randomCount),
    batchRows: num(argv["batch-rows"], 500),
    uploadTablePath: argv.table && stages.includes("upload") && !stages.includes("transfer") ? path.resolve(argv.table) : "",
    transferTablePath: argv.table && stages.includes("transfer") ? path.resolve(argv.table) : "",
    searchPages: num(argv["search-pages"], 1),
    searchRowLimit: num(argv["search-limit"], 10),
    transferPerEnv: num(argv["per-env"], 10),
    transferCc: num(argv.cc, 1),   // 默认 1：真机实测并发是触发分享页降级的主因
    transferDelayMin: 1,
    transferDelayMax: 2,
    transferDestDir: settings.transferDestDir || "/来自资源批量转存",
  };

  console.log(`\n数据目录：${dataDir}`);
  console.log(`模式：${settings.browserMode}（纯协议 = 全程不开窗口）`);
  console.log(`阶段：${stages.join(" → ")}`);
  console.log(`本次参与账号：${bitEnvs.join("、")}`);
  if (stages.includes("transfer")) console.log(`转存账号：${roles.transferEnvs.join("、")}｜资源表：${payload.transferTablePath || "（没给 → 自动搜资源）"}`);
  if (stages.includes("upload")) console.log(`上传账号：${roles.uploadEnvs.join("、")}`);
  if (stages.includes("crawl")) console.log(`爬题分类：${categories.join("、")}｜每分类上限：${settings.maxQuestions} 题`);
  if (stages.includes("submit")) console.log(`提交上限：${settings.submitLimit} 条（每账号每日限额 ${settings.accountDailyLimit || "不限"}）`);
  console.log(`\n── 勾里的阶段都会真跑；提交/上传/转存都是真实动作 ──\n`);

  const result = await pipeline.run(payload);

  console.log("\n══════ 阶段结果 ══════");
  for (const stage of result.stages) {
    const mark = stage.ok ? "✅" : stage.skipped ? "⏭️" : "❌";
    console.log(`${mark} ${stage.label}${stage.ok ? (stage.summary ? "：" + stage.summary : "") : "：" + (stage.error || "")}`);
  }
  console.log(`\n结论：${result.ok ? "全部成功" : result.stopped ? "已停止" : "有阶段失败"}`);
  if (result.skipped.length) console.log(`被跳过：${result.skipped.map((s) => `${s.label}（${s.reason}）`).join("；")}`);
  if (result.artifacts.length) {
    console.log("\n本轮产出：");
    for (const art of result.artifacts) console.log(`  · ${art.label}：${art.path}`);
  }
  return result;
}

main()
  .then(() => { restoreSettings(); store.flushAll(); store.releaseLock(); })
  .catch((error) => {
    console.error("\n跑链失败：" + error.message);
    try { restoreSettings(); store.flushAll(); store.releaseLock(); } catch { /* 忽略 */ }
    process.exitCode = 1;
  });
