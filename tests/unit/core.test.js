"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { Store, questionKeys, recordKey } = require("../../electron/src/storage/store");
const { randomPickQuestions } = require("../../electron/src/tasks/random-pick");
const { allocateRowsToEnvs, TaskManager, randomDelayFactory } = require("../../electron/src/tasks/manager");
const { LlmClient, applyTemplate, cleanAnswer, Semaphore } = require("../../electron/src/llm/client");
const { normalizeSettings, normalizeBitEnvs, normalizeCategories } = require("../../electron/src/config");
const zhidao = require("../../electron/src/pages/zhidao");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-v2-test-"));
}

// ---------- Store ----------

test("Store：题库去重（url/标题双键）与原子写入", () => {
  const dir = tempDir();
  const store = new Store(dir);
  assert.equal(store.addBankQuestion({ title: "题目A", questionUrl: "https://x/1" }), "added");
  assert.equal(store.addBankQuestion({ title: "题目A重复", questionUrl: "https://x/1" }), "exists");
  assert.equal(store.addBankQuestion({ title: "题目A", questionUrl: "https://x/999" }), "exists", "标题重复也应命中");
  assert.equal(store.addBankQuestion({ title: "题目B", questionUrl: "https://x/2" }), "added");
  assert.equal(store.bankSize(), 2);

  // 防抖写入需 flush 后才落盘（任务结束时主流程会 flushAll）
  store.flushAll();
  const store2 = new Store(dir);
  assert.equal(store2.bankSize(), 2);
  assert.equal(store2.addBankQuestion({ title: "题目A", questionUrl: "https://x/1" }), "exists");
});

test("Store：空题目不入库", () => {
  const store = new Store(tempDir());
  assert.equal(store.addBankQuestion({}), "exists");
  assert.equal(store.bankSize(), 0);
});

test("Store：答案 upsert 与按 url 合并", () => {
  const store = new Store(tempDir());
  store.upsertAnswer({ title: "题1", questionUrl: "https://x/1", answer: "答案v1", status: "已生成回答" });
  store.upsertAnswer({ title: "题1", questionUrl: "https://x/1", answer: "答案v2", status: "已提交" });
  const answers = store.loadAnswers();
  assert.equal(answers.length, 1);
  assert.equal(answers[0].answer, "答案v2");
  assert.equal(answers[0].status, "已提交");
});

test("Store：findAnswer 命中历史答案", () => {
  const store = new Store(tempDir());
  store.upsertAnswer({ title: "题X", questionUrl: "https://x/9", answer: "历史答案" });
  const found = store.findAnswer({ title: "题X", questionUrl: "https://x/9" });
  assert.equal(found.answer, "历史答案");
  assert.equal(store.findAnswer({ title: "不存在", questionUrl: "https://x/404" }), null);
});

test("Store：clearAnswers 支持 onlyUsed", () => {
  const store = new Store(tempDir());
  store.upsertAnswer({ questionUrl: "https://x/1", answer: "a", status: "已提交" });
  store.upsertAnswer({ questionUrl: "https://x/2", answer: "b", status: "已生成回答" });
  const removed = store.clearAnswers({ onlyUsed: true });
  assert.equal(removed, 1);
  assert.equal(store.loadAnswers().length, 1);
  assert.equal(store.loadAnswers()[0].status, "已生成回答");
});

test("Store：addUsage 统计", () => {
  const store = new Store(tempDir());
  store.addUsage({ model: "m", promptTokens: 10, completionTokens: 5 });
  store.addUsage({ model: "m", promptTokens: 20, completionTokens: 7 });
  const usage = store.getUsage();
  assert.equal(usage.calls, 2);
  assert.equal(usage.promptTokens, 30);
  assert.equal(usage.completionTokens, 12);
});

// ---------- 随机抽题 ----------

function makeBank(n, category = "情感类") {
  return Array.from({ length: n }, (_unused, index) => ({
    title: `题${index}`,
    questionUrl: `https://x/${index}`,
    category,
  }));
}

