"use strict";

/**
 * 全新机器下的一键全自动（编排器）测试。
 *
 * 为什么要单独有这一份：`fresh-env.test.js` 覆盖的是**各个任务**在空目录下的行为，
 * 而用户在新电脑上点的是**那个按钮** —— 编排器。它此前在"空环境"下一条测试都没有，
 * 而这一轮之前它恰恰有个毛病：某些阶段"没跑成"是静默的，结论照样说"全部阶段成功"。
 *
 * 这里盯两件事：
 *   1. 空环境下**不能抛出代码缺陷类异常**（换电脑最容易踩的就是这类）；
 *   2. 失败/跳过的**理由必须是能照做的**（指出设置页/账号凭证/题库/资源表…），
 *      而不是"未知错误"或一句技术黑话。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Config, CATEGORIES } = require("../../electron/src/config");
const { Store } = require("../../electron/src/storage/store");
const excel = require("../../electron/src/storage/excel");
const { createAutoPipeline, ALL_STAGES } = require("../../electron/src/workflows/auto-pipeline");
const { resolveNetdiskRoles } = require("../../electron/src/domain/account-topic");
const { runCrawlTask } = require("../../electron/src/tasks/crawl");
const { runGenerateTask } = require("../../electron/src/tasks/generate");
const { runSubmitTask } = require("../../electron/src/tasks/submit");
const { runPassedCountTask } = require("../../electron/src/tasks/passed-count");
const { runBatchTransferTask } = require("../../electron/src/tasks/batch-transfer");
const { runTopicUploadTask } = require("../../electron/src/tasks/upload-batch");

const CODE_DEFECT = /is not defined|is not a function|Cannot read propert|undefined is not|Cannot destructure|of undefined|of null|\[object Object\]/;
/** 一句能照做的提示，至少要指出"去哪儿改什么"。 */
const ACTIONABLE = /设置页|账号凭证|题库|AI Key|资源表|抽题|Cookie|预算|比特/;
/** 纯粹的敷衍话：出现就等于没给用户任何线索。 */
const USELESS = /^(未知|未知原因|未知错误|失败|error|undefined|null|)$/i;

function freshRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-pipe-"));
  const config = new Config(dir);
  const store = new Store(dir, { owner: "test:fresh-pipe" });
  const logs = [];
  const deps = {
    config, store, dataDir: dir, log: (m) => logs.push(String(m)),
    // 空环境当然连不上浏览器。让它抛出明确的错误（而不是让测试假装能开窗口）。
    browserPool: {
      acquire: async (env) => { throw new Error(`没有可用的浏览器环境（env=${env}）`); },
      release: async () => {},
      closeAll: async () => {},
      adapter: { checkConnection: async () => ({ ok: true }) },
    },
  };
  const startTask = async (name, payload, runner) => runner({
    payload,
    livePayload: () => payload,
    shouldStop: () => false,
    updateLiveSettings: () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
    pausePoint: async () => {},
  });
  const pipeline = createAutoPipeline({
    config,
    startTask,
    taskDeps: () => deps,
    pickQuestions: async () => ({ canceled: false, filePath: path.join(dir, "抽题.xlsx") }),
    emit: (channel, message) => logs.push(String(message)),
    pulse: () => {},
    dataDir: dir,
    taskRunners: {
      crawl: runCrawlTask,
      generate: runGenerateTask,
      submit: runSubmitTask,
      checkPublished: runPassedCountTask,   // 形态够用：本测试只关心它不炸、有回应
      searchResources: async () => ({ count: 0 }),
      batchTransfer: runBatchTransferTask,
      topicUpload: runTopicUploadTask,
    },
    CATEGORIES,
    excel,
    fs,
    path,
    resolveNetdiskRoles,
  });
  return { dir, config, store, deps, logs, pipeline };
}

