"use strict";

/**
 * 无人值守地跑「网盘资源链」：搜资源 → 转存 → 按题材分账号上传 → 查收录。
 *
 * 走的是**真编排器**（`src/workflows/auto-pipeline.js`），不是另写一套流程 ——
 * 所以阶段报告、跳过原因、本轮产出清单、账号并发提示都跟软件里点「一键全自动」完全一致。
 * 这也是为什么那两个任务函数要先从 app-context 搬出来：不搬就只能在这里抄一遍。
 *
 * 用法（默认小批量，先确认链路通不通）：
 *   node scripts/run-netdisk-chain.js
 *   node scripts/run-netdisk-chain.js --search-pages=2 --search-limit=20 --per-env=10 --cc=2
 *   node scripts/run-netdisk-chain.js --dry            # 只打印将要做的事，不真跑
 *   ZHIDAO_DATA_DIR=xxx node scripts/run-netdisk-chain.js
 *
 * ⚠️ 这会**真的**往网盘里转存、**真的**往平台上传。跑之前先看清 --dry 的输出。
 */

const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = process.env.ZHIDAO_DATA_DIR ? path.resolve(process.env.ZHIDAO_DATA_DIR) : path.join(root, "运行缓存");

const { Config, CATEGORIES } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { Logger } = require("../electron/src/log");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const excel = require("../electron/src/storage/excel");
const fs = require("fs");
const { createAutoPipeline } = require("../electron/src/workflows/auto-pipeline");
const { resolveNetdiskRoles } = require("../electron/src/domain/account-topic");
const { AccountManager } = require("../electron/src/browser/account-manager");
const { parseAccountProxies, dispatcherFor } = require("../electron/src/netdisk/proxy");
const { credentialOf } = require("../electron/src/netdisk/manager");
const { runSearchResourcesTask } = require("../electron/src/tasks/search-resources");
const { runCheckPublishedTask } = require("../electron/src/tasks/check-published");
const { runBatchTransferTask } = require("../electron/src/tasks/batch-transfer");
const { runTopicUploadTask } = require("../electron/src/tasks/upload-batch");

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? "true" : m[2]] : [a, "true"];
}));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const DRY = argv.dry === "true";

const config = new Config(dataDir);
const settings = config.load();
const store = new Store(dataDir, { owner: "run-netdisk-chain" });
const logger = new Logger(path.join(dataDir, "logs"));
const browserPool = new BrowserPool(createAdapter({ apiUrl: settings.apiUrl }), {
  // 纯协议链路不开窗口；这里给一个函数式 mode，跟 app-context 一样现读设置
  mode: () => (String(config.load().browserMode || "bit") === "headless" ? "headless" : "bit"),
  credentialOf: (envLabel) => credentialOf(dataDir, envLabel),
});
const accountManager = new AccountManager({ store, dailyLimit: 0 });

const bitEnvs = (settings.bitEnvs || []).map((e) => e.label || e).filter(Boolean);
if (!bitEnvs.length) throw new Error("设置里没有账号（bitEnvs 为空）：先在「账号凭证」把两个号加进来。");

const proxies = parseAccountProxies(settings.accountProxies || "");
const deps = {
  config,
  store,
  dataDir,
  browserPool,
  accountManager,
  log: (message) => { logger.log(message); console.log("   " + String(message).replace(/\n/g, "\n   ")); },
  credentialOf: (envLabel) => credentialOf(dataDir, envLabel),
  proxyOf: (envLabel) => { try { return dispatcherFor(proxies[envLabel]); } catch { return undefined; } },
  emitEvent: () => {},
  autosavePath: path.join(dataDir, "autosave", `netdisk-chain_${Date.now()}.csv`),
};
fs.mkdirSync(path.dirname(deps.autosavePath), { recursive: true });

/** 这条链不用抽题；真被调到就是编排串错了，直接炸出来别装没事 */
const pickQuestions = async () => { throw new Error("网盘资源链不该走到「抽题」——编排的 stages 传错了"); };

const startTask = async (name, payload, runner) => runner({
  payload,
  livePayload: () => payload,
  shouldStop: () => false,
  updateLiveSettings: () => {},
  delay: async (min, max, label) => {
    const lo = Math.max(0, Number(min) || 0), hi = Math.max(lo, Number(max) || lo);
    const ms = lo + Math.random() * (hi - lo);
    if (ms > 0) console.log(`   （${label || "间隔"} ${(ms / 1000).toFixed(1)} 秒）`);
    await new Promise((r) => setTimeout(r, ms));
  },
  report: () => {},
  emitItem: () => {},
  pausePoint: async () => {},
});

const pipeline = createAutoPipeline({
  config,
  startTask,
  taskDeps: () => deps,
  pickQuestions,
  emit: (channel, message) => deps.log(message),
  pulse: () => {},
  dataDir,
  taskRunners: {
    crawl: async () => { throw new Error("网盘资源链不跑爬题"); },
    generate: async () => { throw new Error("网盘资源链不跑生成"); },
    submit: async () => { throw new Error("网盘资源链不跑提交"); },
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
});

async function main() {
  const roles = resolveNetdiskRoles(bitEnvs, {
    transferEnvs: settings.transferEnvs,
    uploadEnvs: settings.uploadEnvs,
  });
  const payload = {
    // 可以只跑其中一段：--stages=transfer 就只转存、不碰平台。
    // 这两个阶段的影响面差别很大（转存只动自己的网盘，上传会往平台投表并扣额度），
    // 分开跑是必要的 —— 回补几条转存失败不该顺带把整张表再传一遍。
    stages: String(argv.stages || "transfer,upload").split(",").map((s) => s.trim()).filter(Boolean),
    bitEnvs,
    transferEnvs: roles.transferEnvs,
    uploadEnvs: roles.uploadEnvs,
    // 不给资源表 → 走"按账号绑定的题材自动搜资源"这条路（这次就是要验它）
    searchPages: num(argv["search-pages"], 1),
    searchRowLimit: num(argv["search-limit"], 10),
    // 也可以用 --table=xxx.xlsx 直接喂一张现成的资源表（复跑同一条链时用，
    // 已转存的会靠 state.jsonl 自动跳过，不会重复转存）
    transferTablePath: argv.table ? path.resolve(argv.table) : "",
    transferPerEnv: num(argv["per-env"], 10),
    transferCc: num(argv.cc, 2),
    transferDelayMin: 1,
    transferDelayMax: 2,
    batchRows: num(argv["batch-rows"], 500),
    transferDestDir: settings.transferDestDir || "/来自资源批量转存",
  };

  console.log(`\n数据目录：${dataDir}`);
  console.log(`模式：${settings.browserMode}（纯协议 = 全程不开窗口）`);
  console.log(`本次参与账号：${bitEnvs.join("、")}`);
  console.log(`转存账号：${roles.transferEnvs.join("、")}`);
  console.log(`上传账号：${roles.uploadEnvs.join("、")}`);
  console.log(`账号题材绑定：${JSON.stringify(settings.accountTopics || {})}`);
  console.log(`搜索：每题材 ${payload.searchPages} 页，总条数上限 ${payload.searchRowLimit}`);
  console.log(`转存：每账号 ${payload.transferPerEnv} 条、并发 ${payload.transferCc}`);
  console.log(`\n── 这会真的转存到网盘并真的上传到平台 ──`);

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
  .then(() => { store.flushAll(); store.releaseLock(); })
  .catch((error) => {
    console.error("\n跑链失败：" + error.message);
    try { store.flushAll(); store.releaseLock(); } catch { /* 忽略 */ }
    process.exitCode = 1;
  });