test("随机抽题：跨轮次去重", () => {
  const bank = makeBank(10);
  const r1 = randomPickQuestions(bank, [], { categories: ["情感类"], count: 6 });
  assert.equal(r1.picked.length, 6);
  assert.equal(r1.remainingAfter, 4);
  const r2 = randomPickQuestions(bank, r1.usedKeys, { categories: ["情感类"], count: 6 });
  assert.equal(r2.picked.length, 4, "第二轮只剩4条");
  assert.equal(r2.remainingAfter, 0);
  const r3 = randomPickQuestions(bank, r2.usedKeys, { categories: ["情感类"], count: 6 });
  assert.equal(r3.picked.length, 6, "全部用完后重开一轮");
  assert.equal(r3.resetRound, true);
});

test("随机抽题：分类过滤", () => {
  const bank = [...makeBank(5, "情感类"), ...makeBank(3, "教育类")];
  const result = randomPickQuestions(bank, [], { categories: ["教育类"], count: 10 });
  assert.equal(result.total, 3);
  assert.ok(result.picked.every((item) => item.category === "教育类"));
});

// ---------- 任务引擎 ----------

test("allocateRowsToEnvs：轮换与每日限额", () => {
  const rows = Array.from({ length: 7 }, (_v, i) => ({ questionUrl: `u${i}` }));
  // 每账号每日限额 2：两个账号最多 4 条，其余本轮不放行（与旧版行为一致）
  const allocation = allocateRowsToEnvs(rows, ["A", "B"], { perEnvLimit: 100, accountDailyLimit: 2 });
  assert.deepEqual(allocation.map((slot) => slot.rows.length), [2, 2]);
  assert.equal(allocation.reduce((sum, slot) => sum + slot.rows.length, 0), 4);

  const limited = allocateRowsToEnvs(rows, ["A", "B"], { perEnvLimit: 1, accountDailyLimit: 5 });
  assert.deepEqual(limited.map((slot) => slot.rows.length), [1, 1]);

  const unlimited = allocateRowsToEnvs(rows, ["A"], { perEnvLimit: 0, accountDailyLimit: 0 });
  assert.equal(unlimited[0].rows.length, 7, "限额为 0 表示不限");
});

test("TaskManager：互斥与停止", async () => {
  const manager = new TaskManager();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const p1 = manager.start("a", {}, async () => { await gate; return 1; });
  await assert.rejects(() => manager.start("b", {}, async () => 2), /已有任务正在运行/);
  manager.stop();
  release();
  assert.equal(await p1, 1);
  const p2 = await manager.start("b", {}, async () => 2);
  assert.equal(p2, 2);
});

test("randomDelayFactory：stop 后立即返回", async () => {
  let stopped = false;
  const delay = randomDelayFactory(() => stopped);
  const start = Date.now();
  setTimeout(() => { stopped = true; }, 50);
  await delay(5, 5, "测试");
  assert.ok(Date.now() - start < 2000, "应在 stop 后提前返回而不是等满 5 秒");
});

// ---------- LLM ----------

test("LlmClient：500 后重试成功", async () => {
  let calls = 0;
  const client = new LlmClient({
    apiKey: "sk-test",
    baseUrl: "https://mock/v1/chat/completions",
    model: "test-model",
    concurrency: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 2) {
        return { ok: false, status: 500, text: async () => "server error" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "回答：这是测试回答内容。" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      };
    },
  });
  const answer = await client.chat({ system: "s", user: "u" });
  assert.equal(answer, "回答：这是测试回答内容。", "chat() 返回原文");
  assert.equal(cleanAnswer(answer), "这是测试回答内容。", "cleanAnswer 清掉前缀");
  assert.equal(calls, 2);
  assert.equal(client.usage.calls, 1);
});

test("LlmClient：不可重试错误直接抛出", async () => {
  let calls = 0;
  const client = new LlmClient({
    apiKey: "sk-test",
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 401, text: async () => "unauthorized" };
    },
  });
  await assert.rejects(() => client.chat({ system: "s", user: "u" }), /401/);
  assert.equal(calls, 1);
});

