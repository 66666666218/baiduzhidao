"use strict";

/**
 * 全新环境（模拟"换了一台新电脑"）空跑测试。
 *
 * 为什么需要它：今天连续踩的三个坑（chromium 未导入、权益门把"未知"当"没有"、
 * 今日额度统计了全部历史）有**同一个特征** —— 都是"新环境才走到"的代码路径：
 * 没有历史数据、没有存过的 Cookie、没有上传记录。开发机上跑一万遍也碰不到，
 * 一旦换机器就集中爆发。
 *
 * 这里把数据目录换成一个空目录，用空 payload 把每个任务入口调一遍，只断言一件事：
 * **抛出的必须是给人看的中文提示，而不是代码缺陷类异常**
 *（is not defined / is not a function / Cannot read properties of undefined ...）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Config } = require("../../electron/src/config");
const { Store } = require("../../electron/src/storage/store");
const { AccountManager } = require("../../electron/src/browser/account-manager");
const { runCrawlTask } = require("../../electron/src/tasks/crawl");
const { runGenerateTask } = require("../../electron/src/tasks/generate");
const { runSubmitTask } = require("../../electron/src/tasks/submit");
const { runPassedCountTask } = require("../../electron/src/tasks/passed-count");
const { runBatchTransferTask } = require("../../electron/src/tasks/batch-transfer");
const { runBatchUploadTask, runTopicUploadTask } = require("../../electron/src/tasks/upload-batch");

/** 代码缺陷类异常的特征 —— 出现这些说明是"代码写错了"，不是"用户在空环境下的正常提示" */
const CODE_DEFECT = /is not defined|is not a function|Cannot read propert|undefined is not|Cannot destructure|of undefined|of null/;

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-"));
  const config = new Config(dir);
  const settings = config.load();
  const store = new Store(dir, { owner: "test:fresh-env" });
  const logs = [];
  const deps = {
    settings,
    config,
    store,
    logs,
    dataDir: dir,
    log: (m) => logs.push(String(m)),
    // 空环境没有比特环境可开。让它抛一个明确的、非缺陷的错误：
    // 任务若在校验参数前就走到这里，也只会在日志里留下"测试环境不连浏览器"。
    browserPool: {
      acquire: async (env) => { throw new Error(`测试环境不连浏览器（env=${env}）`); },
      release: async () => {},
      closeAll: async () => {},
      adapter: { checkConnection: async () => ({ ok: true }) },
    },
  };
  return { dir, deps, store, settings, logs };
}

function freshCtx(payload) {
  return {
    payload,
    livePayload: () => payload,
    shouldStop: () => false,
    report: () => {},
    emitItem: () => {},
    pausePoint: async () => {},
  };
}

const CASES = [
  ["爬题", runCrawlTask],
  ["生成答案", runGenerateTask],
  ["自动提交", runSubmitTask],
  ["当天通过数", runPassedCountTask],
  ["批量转存", runBatchTransferTask],
  ["批量上传", runBatchUploadTask],
  ["按题材上传", runTopicUploadTask],
];

for (const [label, run] of CASES) {
  test(`全新环境空跑：${label} 抛出的必须是给人看的提示，而不是代码缺陷`, async () => {
    const { deps, store } = freshEnv();
    let message = "";
    try {
      await run(freshCtx({}), deps);
      message = "(正常返回)";
    } catch (error) {
      message = String((error && error.message) || error);
    } finally {
      try { store.flushAll(); store.releaseLock(); } catch { /* 忽略 */ }
    }
    assert.ok(
      !CODE_DEFECT.test(message),
      `${label} 在空环境下抛出了代码缺陷类异常（这类问题只在换新电脑时暴露）：\n  ${message}`
    );
  });
}

test("全新环境：Config.load() 在空目录下给出默认值而不是报错", () => {
  const { settings } = freshEnv();
  assert.ok(Array.isArray(settings.bitEnvs), "bitEnvs 应有默认值");
  assert.equal(typeof settings.accountDailyLimit, "number");
  assert.equal(typeof settings.maxQuestions, "number");
  assert.ok(settings.systemPrompt, "系统提示词应有默认值");
});

test("全新环境：Store 在空目录下各查询返回空而不是报错", () => {
  const { store } = freshEnv();
  try {
    assert.deepEqual(store.loadAnswers(), []);
    assert.equal(store.bankSize(), 0);
  } finally {
    try { store.flushAll(); store.releaseLock(); } catch { /* 忽略 */ }
  }
});

test("全新环境：TokenBucket / 账号额度从 0 起算（不该把不存在的历史算成已用）", () => {
  const { store } = freshEnv();
  try {
    const manager = new AccountManager({ store, dailyLimit: 10 });
    manager.register(["新账号"]);
    assert.equal(manager.usedToday("新账号"), 0);
    assert.doesNotThrow(() => manager.acquire("新账号"), "空数据下不该被额度拦住");
  } finally {
    try { store.flushAll(); store.releaseLock(); } catch { /* 忽略 */ }
  }
});

test("全新环境：合约守卫必须覆盖 electron/src（否则 chromium 那类事故会重演）", () => {
  const src = fs.readFileSync(path.join(__dirname, "contract.test.js"), "utf8");
  assert.match(src, /walkJs\("electron\/src"\)/, "契约⑥ 应扫描 electron/src");
  assert.match(src, /"electron\/main\.js"/, "契约⑥ 应扫描 main.js");
});

test("全新环境：空目录下 Config.load() 不该输出「解析失败」吓人", () => {
  // 以前 ENOENT 和真正的解析失败走同一个分支，新电脑第一次启动就会看到
  // 「settings.json 解析失败，且无法留底坏文件」，让人以为装坏了。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-cfg-"));
  const captured = [];
  const origError = console.error;
  console.error = (...args) => captured.push(args.join(" "));
  try {
    new Config(dir).load();
  } finally {
    console.error = origError;
  }
  assert.deepEqual(captured, [], `空目录（首次运行/换新电脑）不该产生错误输出：` + captured.join(" | "));
});
