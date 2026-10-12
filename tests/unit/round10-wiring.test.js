"use strict";

/**
 * 第 10 轮：设置项「接线」审计后的三处补漏（都有文件:行号证据，来自一次只读交叉核对）。
 *
 * 这类问题的共同特征是**用户设了、却没有任何效果，而且不报错**：
 *   ① 一键全自动的爬题阶段漏传 `crawlOutputDir` —— 设置页填了「爬取结果文件夹」，
 *      手动爬题会导出题库、自动跑批却从不导出（静默少做一件事，也不进产物清单）；
 *   ② 编排把转存的 `cc` 写死 `|| 1`，吃掉了「0=自动」语义 —— 用户配好多账号+独立代理，
 *      一键全自动仍强制串行，且无处可改；
 *   ③ 「搜资源」的翻页间隔只读 payload、从不看设置页 —— 用户改「翻页间隔」对搜资源零效果。
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { createAutoPipeline, ALL_STAGES } = require("../../electron/src/workflows/auto-pipeline");
const { resolvePageDelayMs } = require("../../electron/src/tasks/search-resources");
const { resolveNetdiskRoles } = require("../../electron/src/domain/account-topic");

// ─────────────────────────────────────────────────────────────
// ③ resolvePageDelayMs：payload 优先 → 设置页 → 兜底 1500
// ─────────────────────────────────────────────────────────────

test("resolvePageDelayMs：payload 没给时用设置页的翻页间隔（以前恒用 1500，设置不生效）", () => {
  assert.equal(resolvePageDelayMs({}, { pageDelayMs: 800 }), 800);
  assert.equal(resolvePageDelayMs({}, { pageDelayMs: 2500 }), 2500);
});

test("resolvePageDelayMs：payload 显式给了就用 payload（覆盖设置页）", () => {
  assert.equal(resolvePageDelayMs({ pageDelayMs: 300 }, { pageDelayMs: 800 }), 300);
});

test("resolvePageDelayMs：payload=0 是**合法值**（不等待），不能被当成'没给'而回落设置", () => {
  assert.equal(resolvePageDelayMs({ pageDelayMs: 0 }, { pageDelayMs: 800 }), 0);
});

test("resolvePageDelayMs：两边都没有时兜底 1500（比爬题保守）", () => {
  assert.equal(resolvePageDelayMs({}, {}), 1500);
  assert.equal(resolvePageDelayMs({}, null), 1500);
  assert.equal(resolvePageDelayMs(null, undefined), 1500);
});

test("resolvePageDelayMs：越界/非法值被夹到 [0,10000]", () => {
  assert.equal(resolvePageDelayMs({ pageDelayMs: -5 }, {}), 0);
  assert.equal(resolvePageDelayMs({ pageDelayMs: 999999 }, {}), 10000);
  assert.equal(resolvePageDelayMs({ pageDelayMs: "abc" }, { pageDelayMs: 800 }), 800, "非法 payload 回落设置");
});

// ─────────────────────────────────────────────────────────────
// ①② auto-pipeline：payload 接线
// ─────────────────────────────────────────────────────────────

/** 记录每次 startTask 的 {name,payload}（不像老 harness 用对象覆盖，爬题会跑多次） */
function rig(overrides = {}) {
  const calls = [];
  const logs = [];
  const artifactsOf = { result: null };
  const settings = {
    bitEnvs: ["账号1", "账号2"],
    browserMode: "protocol",
    crawlStartPage: 1,
    maxQuestions: 0,
    crawlOutputDir: "D:/导出题库",
    randomCount: 5,
    submitLimit: 0,
    accountDailyLimit: 0,
    dailyAnswerLimit: 0,
    accountTopics: {},
    topicRules: "",
    linkRouting: "strict",
    aiApiKey: "k",
    aiBaseUrl: "",
    aiModel: "m",
    aiConcurrency: 1,
    ...(overrides.settings || {}),
  };
  const deps = {
    config: { load: () => settings },
    startTask: async (name, payload, runner) => {
      calls.push({ name, payload });
      if (runner) return runner({
        payload,
        livePayload: () => payload,
        shouldStop: () => false,
        report: () => {},
        emitItem: () => {},
        pausePoint: async () => {},
      });
      if (name === "check-published") return { accounts: [] };
      return {};
    },
    taskDeps: () => ({}),
    pickQuestions: async () => ({ filePath: path.join("/tmp", "抽题.xlsx") }),
    emit: (channel, message) => logs.push(String(message)),
    pulse: () => {},
    dataDir: "/tmp/data",
    taskRunners: {
      crawl: async () => ({ count: 7, outputPath: "D:/导出题库/题库_情感类_x.xlsx" }),
      batchTransfer: async () => ({ count: 3, outputPath: "/tmp/上传专用表.xlsx" }),
      ...(overrides.taskRunners || {}),
    },
    CATEGORIES: ["情感类"],
    excel: { readTableRows: () => [], importRowToAnswer: (r) => r, answerToRow: (r) => r, ANSWER_HEADERS: [] },
    fs: { existsSync: () => true },
    path,
    resolveNetdiskRoles,
  };
  return { pipeline: createAutoPipeline(deps), calls, logs, settings, artifactsOf };
}

test("一键全自动·爬题：把设置页的「爬取结果文件夹」传给爬题任务（以前漏传→从不导出）", async () => {
  const r = rig();
  await r.pipeline.run({ stages: ["crawl"] });
  const crawls = r.calls.filter((c) => c.name === "crawl");
  assert.equal(crawls.length, 1);
  assert.equal(crawls[0].payload.crawlOutputDir, "D:/导出题库",
    "crawlOutputDir 必须透传，否则自动跑批永远不导出题库");
});

test("一键全自动·爬题：导出的题库文件进产物清单（用户第二天要知道东西在哪）", async () => {
  const r = rig();
  const result = await r.pipeline.run({ stages: ["crawl"] });
  const hit = (result.artifacts || []).find((a) => a.path === "D:/导出题库/题库_情感类_x.xlsx");
  assert.ok(hit, `导出文件应出现在产物清单，实际：${JSON.stringify(result.artifacts)}`);
});

test("一键全自动·爬题：爬题任务没给 outputPath 时，产物清单不该凭空多出「题库导出」", async () => {
  const r = rig({ taskRunners: { crawl: async () => ({ count: 7 }) } });  // 没有 outputPath
  const result = await r.pipeline.run({ stages: ["crawl"] });
  assert.equal((result.artifacts || []).filter((a) => a.label === "题库导出").length, 0);
});

test("一键全自动·转存：未指定 transferCc 时传 0（=自动），不再写死 1", async () => {
  const r = rig();
  await r.pipeline.run({ stages: ["transfer"], transferTablePath: "/tmp/资源表.xlsx" });
  const t = r.calls.find((c) => c.name === "batch-transfer");
  assert.ok(t, "转存阶段应被调用");
  assert.equal(t.payload.cc, 0, "0 会交给 batch-transfer 的自动判定（默认串行，配了独立代理才并行）");
});

test("一键全自动·转存：显式指定的 transferCc 要原样透传", async () => {
  const r = rig();
  await r.pipeline.run({ stages: ["transfer"], transferTablePath: "/tmp/资源表.xlsx", transferCc: 3 });
  const t = r.calls.find((c) => c.name === "batch-transfer");
  assert.equal(t.payload.cc, 3);
});

// 说明：这里只验证"编排层把值透传对了"。真正的并发裁决在 batch-transfer.resolveTransferParallelism，
// 已有第 6/9 轮的测试覆盖（必须 ≤ 账号数、且需要互补不相同的代理）。