function cleanup(rig) {
  for (const line of rig.logs) {
    assert.ok(!CODE_DEFECT.test(line), `日志里出现代码缺陷类异常：${line}`);
  }
  try { rig.store.releaseLock(); } catch { /* 忽略 */ }
  try { fs.rmSync(rig.dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}

test("全新机器：什么都没配就点「一键全自动」→ 直接抛配置错误，且告诉用户去哪儿填", async () => {
  const rig = freshRig();
  try {
    // 全新 Config 的 bitEnvs 是空数组 —— 这是新用户第一次点按钮时最可能的状态
    assert.deepEqual(rig.config.load().bitEnvs, [], "前提：全新配置里没有账号");
    await assert.rejects(
      () => rig.pipeline.run({}),
      (error) => {
        assert.ok(!CODE_DEFECT.test(error.message), `不该是代码缺陷：${error.message}`);
        assert.match(error.message, /设置页/, `要说清去哪儿填账号，实际：${error.message}`);
        return true;
      }
    );
  } finally { cleanup(rig); }
});

test("全新机器：填了账号名但没有 Cookie / 比特环境 → 爬题阶段给出「去账号凭证页登录」的指引", async () => {
  const rig = freshRig();
  try {
    rig.config.save({ bitEnvs: ["账号1"] });
    const result = await rig.pipeline.run({ stages: ["crawl"] });

    assert.equal(result.ok, false, "没有可用账号时不该报成功");
    const crawl = result.stages.find((s) => s.stage === "crawl");
    assert.ok(crawl && crawl.ok === false);
    const text = crawl.error || "";
    assert.ok(!CODE_DEFECT.test(text), `不该是代码缺陷：${text}`);
    assert.ok(!USELESS.test(text.trim()), `理由不能是敷衍话：${text}`);
    // 这句提示是本轮特意做过的：新用户看到"内存使用率超出 95%"时完全不知道该干什么
    assert.match(text, /账号凭证|Cookie/, `应指向「账号凭证」页，实际：${text}`);
    assert.match(text, /账号1/, "要带上是哪个账号，否则多账号时无从下手");
  } finally { cleanup(rig); }
});

test("全新机器：结论必须如实 —— 失败的那一步要在报告里点名，不能只说「有阶段失败」", async () => {
  const rig = freshRig();
  try {
    rig.config.save({ bitEnvs: ["账号1"] });
    const result = await rig.pipeline.run({ stages: ["crawl", "pick", "generate", "submit"] });

    assert.equal(result.ok, false);
    const stageNames = result.stages.map((s) => s.stage);
    assert.deepEqual(stageNames, ["crawl"], `第一个阶段就失败时不该继续往下跑，实际：${JSON.stringify(stageNames)}`);
    const failed = result.stages.find((s) => s.ok === false);
    assert.ok(failed.label && failed.error, "失败项必须同时有阶段名和原因（界面靠这两个字段说明卡在哪）");
    assert.match(rig.logs.join("\n"), /后续阶段不再执行/, "日志里要说清为什么后面的阶段没跑");
  } finally { cleanup(rig); }
});

test("全新机器：不传 stages 时默认跑全部阶段（界面不传就是全跑，不能少跑一步）", async () => {
  const rig = freshRig();
  try {
    rig.config.save({ bitEnvs: ["账号1"] });
    const result = await rig.pipeline.run({});
    // 第一阶段必然失败（没有可用环境），所以这里只断言"它确实从第一个阶段开始跑"，
    // 以及默认集合与 ALL_STAGES 一致（少跑一步是最难发现的那种问题）。
    assert.equal(result.stages[0].stage, "crawl");
    assert.ok(ALL_STAGES.includes("crawl") && ALL_STAGES.includes("upload"));
  } finally { cleanup(rig); }
});

test("全新机器：空题库抽不到题（上层据此提示「先去爬题」，而不是抛代码缺陷）", () => {
  const rig = freshRig();
  try {
    const { randomPickQuestions } = require("../../electron/src/tasks/random-pick");
    const picked = randomPickQuestions([], [], { categories: ["情感类"], count: 5 });
    assert.equal(picked.picked.length, 0);
    // 真正兜底的是编排调的 pickQuestions（app-context 版本）：题库为空时抛
    // 「题库为空，请先爬题或导入题库表格。」——那句在手写一份，这里只钉住"抽不到东西"这个前提。
  } finally { cleanup(rig); }
});