test("Semaphore：并发闸", async () => {
  const semaphore = new Semaphore(2);
  let running = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    await semaphore.acquire();
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    semaphore.release();
  }));
  assert.equal(peak, 2);
});

test("提交任务：全部已提交时直接返回（防重复提交）", async () => {
  const { runSubmitTask } = require("../../electron/src/tasks/submit");
  const noopCtx = {
    payload: {
      bitEnvs: [{ label: "A" }],
      results: [{ questionUrl: "https://x/1", answer: "答案内容足够长", status: "已提交" }],
    },
    shouldStop: () => false,
    livePayload() { return this.payload; },
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };
  const deps = { log: () => {} };
  const result = await runSubmitTask(noopCtx, deps);
  assert.equal(result.count, 0);
  assert.equal(result.total, 0, "已提交的行不应再次提交");
});

// ---------- 纯函数 ----------

test("applyTemplate 支持中文占位符", () => {
  const text = applyTemplate("A列标题：{{标题}} / B列：{{问题内容}}", { title: "T1", questionContent: "C1" });
  assert.equal(text, "A列标题：T1 / B列：C1");
});

test("cleanAnswer 清理标题与截断", () => {
  assert.equal(cleanAnswer("回答：你好"), "你好");
  assert.equal(cleanAnswer("## 总结：\n内容"), "内容");
  assert.equal(cleanAnswer("x".repeat(2000)).length, 1000);
});

test("zhidao.titlesMatch 忽略标点差异", () => {
  assert.equal(zhidao.titlesMatch("男人爱上已婚女人会痛苦吗", "男人爱上已婚女人会痛苦吗？"), true);
  assert.equal(zhidao.titlesMatch("完全不同的标题", "另一个标题"), false);
});

test("zhidao.listKey 归一化", () => {
  assert.equal(zhidao.listKey("Hello World"), "title:helloworld");
});

test("config：normalizeSettings 数值夹取", () => {
  const settings = normalizeSettings({ timeoutMs: 1, delayMin: 30, delayMax: 5, aiConcurrency: 99 });
  assert.ok(settings.timeoutMs >= 5000);
  assert.equal(settings.delayMax, 30, "delayMax 不得小于 delayMin");
  assert.equal(settings.aiConcurrency, 8);
});

test("config：normalizeBitEnvs 去重去空", () => {
  assert.deepEqual(normalizeBitEnvs("a, a\nb，,c"), [{ label: "a" }, { label: "b" }, { label: "c" }]);
  assert.deepEqual(normalizeBitEnvs(["x", "x", ""]), [{ label: "x" }]);
});

test("config：normalizeCategories", () => {
  assert.deepEqual(normalizeCategories("三类一起"), ["情感类", "教育类", "综合类"]);
  assert.deepEqual(normalizeCategories(["教育类"]), ["教育类"]);
  assert.deepEqual(normalizeCategories(undefined), ["情感类", "教育类", "综合类"]);
});

test("Store：setEnvPage 断点记录与恢复", () => {
  const dir = tempDir();
  const store = new Store(dir);
  store.setEnvPage("账号1:情感类", 3);
  store.flushAll();

  const store2 = new Store(dir);
  assert.equal(store2.getEnvProgress("账号1:情感类").lastPage, 3, "重启后应能恢复断点页码");
  assert.equal(store2.getEnvProgress("新账号:情感类").lastPage, 1, "新环境默认第 1 页");
});

