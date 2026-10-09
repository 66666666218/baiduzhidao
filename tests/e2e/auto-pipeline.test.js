"use strict";

/**
 * 一键全自动的 E2E：**通过编排器**（workflows/auto-pipeline.js）把整条链跑一遍。
 *
 * 为什么在已有 e2e 之外还要这一条：
 *   · tests/unit/auto-pipeline.test.js 用假依赖验的是**编排逻辑**（顺序、跳过、失败、停止）；
 *   · tests/e2e/pipeline.test.js 直接调各任务函数，验的是**任务本身**；
 *   · 契约⑤ 只用正则静态比对「编排传的字段」与「任务读的字段」。
 * 三者之间正好漏掉一件事：**编排拼出来的 payload，真实任务到底吃不吃**。
 * 那正是当初 generate 漏传 filePath 时踩的坑（生成"成功"、答案没写回表格）。
 * 这条测试把两者接起来跑，让那种错在 CI 里就炸。
 *
 * 全程 mock-site + 无头 Edge + 假 LLM，不碰真实百度账号。
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const { createTestRig, fetchJson } = require("./helper");
const { createAutoPipeline } = require("../../electron/src/workflows/auto-pipeline");
const { runCrawlTask } = require("../../electron/src/tasks/crawl");
const { runGenerateTask } = require("../../electron/src/tasks/generate");
const { runSubmitTask } = require("../../electron/src/tasks/submit");
const { randomPickQuestions } = require("../../electron/src/tasks/random-pick");
const { resolveNetdiskRoles } = require("../../electron/src/domain/account-topic");
const { CATEGORIES } = require("../../electron/src/config");
const excel = require("../../electron/src/storage/excel");

test("E2E 一键全自动：编排器 → 爬题 → 抽题 → 生成 → 提交（含表格写回）",
  { timeout: 300000, retry: 1 }, async (t) => {
    const rig = await createTestRig();
    t.after(async () => { await rig.cleanup(); });

    rig.deps.config.save({
      bitEnvs: [{ label: "账号1" }],
      crawlStartPage: 1,
      maxQuestions: 4,   // 只爬 4 条，够验证链路；0 = 不限，那条语义由单测盯着
      randomCount: 4,
      submitLimit: 2,
      accountDailyLimit: 0,
      dailyAnswerLimit: 0,
      linkRouting: "strict",
      aiApiKey: "test-key",
      aiBaseUrl: `${rig.base}/v1/chat/completions`,
      aiModel: "mock-model",
      aiConcurrency: 2,
    });

    const logs = [];
    const pulses = [];
    const submittedItems = [];

    // 只做 TaskManager 在这里真正必要的部分：造 ctx 并把 runner 跑起来。
    // 用真的任务函数，因为它们才是"payload 吃不吃得下"的裁判。
    const startTask = async (name, payload, runner) => runner({
      payload,
      shouldStop: () => false,
      livePayload: () => payload,
      updateLiveSettings: () => {},
      delay: async () => {},
      report: () => {},
      emitItem: (item) => { if (item && item.status === "已提交") submittedItems.push(item); },
      pausePoint: async () => {},
    });

    // 抽题：行为与 app-context 里那份一致（读题库 → 随机抽 → 写 xlsx）
    const pickQuestions = async ({ categories, count, outputPath }) => {
      const bank = rig.deps.store.loadBank();
      const picked = randomPickQuestions(bank, [], { categories, count });
      excel.writeWorkbook(outputPath, picked.picked.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS);
      return { canceled: false, filePath: outputPath, picked: picked.picked.length };
    };

    const pipeline = createAutoPipeline({
      config: rig.deps.config,
      startTask,
      taskDeps: () => rig.deps,
      pickQuestions,
      emit: (channel, message) => logs.push(message),
      pulse: (status = "running") => pulses.push(status),
      dataDir: rig.dataDir,
      taskRunners: {
        crawl: runCrawlTask,
        generate: runGenerateTask,
        submit: runSubmitTask,
      },
      CATEGORIES,
      excel,
      fs,
      path,
      resolveNetdiskRoles,
    });

    const result = await pipeline.run({
      stages: ["crawl", "pick", "generate", "submit"],
      categories: ["情感类"],
    });

    const detail = `\n编排日志：\n${logs.join("\n")}\n任务日志：\n${rig.logs.join("\n")}`;

    // ---------- 1. 四个阶段全绿、顺序正确、没有静默跳过 ----------
    assert.equal(result.ok, true, `编排应整体成功${detail}`);
    assert.deepEqual(result.skipped, [], `不该有被跳过的阶段${detail}`);
    assert.deepEqual(result.stages.map((s) => s.stage), ["crawl", "pick", "generate", "submit"],
      `阶段顺序应与流程一致${detail}`);
    assert.ok(result.stages.every((s) => s.ok), `每个阶段都应 ok${detail}`);
    assert.ok(pulses.includes("running"), "每个阶段开始都要发进度脉冲");
    assert.ok(!pulses.includes("failed"), `不该出现失败脉冲${detail}`);

    // ---------- 2. 爬题真的入库了 ----------
    assert.ok(rig.deps.store.bankSize() > 0, `题库应有题${detail}`);

    // ---------- 3. 抽题产物存在且条数对 ----------
    assert.ok(result.pickFile && fs.existsSync(result.pickFile), `抽题表应存在：${result.pickFile}${detail}`);
    const pickedRows = excel.readTableRows(result.pickFile).map(excel.importRowToAnswer);
    assert.equal(pickedRows.length, 4, `应抽到 4 条${detail}`);

    // ---------- 4. ★ 生成阶段真的把答案写回了表格 ----------
    // 这正是"漏传 filePath"那个 bug 的现场：生成阶段报成功，但表格里没有答案，
    // 紧接着提交报「表格里有题目链接但没有回答内容」。
    const afterGenerate = excel.readTableRows(result.pickFile).map(excel.importRowToAnswer);
    assert.ok(afterGenerate.every((row) => String(row.answer || "").trim().length > 20),
      `生成后表格里每行都应有答案（编排必须把 filePath 传给生成任务）${detail}`);
    assert.ok(afterGenerate.every((row) => row.questionUrl), "写回不该丢题目链接");

    // ---------- 5. 提交阶段按 submitLimit 提交，并把状态写回表格 ----------
    const submissions = await fetchJson(`${rig.base}/api/submissions`);
    assert.equal(submissions.length, 2, `mock 站点应收到 2 条提交${detail}`);
    assert.ok(submissions.every((item) => item.content && item.content.length > 20),
      `提交内容应是生成出来的答案${detail}`);

    const afterSubmit = excel.readTableRows(result.pickFile).map(excel.importRowToAnswer);
    assert.equal(afterSubmit.filter((row) => row.status === "已提交").length, 2,
      `表格应写回 2 条「已提交」（少了它下一轮会整表重复提交）${detail}`);

    assert.equal(submittedItems.length, 2, "应由提交阶段上报 2 条已提交");
  });
