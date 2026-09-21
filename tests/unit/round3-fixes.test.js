"use strict";

/**
 * 第 3 轮审查（跨进程锁续期 / 表格写回 / 设置往返 / 记账）回归用例。
 * 每条对应一个回代码核实过的缺陷。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { Store } = require("../../electron/src/storage/store");
const { Config, normalizeBitEnvs } = require("../../electron/src/config");
const excel = require("../../electron/src/storage/excel");
const { LlmClient } = require("../../electron/src/llm/client");
const { BitBrowserAdapter } = require("../../electron/src/browser/bitbrowser");
const { nowText } = require("../../electron/src/config");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 跨进程写入者锁 ----------

test("Store：任何写入者（含命令行）都会自动续期锁", async () => {
  const dir = tempDir("r3-lock-");
  const store = new Store(dir, { owner: "cli:test" });
  const lockPath = path.join(dir, ".store.lock");
  assert.ok(fs.existsSync(lockPath), "构造时就该占下这把锁");
  const first = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  store.startLockHeartbeat(20); // 真实间隔 30 秒，测试里压缩
  await sleep(70);
  const second = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.ok(second.at > first.at, `锁必须随时间续期，否则 90 秒后会被判死：${first.at} → ${second.at}`);
  assert.equal(second.owner, "cli:test");
  store.releaseLock();
});

test("Store：只读消费者不写锁也不抢锁", () => {
  const dir = tempDir("r3-ro-");
  const writer = new Store(dir, { owner: "cli:test" });
  const before = fs.readFileSync(path.join(dir, ".store.lock"), "utf8");
  const reader = new Store(dir, { owner: "site", readonly: true });
  assert.equal(fs.readFileSync(path.join(dir, ".store.lock"), "utf8"), before, "只读 Store 不能改写别人的锁");
  assert.equal(reader.foreignWriter, null, "只读方不该把自己算作写入者");
  assert.equal(reader.claimLock(), false);
  assert.doesNotThrow(() => reader.loadBank());
  writer.releaseLock();
});

// ---------- 生成任务：表格写回与预算热更新 ----------

function makeTable(dir, rows) {
  const file = path.join(dir, "抽题表.xlsx");
  excel.writeWorkbookSafe(file, rows.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS);
  return file;
}

test("生成任务：中途停止不会把没跑到的题目从表格里抹掉", async () => {
  const dir = tempDir("r3-table-");
  const rows = [1, 2, 3].map((i) => ({ title: `题${i}`, questionUrl: `https://x/${i}`, category: "情感类" }));
  const file = makeTable(dir, rows);
  const store = new Store(dir);
  let stopped = false;
  const llm = new LlmClient({
    apiKey: "k",
    baseUrl: "https://mock.test/v1/chat/completions",
    model: "m",
    concurrency: 1,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "这是一条足够长的回答，用来验证表格写回行为是否正确。".repeat(3) } }] }) }),
  });
  const ctx = {
    payload: { results: rows, filePath: file, aiDailyTokenBudget: 0 },
    shouldStop: () => stopped,
    livePayload() { return this.payload; },
    delay: async () => {},
    report: () => {},
    emitItem: () => { stopped = true; }, // 第一条完成后即请求停止
  };
  const { runGenerateTask } = require("../../electron/src/tasks/generate");
  await runGenerateTask(ctx, { store, llm, log: () => {} });

  const back = excel.readTableRows(file);
  assert.equal(back.length, 3, `3 行题目必须都还在表里，实际 ${back.length} 行`);
  assert.equal(back.filter((row) => String(row["回答内容"] || "").trim()).length, 1, "只有已生成的那一行有内容");
});

test("生成任务：运行中调高日预算立刻生效（读 livePayload 而不是启动快照）", async () => {
  const { runGenerateTask } = require("../../electron/src/tasks/generate");
  const dir = tempDir("r3-budget-");
  const store = new Store(dir);
  store.addUsage({ model: "m", promptTokens: 600, completionTokens: 400, at: `${new Date().toLocaleDateString("zh-CN")} 09:00:00` }); // 今日 1000

  let calls = 0;
  const llm = new LlmClient({
    apiKey: "k",
    baseUrl: "https://mock.test/v1/chat/completions",
    model: "m",
    concurrency: 1,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "回答正文足够长用来通过质检门的最低长度要求，这一条用于预算热更新验证。".repeat(2) } }] }) };
    },
  });
  const payload = { results: [{ title: "题1", questionUrl: "https://x/1" }], aiDailyTokenBudget: 1000 };
  const ctx = {
    payload,
    shouldStop: () => false,
    livePayload: () => ({ ...payload, aiDailyTokenBudget: 5000 }), // 用户跑中途把预算调到 5000
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };
  const result = await runGenerateTask(ctx, { store, llm, log: () => {} });
  assert.equal(calls, 1, "按启动快照判断会误以为预算已用尽而一次都不调用");
  assert.ok(!result.stopped);
});

// ---------- 设置：往返与损坏自愈 ----------

test("设置：比特环境名往返归一化不会变成 [object Object]", () => {
  const once = normalizeBitEnvs(["测试组1", "测试组2"]);
  assert.deepEqual(once, [{ label: "测试组1" }, { label: "测试组2" }]);
  // load() 会把已归一化的对象再喂回来一次，以前这一步就把环境名毁掉了
  assert.deepEqual(normalizeBitEnvs(once), once, "已归一化的 { label } 再归一化必须原样保留");
  assert.deepEqual(normalizeBitEnvs([{ name: "备用" }]), [{ label: "备用" }]);
});

test("设置：settings.json 损坏时先留底再抢救，不静默写回默认值", () => {
  const dir = tempDir("r3-settings-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, '{"aiApiKey":"sk-abcdef0123456789","aiModel":"deepseek-ai/DeepSeek-V3"','utf8'); // 截断
  const config = new Config(dir);
  const loaded = config.load();
  assert.equal(loaded.aiModel, "deepseek-ai/DeepSeek-V3", "应抢救出完整的那半条记录");
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("settings.json.损坏备份_"));
  assert.equal(backups.length, 1, "坏文件必须留底，不能被下一次 save 覆盖掉");
});

// ---------- 作答记录合并 ----------

test("Store：字段不全的二次 upsert 不会把已提交状态抹回初始值", () => {
  const dir = tempDir("r3-upsert-");
  const store = new Store(dir);
  store.upsertAnswer({
    title: "题目甲",
    questionUrl: "https://x/1",
    category: "情感类",
    answer: "既有回答内容",
    status: "已提交",
    submittedAt: nowText(),
    confirmed: true,
  });
  store.upsertAnswer({ title: "题目甲", questionUrl: "https://x/1" }); // 重跑迁移/再生成时只带定位字段
  const kept = store.loadAnswers()[0];
  assert.equal(kept.answer, "既有回答内容", "answer 不能被缺省值覆盖");
  assert.equal(kept.status, "已提交");
  assert.equal(kept.confirmed, true);
  // 显式给值仍然覆盖
  store.upsertAnswer({ title: "题目甲", questionUrl: "https://x/1", status: "已生成回答" });
  assert.equal(store.loadAnswers()[0].status, "已生成回答");
});

// ---------- 任务状态上报 ----------

test("任务管理器：暂停期间会重发一次带 paused 的进度，恢复后回到 running", async () => {
  const { TaskManager } = require("../../electron/src/tasks/manager");
  const manager = new TaskManager();
  const seen = [];
  const result = await manager.start("demo", {}, async (ctx) => {
    ctx.report({ done: 1, total: 5, status: "running" });
    manager.pause();
    const timer = setTimeout(() => manager.resume(), 60);
    if (timer.unref) timer.unref();
    await ctx.pausePoint("题间检查点");
    ctx.report({ done: 2, total: 5, status: "running" });
    return { ok: true };
  }, { onProgress: (progress) => seen.push(progress) });
  assert.ok(result.ok);
  const statuses = seen.map((progress) => progress.status);
  assert.deepEqual(
    statuses,
    ["running", "paused", "running", "running"],
    `暂停时要补发 paused、恢复时要补回 running，否则进度条一直显示"进行中"：${JSON.stringify(seen)}`
  );
  assert.equal(seen[1].done, 1, "补发的暂停进度要沿用最近一次的 done/total");
});

// ---------- 浏览器适配层 ----------

test("比特适配器：API 调用必须带超时，不能永久挂住任务", async () => {
  const adapter = new BitBrowserAdapter("http://127.0.0.1:54345", async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal, "post 必须传 AbortSignal，否则客户端卡住时任务永远停在 RUNNING");
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { list: [] } }) };
  });
  await adapter.post("/browser/list", { page: 0 });
});
