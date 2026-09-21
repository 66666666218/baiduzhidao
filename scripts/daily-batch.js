"use strict";

/**
 * 每日批量答题：生成 N 条 + 质检 + 提交（一条龙）。
 * 用法：node scripts/daily-batch.js [数量=10]
 * 从真实题库抽未回答的题（/question/hx/ 新格式优先），AI 生成 → 质检 → 提交。
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "运行缓存");
const count = Math.max(1, Number(process.argv[2]) || 10);

const { Config } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { LlmClient } = require("../electron/src/llm/client");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { TaskManager } = require("../electron/src/tasks/manager");
const { runGenerateTask } = require("../electron/src/tasks/generate");
const { runSubmitTask } = require("../electron/src/tasks/submit");
const { randomPickQuestions } = require("../electron/src/tasks/random-pick");

// Store 是 500ms 防抖写盘：直接 process.exit 会把最后几条 answer / "已提交" 状态留在内存里丢掉，
// 重跑时这些题会被当成未作答，造成重复提交。所有退出路径统一走 exit()。
let storeRef = null;
let exiting = false;
const exit = (code) => {
  if (exiting) return;
  exiting = true;
  try {
    if (storeRef) storeRef.flushAll();
  } catch (error) {
    console.error(`退出前落盘失败：${error.message}`);
  }
  try {
    if (storeRef) storeRef.releaseLock();
  } catch {
    /* 锁没释放也会被心跳超时忽略 */
  }
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => exit(1));
}

(async () => {
  const config = new Config(dataDir);
  const settings = config.load();
  const store = new Store(dataDir, { owner: "cli:daily-batch" });
  storeRef = store;
  // 与主程序并跑会各自整份覆写 answers.json/progress.json，先互斥再开工
  store.assertExclusive("daily-batch 每日批量生成");
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
  const log = (m) => {
    const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${m}`;
    console.log(line);
    try {
      fs.appendFileSync(path.join(dataDir, "logs", "daily-batch.log"), line + "\n", "utf8");
    } catch {
      /* 忽略 */
    }
  };

  // 选题：新格式真实题优先，排除已生成过的
  const bank = store.loadBank().filter((item) => item.questionUrl.includes("/question/hx/"));
  const answeredUrls = new Set(store.loadAnswers().filter((i) => i.answer).map((i) => String(i.questionUrl).toLowerCase()));
  const pool = bank.filter((item) => !answeredUrls.has(String(item.questionUrl).toLowerCase()));
  log(`=== 每日批量：题库新格式 ${bank.length} 条，未作答 ${pool.length} 条，本批 ${count} 条 ===`);
  if (!pool.length) {
    console.error("没有可作答的新题（可先运行 live-crawl-all 补充题库）");
    exit(1);
  }
  const picked = randomPickQuestions(pool, [], { categories: ["三类一起"], count }).picked;
  if (!picked.length) throw new Error("抽题结果为空");
  const manager = new TaskManager();

  // 生成
  const genResult = await manager.start("generate", { results: picked, aiDailyTokenBudget: settings.aiDailyTokenBudget }, async (ctx) =>
    runGenerateTask(ctx, { store, llm, log, autosavePath: path.join(dataDir, "autosave", `生成_${Date.now()}.csv`) })
  );
  const passCount = genResult.results.filter((r) => String(r.quality).startsWith("PASS")).length;
  log(`生成完成：${genResult.count} 条，质检 PASS ${passCount} 条`);

  // 提交环节跟着设置页的「自动提交」开关走：这个脚本一直是无条件提交的，
  // 设置里关掉开关也照提，等于把"自动运行"变成了没人盯着的批量投稿。
  if (!settings.autoSubmit) {
    log("设置里未开启自动提交，本批只生成不提交（要提交请在软件「设置」页开启自动提交后重跑）。");
    log(`=== 每日批量完成（仅生成）：${genResult.count} 条，质检 PASS ${passCount} 条 ===`);
    exit(0);
  }

  // 提交（REVIEW 的也提交——判定仅供人工参考；用户可按质检列筛除）
  const rows = genResult.results.filter((r) => r.answer).map((r) => ({ ...r, status: "已生成回答" }));
  const submitResult = await manager.start("submit", {
    bitEnvs: [{ label: "测试组1" }],
    results: rows,
    accountDailyLimit: 0,
    checkCompletedEnvs: false,
    delayMin: 25,
    delayMax: 50,
  }, async (ctx) => runSubmitTask(ctx, { browserPool, store, config, log, copy: async () => {}, autosavePath: path.join(dataDir, "autosave", `提交_${Date.now()}.csv`) }));

  log(`=== 每日批量完成：提交成功 ${submitResult.count} 条，失败 ${submitResult.failed} 条 ===`);
  exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  if (error.stack) console.error(error.stack.split("\n").slice(0, 8).join("\n"));
  exit(1);
});
