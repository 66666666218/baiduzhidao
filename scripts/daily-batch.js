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
  // 账号必须来自设置：此前写死 [{ label: "测试组1" }]，多个比特环境形同不存在，
  // 无人值守跑批永远只投一个号，限额/轮换/题材绑定全部失效。
  // ZHIDAO_BIT_ENV 可覆盖（逗号分隔多个），便于跑批脚本在不改设置的情况下指定账号。
  // 只按逗号切：账号名里可能有空格，按空白切会把一个账号名劈成两个
  const envOverride = String(process.env.ZHIDAO_BIT_ENV || "").split(/[,，]+/).map((x) => x.trim()).filter(Boolean);
  const submitEnvs = envOverride.length
    ? envOverride
    : (settings.bitEnvs || []).map((env) => env.label || env).filter(Boolean);
  if (!submitEnvs.length) {
    log("没有可用的比特环境账号：设置页的「比特环境名称」为空，且未设 ZHIDAO_BIT_ENV。请先在软件设置页填写账号后重跑。");
    exit(1);
  }
  log(`参与提交的账号（${submitEnvs.length} 个）：${submitEnvs.join("、")}${envOverride.length ? "（来自 ZHIDAO_BIT_ENV 覆盖）" : ""}`);
  const topicMap = settings.accountTopics || {};
  const boundCount = Object.keys(topicMap).length;
  if (boundCount) log(`账号题材绑定：${Object.entries(topicMap).map(([a, t]) => `${a}→${t}`).join("、")}`);

  const rows = genResult.results.filter((r) => r.answer).map((r) => ({ ...r, status: "已生成回答" }));
  const submitResult = await manager.start("submit", {
    bitEnvs: submitEnvs,
    results: rows,
    accountDailyLimit: Number(settings.accountDailyLimit) || 0,
    checkCompletedEnvs: false,
    // 题材路由：带链接的答案只投给绑定了对应题材的账号（本脚本生成的通常是纯文本答案，
    // 会走宽松轮询；带链接的答案由软件「自动提交」视图按表格提交时生效）
    accountTopics: topicMap,
    linkRouting: settings.linkRouting,
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
