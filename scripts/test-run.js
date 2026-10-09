"use strict";

/**
 * 实操测试：抽题 → 生成 → 提交（每账号 50 条，两个账号）。
 *
 * 用项目自己的任务函数（与 scripts/daily-batch.js 同一套），
 * 但作用在**打包版的数据目录**上（%APPDATA%\zhidao-answer-studio）。
 * 限额用 payload 覆盖，不动用户设置。
 *
 * 用法：node scripts/test-run.js [每账号条数=50] [抽题条数=100]
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
// 数据目录：优先 ZHIDAO_DATA_DIR（与 scripts/live-crawl-all.js 同一约定），
// 否则用打包版的默认位置。**不要写死本机路径**——这套要拿到新电脑新环境跑。
const dataDir = process.env.ZHIDAO_DATA_DIR
  ? path.resolve(process.env.ZHIDAO_DATA_DIR)
  : path.join(process.env.APPDATA || "", "zhidao-answer-studio");
const perAccount = Math.max(1, Number(process.argv[2]) || 50);
const pickCount = Math.max(1, Number(process.argv[3]) || perAccount * 2);

const { Config } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { LlmClient } = require("../electron/src/llm/client");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { TaskManager } = require("../electron/src/tasks/manager");
const { runGenerateTask } = require("../electron/src/tasks/generate");
const { runSubmitTask } = require("../electron/src/tasks/submit");
const { randomPickQuestions } = require("../electron/src/tasks/random-pick");

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

(async () => {
  const config = new Config(dataDir);
  const settings = config.load();
  const store = new Store(dataDir, { owner: "cli:test-run" });
  storeRef = store;
  store.assertExclusive("test-run 实操测试");
  const llm = new LlmClient({
    apiKey: settings.aiApiKey,
    baseUrl: settings.aiBaseUrl,
    model: settings.aiModel,
    concurrency: settings.aiConcurrency,
    systemPrompt: settings.systemPrompt,
    temperature: settings.aiTemperature,
    onUsage: (entry) => store.addUsage(entry),
  });
  const browserPool = new BrowserPool(createAdapter({ apiUrl: settings.apiUrl }));
  const log = (m) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${m}`);

  const bitEnvs = (settings.bitEnvs || []).map((e) => e.label || e).filter(Boolean);
  log(`数据目录：${dataDir}`);
  log(`账号（${bitEnvs.length} 个）：${bitEnvs.join("、")} | 每账号 ${perAccount} 条 | 本批抽 ${pickCount} 条`);

  // ---------- 1) 抽题（排除已作答）----------
  const bank = store.loadBank();
  const answered = new Set(
    store.loadAnswers()
      .filter((a) => String(a.answer || "").trim() || a.status === "已提交")
      .map((a) => String(a.questionUrl || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const pool = bank.filter((x) => !answered.has(String(x.questionUrl || "").trim().toLowerCase()));
  log(`题库 ${bank.length} 条，已作答 ${answered.size} 条，可抽 ${pool.length} 条`);
  if (!pool.length) { log("没有可抽的新题，先爬题。"); exit(1); }

  const picked = randomPickQuestions(pool, [], { categories: ["三类一起"], count: pickCount }).picked;
  log(`抽题结果：${picked.length} 条`);
  if (!picked.length) { log("抽题为空。"); exit(1); }

  const manager = new TaskManager();

  // ---------- 2) 生成答案 ----------
  log("=== 开始生成答案 ===");
  const genResult = await manager.start("generate", {
    results: picked,
    filePath: "",              // 不写回表格，直接拿结果
    aiApiKey: settings.aiApiKey,
    aiBaseUrl: settings.aiBaseUrl,
    aiModel: settings.aiModel,
    aiConcurrency: settings.aiConcurrency,
    aiDailyTokenBudget: settings.aiDailyTokenBudget || 0,
    titleTemplate: settings.titleTemplate,
    introTemplate: settings.introTemplate,
  }, async (ctx) => runGenerateTask(ctx, { store, llm, log, autosavePath: path.join(dataDir, "autosave", `test-gen_${Date.now()}.csv`) }));
  const genRows = (genResult.results || []).filter((r) => String(r.answer || "").trim());
  const pass = genRows.filter((r) => String(r.quality || "").startsWith("PASS")).length;
  log(`生成完成：${genResult.count} 条（质检 PASS ${pass} / REVIEW ${genRows.length - pass}）`);
  if (!genRows.length) { log("没有生成出答案，停止。"); exit(1); }

  // ---------- 3) 提交 ----------
  log("=== 开始提交 ===");
  const submitResult = await manager.start("submit", {
    bitEnvs,
    results: genRows.map((r) => ({ ...r, status: "已生成回答" })),
    accountDailyLimit: perAccount,   // ★ 用参数覆盖，不动用户设置
    submitLimit: 0,
    dailyAnswerLimit: 0,
    checkCompletedEnvs: false,
    forceResubmit: false,
    accountTopics: settings.accountTopics,
    linkRouting: settings.linkRouting,
  }, async (ctx) => runSubmitTask(ctx, {
    browserPool, store, config, log, copy: async () => {},
    autosavePath: path.join(dataDir, "autosave", `test-submit_${Date.now()}.csv`),
  }));

  log(`=== 提交结束：成功 ${submitResult.count} 条，失败 ${submitResult.failed} 条 ===`);
  await browserPool.closeAll().catch(() => {});
  exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  if (error.stack) console.error(error.stack.split("\n").slice(0, 6).join("\n"));
  exit(1);
});