test("excel.appendCsvRow：CSV 自动保存兜底", () => {
  const excel = require("../../electron/src/storage/excel");
  const csvPath = path.join(tempDir(), "autosave", "生成.csv");
  excel.appendCsvRow(csvPath, excel.answerToRow({ title: "T1", answer: "答案,a\"b", questionUrl: "https://x/1", status: "已生成回答" }), excel.ANSWER_HEADERS);
  excel.appendCsvRow(csvPath, excel.answerToRow({ title: "T2", answer: "答案2", questionUrl: "https://x/2", status: "已生成回答" }), excel.ANSWER_HEADERS);
  const content = fs.readFileSync(csvPath, "utf8");
  assert.ok(content.startsWith("\uFEFF"), "应有 BOM 方便 Excel 识别");
  assert.equal(content.trim().split("\r\n").length, 3, "表头 + 2 行");
  assert.ok(content.includes('"答案,a""b"'), "逗号和引号应被转义");
});

test("Store：getUsageToday 只统计当天", () => {
  const dir = tempDir();
  const store = new Store(dir);
  const today = new Date().toLocaleDateString("zh-CN");
  store.addUsage({ model: "m", promptTokens: 100, completionTokens: 50, at: `${today} 10:00:00` });
  store.addUsage({ model: "m", promptTokens: 30, completionTokens: 20, at: "2020/1/1 08:00:00" });
  assert.equal(store.getUsageToday(), 150, "只累计今天的 tokens");
  assert.equal(store.getUsage().completionTokens, 70, "总量不受影响");
});

test("excel：导出表格保留题库分类且可回读", () => {
  const excel = require("../../electron/src/storage/excel");
  assert.ok(excel.ANSWER_HEADERS.includes("题库分类"), "表头应含题库分类");
  const row = excel.answerToRow({ category: "情感类", title: "T", answer: "A", questionUrl: "https://x/1", status: "已提交" });
  assert.equal(row["题库分类"], "情感类");
  const back = excel.importRowToAnswer(row);
  assert.equal(back.category, "情感类", "导出→导入往返分类不丢");
});

test("Logger：日志账号自动打码（开关生效）", () => {
  const { Logger } = require("../../electron/src/log");
  const logger = new Logger("");
  const received = [];
  logger.onLog((text) => received.push(text));
  logger.setEnvLabels(["账号一", "测试号ABC"]);
  logger.log("打开比特环境：账号一（本账号 3 条）");
  logger.setMask(false);
  logger.log("打开比特环境：账号一");
  logger.setMask(true);
  logger.log("账号 测试号ABC 提交成功");
  assert.ok(received[0].includes("账*一"), `应打码：${received[0]}`);
  assert.ok(received[1].includes("账号一"), "关闭打码应显示明文");
  assert.ok(received[2].includes("测*C"), `长账号应打码：${received[2]}`);
});

test("config：activityUrl 非法值回退默认", () => {
  const bad = normalizeSettings({ activityUrl: "不是网址" });
  assert.equal(bad.activityUrl, "", "非法 URL 应清空（运行时回退默认活动页）");
  const good = normalizeSettings({ activityUrl: "https://zhidao.baidu.com/hd/xxx/" });
  assert.equal(good.activityUrl, "https://zhidao.baidu.com/hd/xxx/");
});

test("errors.describeError：错误分类标签", () => {
  const { describeError, classifyError } = require("../../electron/src/errors");
  assert.equal(classifyError(new Error("检测到百度安全验证")), "captcha");
  assert.equal(classifyError(new Error("net::ERR_CONNECTION_RESET")), "network");
  assert.equal(classifyError(new Error("没有找到回答输入框")), "page");
  assert.equal(classifyError(new Error("AI API 请求失败：HTTP 429")), "ai");
  assert.equal(classifyError(new Error("无法连接比特浏览器本地服务")), "browser");
  assert.ok(describeError(new Error("任意")).startsWith("【"));
});

test("Store 工具：questionKeys/recordKey", () => {
  const keys = questionKeys({ title: "A B", questionUrl: "https://X/1", questionContent: "C" });
  assert.deepEqual(keys, ["url:https://x/1", "title:ab", "content:c"]);
  assert.equal(recordKey({ questionUrl: "https://X/1" }), "url:https://x/1");
  assert.equal(recordKey({ title: "T", questionContent: "" }), "text:t:");
});
