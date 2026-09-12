"use strict";

/**
 * 全链路 E2E：mock-site + 无头 Edge（CDP）
 * 爬题入库 → 随机抽题 → AI 生成 → 自动提交 → 提交结果核对
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createTestRig, fetchJson } = require("./helper");
const { runCrawlTask } = require("../../electron/src/tasks/crawl");
const { runGenerateTask } = require("../../electron/src/tasks/generate");
const { runSubmitTask } = require("../../electron/src/tasks/submit");
const { randomPickQuestions } = require("../../electron/src/tasks/random-pick");
const excel = require("../../electron/src/storage/excel");

test("E2E 全链路：爬题 → 抽题 → 生成 → 提交", { timeout: 300000, retry: 1 }, async (t) => {
  const rig = await createTestRig();
  t.after(async () => { await rig.cleanup(); });

  const noopCtx = {
    payload: null,
    shouldStop: () => false,
    livePayload() { return this.payload || {}; },
    updateLiveSettings: () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };

  // ---------- 1. 爬题（情感类 2 页 × 3 题 = 6 条） ----------
  {
    const ctx = { ...noopCtx, payload: { bitEnvs: [{ label: "账号1" }], category: "情感类", crawlStartPage: 1 } };
    const result = await runCrawlTask(ctx, rig.deps);
    assert.equal(result.stopped, false);
    assert.equal(result.count, 6, `应爬到 6 条，实际 ${result.count}；日志：\n${rig.logs.join("\n")}`);
    assert.equal(rig.deps.store.bankSize(), 6);

    const bank = rig.deps.store.loadBank();
    assert.ok(bank.every((item) => item.category === "情感类"));
    assert.ok(bank.every((item) => /^https?:\/\//.test(item.questionUrl)));
    assert.ok(bank.every((item) => item.title.includes("情感类")));
  }

  // ---------- 2. 随机抽题 4 条（跨轮去重由单元测试覆盖） ----------
  const bank = rig.deps.store.loadBank();
  const pick = randomPickQuestions(bank, [], { categories: ["情感类"], count: 4 });
  assert.equal(pick.picked.length, 4);

  // 导出 xlsx 并重新读入（验证表格链路）
  const xlsxPath = path.join(rig.dataDir, "抽题.xlsx");
  excel.writeWorkbook(xlsxPath, pick.picked.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS);
  const rowsFromExcel = excel.readTableRows(xlsxPath).map(excel.importRowToAnswer);
  assert.equal(rowsFromExcel.length, 4);
  assert.ok(rowsFromExcel.every((row) => row.questionUrl));

  // ---------- 3. AI 生成（mock LLM） ----------
  {
    const ctx = { ...noopCtx, payload: { results: rowsFromExcel, aiApiKey: "k", aiBaseUrl: `${rig.base}/v1/chat/completions`, aiModel: "mock" } };
    const result = await runGenerateTask(ctx, rig.deps);
    assert.equal(result.count, 4, "4 条都应生成成功");
    assert.equal(result.failed, 0);
    assert.ok(result.results.every((item) => item.answer.length > 20));
    assert.ok(rig.site.llmCalls.length >= 4, "LLM 被真实调用");
    assert.ok(rig.site.llmCalls[0].user.includes("A列标题"), "prompt 模板应透传标题");

    // 答案已入库，且 findAnswer 能恢复
    assert.ok(rig.deps.store.findAnswer(result.results[0]));
  }

  // ---------- 4. 自动提交前 2 条（无限额），提交状态写回表格 ----------
  {
    const rows = rowsFromExcel.map((row, index) => ({
      ...row,
      answer: rig.deps.store.findAnswer(row).answer,
      status: "已生成回答",
    })).slice(0, 2);
    const ctx = { ...noopCtx, payload: { bitEnvs: [{ label: "账号1" }], results: rows, accountDailyLimit: 0, filePath: xlsxPath } };
    const result = await runSubmitTask(ctx, rig.deps);
    assert.equal(result.count, 2, `应提交成功 2 条；日志：\n${rig.logs.join("\n")}`);
    assert.equal(result.failed, 0);

    // 表格状态应被写回：2 行已提交（跳过已提交保护下次生效）
    const reread = excel.readTableRows(xlsxPath).map(excel.importRowToAnswer);
    const submittedInSheet = reread.filter((row) => row.status === "已提交");
    assert.equal(submittedInSheet.length, 2, "表格应写回 2 条已提交状态");
  }

  const submissions = await fetchJson(`${rig.base}/api/submissions`);
  assert.equal(submissions.length, 2, "mock 站点应收到 2 条提交");
  assert.ok(submissions.every((item) => item.content && item.content.length > 20));
  assert.ok(submissions.every((item) => item.title.includes("情感类")));

  // ---------- 5. 记录状态核对 ----------
  const answers = rig.deps.store.loadAnswers();
  const submitted = answers.filter((item) => item.status === "已提交");
  assert.equal(submitted.length, 2, "答案记录应标记 2 条已提交");
  assert.ok(submitted.every((item) => item.submittedAt));
  assert.ok(submitted.every((item) => item.confirmed === true), "应捕捉到页面成功提示（回答提交成功）");
});

test("E2E：自动提交的每日限额生效", { timeout: 120000, retry: 1 }, async (t) => {
  const rig = await createTestRig();
  t.after(async () => { await rig.cleanup(); });

  const noopCtx = {
    payload: null,
    shouldStop: () => false,
    livePayload() { return this.payload || {}; },
    updateLiveSettings: () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };

  // 直接构造 3 条答案，账号每日限额 2 → 只提交 2 条
  const rows = [1, 2, 3].map((index) => ({
    title: `限额测试题${index}`,
    questionUrl: `${rig.base}/question/${900000 + index}`,
    answer: "这是用于验证每日限额的回答内容，长度超过二十个字符以通过校验。",
  }));

  // 题目页不存在（404 页），会走失败分支；改用真实题目：
  const questions = rig.site.questions.filter((item) => item.category === "情感类").slice(0, 3);
  for (let index = 0; index < 3; index += 1) {
    rows[index].questionUrl = `${rig.base}/question/${questions[index].id}`;
  }

  const ctx = { ...noopCtx, payload: { bitEnvs: [{ label: "账号1" }], results: rows, accountDailyLimit: 2 } };
  const result = await runSubmitTask(ctx, rig.deps);
  assert.equal(result.count, 2, "每日限额 2 条");
  assert.equal(result.total, 2, "总量按限额截断");
});

test("E2E：生成结果写回表格（抽题→生成→提交 回环）", { timeout: 120000, retry: 1 }, async (t) => {
  const rig = await createTestRig();
  t.after(async () => { await rig.cleanup(); });

  const noopCtx = {
    payload: null,
    shouldStop: () => false,
    livePayload() { return this.payload || {}; },
    updateLiveSettings: () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };

  // 1) 抽题 3 条 + 1 条重复行（同 URL）写入表格
  const bank = rig.site.questions.filter((item) => item.category === "情感类").slice(0, 3)
    .map((item) => ({ category: "情感类", title: item.title, questionContent: item.content, questionUrl: `${rig.base}/question/${item.id}` }));
  const rows = [...bank, { ...bank[0] }];
  const xlsxPath = path.join(rig.dataDir, "回环.xlsx");
  excel.writeWorkbook(xlsxPath, rows.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS);

  // 2) 生成（带 filePath）→ 表格应被写回
  const result = await runGenerateTask({ ...noopCtx, payload: { results: rows, filePath: xlsxPath, aiApiKey: "k", aiBaseUrl: `${rig.base}/v1/chat/completions`, aiModel: "mock" } }, rig.deps);
  assert.equal(result.count, 3, "去重后只生成 3 题");
  assert.ok(fs.statSync(xlsxPath).size > 0);

  // 3) 重新读表 → 每行（含重复行）都有答案 → 满足提交过滤条件
  const reread = excel.readTableRows(xlsxPath).map(excel.importRowToAnswer);
  assert.equal(reread.length, 4, "写回保留 4 行");
  assert.ok(reread.every((row) => String(row.answer).length > 20), "写回后每行都有答案");
  assert.ok(reread.every((row) => row.questionUrl), "写回保留题目链接");

  // 4) 直接用表格行走提交过滤 → 4 条全部可提交（不被丢弃）
  const submittable = reread.filter((row) => row.questionUrl && String(row.answer || "").trim());
  assert.equal(submittable.length, 4);
});

test("E2E：通过数读取（readDailyPassed）", { timeout: 120000, retry: 1 }, async (t) => {
  const { chromium } = require("playwright-core");
  const rig = await createTestRig();
  t.after(async () => { await rig.cleanup(); });

  const zhidao = require("../../electron/src/pages/zhidao");
  const browser = await chromium.connectOverCDP(rig.cdpUrl);
  t.after(async () => { await browser.close().catch(() => {}); });
  const page = await browser.contexts()[0].newPage();
  await page.goto(`${rig.base}/hd/21th_activity/`);
  const rows = await zhidao.readDailyPassed(page);
  assert.ok(rows.some((row) => row.done === 2 && row.total === 5), `应解析出 2/5 进度，实际：${JSON.stringify(rows)}`);
});

test("E2E：一键自检（selftest 全链路）", { timeout: 180000, retry: 1 }, async () => {
  const { runSelfTest } = require("../../electron/src/selftest");
  const logs = [];
  const result = await runSelfTest({ onLog: (message) => logs.push(message) });
  if (!result.ok) {
    console.error("自检日志：\n" + logs.join("\n"));
  }
  assert.equal(result.ok, true, "一键自检应全部通过");
  assert.ok(result.steps.length >= 7, `应有 7 个步骤，实际 ${result.steps.length}`);
  assert.ok(result.steps.every((step) => step.ok), "每个步骤都应成功");
});

test("E2E：分类参数化（教育类爬取）", { timeout: 120000, retry: 1 }, async (t) => {
  const rig = await createTestRig();
  t.after(async () => { await rig.cleanup(); });

  const noopCtx = {
    payload: null,
    shouldStop: () => false,
    livePayload() { return this.payload || {}; },
    updateLiveSettings: () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };
  const ctx = { ...noopCtx, payload: { bitEnvs: [{ label: "账号1" }], category: "教育类", crawlStartPage: 1 } };
  const result = await runCrawlTask(ctx, rig.deps);
  assert.equal(result.count, 6, `教育类应爬到 6 条，实际 ${result.count}`);
  const bank = rig.deps.store.loadBank();
  assert.ok(bank.every((item) => item.category === "教育类"), "入库分类应为教育类");
});

test("E2E：通过数任务（账号轮换 + 状态分类）", { timeout: 120000, retry: 1 }, async (t) => {
  const rig = await createTestRig();
  t.after(async () => { await rig.cleanup(); });

  const { runPassedCountTask } = require("../../electron/src/tasks/passed-count");
  const noopCtx = {
    payload: { bitEnvs: [{ label: "账号1" }] },
    shouldStop: () => false,
    livePayload() { return this.payload; },
    updateLiveSettings: () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };
  const result = await runPassedCountTask(noopCtx, rig.deps);
  assert.equal(result.accounts.length, 1);
  const account = result.accounts[0];
  assert.equal(account.bitEnv, "账号1");
  assert.ok(["completed", "partial", "unknown"].includes(account.status), `状态应合法：${account.status}`);
  assert.equal(account.done, 2, "应解析出 2/5");
  assert.equal(account.total, 5);
});

test("E2E：验证码页检测（waitForBaiduReady）", { timeout: 120000, retry: 1 }, async (t) => {
  const { chromium } = require("playwright-core");
  const rig = await createTestRig();
  t.after(async () => { await rig.cleanup(); });

  const zhidao = require("../../electron/src/pages/zhidao");
  const browser = await chromium.connectOverCDP(rig.cdpUrl);
  t.after(async () => { await browser.close().catch(() => {}); });
  const context = browser.contexts()[0];
  const page = await context.newPage();

  // mock 站点没有验证页，直接用 data URL 模拟安全验证页
  await page.goto("data:text/html;charset=utf-8,<html><body><h1>百度安全验证</h1><div>请完成下方验证</div></body></html>");
  const looksLikeVerify = await zhidao.pageLooksLikeVerify(page);
  assert.equal(looksLikeVerify, true, "应识别为验证页");

  await page.goto(`${rig.base}/hd/21th_activity/`);
  assert.equal(await zhidao.pageLooksLikeVerify(page), false, "正常页面不应误报");

  // 验证页在限时内不消失 → waitForBaiduReady 应抛错
  await page.goto("data:text/html;charset=utf-8,<html><body><h1>百度安全验证</h1></body></html>");
  await assert.rejects(
    () => zhidao.waitForBaiduReady(page, 3, { onLog: () => {} }),
    /安全验证/,
    "验证页持续存在时应抛出异常"
  );
});
