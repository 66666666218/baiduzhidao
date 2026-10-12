"use strict";

/**
 * 第 7 轮：账号列表「去重」规则只落地了一个入口。
 *
 * 背景：第 6 轮修的是「上传只选了账号2，结果账号1+账号2 都上传了」，
 * 修法是给上传任务入口加了一道 `dedupeEnvLabels`。但同一条规则在仓库里
 * 其实有 **4 份**实现/调用：
 *   1. config.normalizeBitEnvs      —— 只在设置页保存时生效
 *   2. upload-batch.js 入口          —— 第 6 轮补了去重 ✅
 *   3. batch-transfer.js parseEnvList —— 只有 envLabelsOf，**没去重** ❌
 *   4. auto-pipeline.js normEnvs      —— 是 envLabelsOf 的逐行拷贝，**没去重** ❌
 * 于是「同名账号写两遍 → 一个名字一个 slot → 那个号被执行两遍」在批量转存和
 * 一键全自动里原封不动地活着。转存那条尤其严重：并行分支按 slot 绑账号，
 * 两个 slot 同名同 IP，正好撞上分享页的并发降级窗口（2026-10-10 实测 cc=2 → 9/9 失败）。
 *
 * 本轮把规则收敛到 `dedupeEnvLabels` 一份，并补上「去重掉的账号要留痕」。
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { dedupeEnvLabels, resolveNetdiskRoles } = require("../../electron/src/domain/account-topic");
const { parseEnvList, parseEnvListDetailed } = require("../../electron/src/tasks/batch-transfer");
const { createAutoPipeline, ALL_STAGES, normEnvs } = require("../../electron/src/workflows/auto-pipeline");

// ─────────────────────────────────────────────────────────────
// batch-transfer：转存入口
// ─────────────────────────────────────────────────────────────

test("parseEnvList：同一个账号写两遍只留一个（否则会生成两个同名 slot）", () => {
  assert.deepEqual(parseEnvList({ bitEnvs: ["账号1", "账号1", "账号2"] }), ["账号1", "账号2"]);
});

test("parseEnvList：字符串形式里的重复也要去重（逗号/换行/全角逗号分隔）", () => {
  assert.deepEqual(parseEnvList({ bitEnvs: "账号1,账号1, 账号2" }), ["账号1", "账号2"], "逗号");
  assert.deepEqual(parseEnvList({ bitEnvs: "账号1\n账号1\r\n账号2" }), ["账号1", "账号2"], "换行");
  assert.deepEqual(parseEnvList({ bitEnvs: "账号1，账号1，账号2" }), ["账号1", "账号2"], "全角逗号");
});

test("parseEnvList：带空格的重复算同一个账号（先 trim 再判重）", () => {
  // 这是最容易漏的一种：用户手抄名单时 "账号1" 和 " 账号1 " 看着一样，
  // 不去重的话会当成两个账号，其中一个取不到 Cookie、被当成"没登录"跳过。
  assert.deepEqual(parseEnvList({ bitEnvs: ["账号1", " 账号1 ", "账号2"] }), ["账号1", "账号2"]);
});

test("parseEnvList：{label}/{name} 对象形式的重复也要去重", () => {
  assert.deepEqual(
    parseEnvList({ bitEnvs: [{ label: "账号1" }, { name: "账号1" }, "账号2"] }),
    ["账号1", "账号2"],
  );
});

test("parseEnvListDetailed：把被去掉的名字报出来（去重必须留痕）", () => {
  const { labels, duplicated } = parseEnvListDetailed({ bitEnvs: ["账号1", "账号1", "账号2", "账号2", "账号3"] });
  assert.deepEqual(labels, ["账号1", "账号2", "账号3"]);
  assert.deepEqual(duplicated, ["账号1", "账号2"], "重复项按出现顺序报出，供日志提示用户");
});

test("parseEnvList：第 5 轮已有的解析行为不能被去重改动带坏", () => {
  assert.deepEqual(parseEnvList({ bitEnvs: "账号1, 账号2" }), ["账号1", "账号2"]);
  assert.deepEqual(parseEnvList({ bitEnvs: " 账号1 ,, 账号2 , " }), ["账号1", "账号2"], "空项要剔掉");
  assert.deepEqual(parseEnvList({ bitEnvs: [{ label: "账号1" }, { name: "账号2" }] }), ["账号1", "账号2"]);
  assert.deepEqual(parseEnvList({ bitEnv: "账号1" }), ["账号1"], "单账号兼容字段");
  assert.deepEqual(parseEnvList({ bitEnvs: "", bitEnv: "账号1" }), ["账号1"]);
  assert.deepEqual(parseEnvList({}), []);
  assert.deepEqual(parseEnvList(null), []);
});

// ─────────────────────────────────────────────────────────────
// auto-pipeline：编排层
// ─────────────────────────────────────────────────────────────

test("normEnvs：与 account-topic 同一套规则（含 trim / {label} / 剔空）", () => {
  assert.deepEqual(normEnvs(["A", { label: "B" }, { name: "C" }]), ["A", "B", "C"]);
  assert.deepEqual(normEnvs([" A ", "", null, undefined, 0]), ["A"]);
  assert.deepEqual(normEnvs(null), []);
});

test("normEnvs：现在也会去重（以前是 envLabelsOf 的拷贝，漏了这一步）", () => {
  assert.deepEqual(normEnvs(["A", "A", "B"]), ["A", "B"]);
  assert.deepEqual(normEnvs(["A", " A ", "B"]), ["A", "B"], "trim 后再判重");
  // 与共享函数的行为严格一致，防止以后又分叉成两份
  assert.deepEqual(normEnvs(["A", "A", "B"]), dedupeEnvLabels(["A", "A", "B"]).labels);
});

// ─────────────────────────────────────────────────────────────
// resolveNetdiskRoles：转存/上传分工
// ─────────────────────────────────────────────────────────────

test("resolveNetdiskRoles：base / transfer / upload 三份列表都去重", () => {
  const r = resolveNetdiskRoles(
    ["甲", "甲", "乙"],
    { transferEnvs: ["丙", "丙"], uploadEnvs: ["丁", " 丁 "] },
  );
  assert.deepEqual(r.transferEnvs, ["丙"], "转存名单去重");
  assert.deepEqual(r.uploadEnvs, ["丁"], "上传名单去重（含 trim 后判重）");
  assert.deepEqual(resolveNetdiskRoles(["甲", "甲", "乙"], {}).transferEnvs, ["甲", "乙"], "回落时 base 也要去重");
});

test("resolveNetdiskRoles：去重不能破坏原有回落语义", () => {
  const base = ["甲", "乙"];
  assert.deepEqual(resolveNetdiskRoles(base, {}), { transferEnvs: ["甲", "乙"], uploadEnvs: ["甲", "乙"] });
  assert.deepEqual(resolveNetdiskRoles(base, { transferEnvs: ["丙"] }).uploadEnvs, ["甲", "乙"],
    "只配了转存，上传仍回落到 base");
  assert.deepEqual(resolveNetdiskRoles(base, { transferEnvs: [{ label: "丙" }] }).transferEnvs, ["丙"],
    "对象形式也要认");
  assert.deepEqual(resolveNetdiskRoles([], { transferEnvs: "丙" }).transferEnvs, [], "非法值 → 空数组，不炸");
});

// ─────────────────────────────────────────────────────────────
// 端到端：一键全自动真的把去重后的名单传给下游，并且日志里留了痕
// ─────────────────────────────────────────────────────────────

/** 与 auto-pipeline.test.js 同构的最小装配台 */
function harness(overrides = {}) {
  const calls = [];
  const payloads = {};
  const logs = [];
  const settings = {
    bitEnvs: ["账号1", "账号2"],
    crawlStartPage: 1,
    maxQuestions: 0,
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
    startTask: async (name, payload) => {
      calls.push(name);
      payloads[name] = payload;
      if (name === "check-published") return { accounts: [] };
      return {};
    },
    taskDeps: () => ({}),
    pickQuestions: async () => ({ filePath: path.join("/tmp", "抽题.xlsx") }),
    emit: (channel, message) => logs.push(String(message)),
    pulse: () => {},
    dataDir: "/tmp/data",
    taskRunners: new Proxy({}, { get: () => async () => ({}) }),
    CATEGORIES: ["情感类"],
    excel: { readTableRows: () => [], importRowToAnswer: (r) => r, answerToRow: (r) => r, ANSWER_HEADERS: [] },
    fs: { existsSync: () => true },
    path,
    resolveNetdiskRoles,
  };
  return { pipeline: createAutoPipeline(deps), calls, payloads, logs, settings };
}

const WITH_TABLES = {
  transferTablePath: path.join("/tmp", "资源表.xlsx"),
  uploadTablePath: path.join("/tmp", "上传专用表.xlsx"),
};

test("一键全自动：payload 里账号重复 → 下游任务拿到的是去重后的名单", async () => {
  const h = harness();
  await h.pipeline.run({ stages: ALL_STAGES, bitEnvs: ["账号1", "账号1", "账号2"], ...WITH_TABLES });
  assert.deepEqual(h.payloads.submit.bitEnvs, ["账号1", "账号2"],
    "提交阶段收到重复账号会把它执行两遍");
});

test("一键全自动：去重掉的账号必须在日志里留痕（无人值守，不然无从查证）", async () => {
  const h = harness();
  await h.pipeline.run({ stages: ALL_STAGES, bitEnvs: ["账号1", "账号1", "账号2"], ...WITH_TABLES });
  const hit = h.logs.filter((l) => l.includes("重复名字"));
  assert.equal(hit.length, 1, "有重复时报且只报一次");
  assert.ok(hit[0].includes("账号1"), `要点名是哪个账号被去掉了，实际：${hit[0]}`);
});

test("一键全自动：payload 没指定时，设置页的重复账号同样去重并留痕", async () => {
  const h = harness({ settings: { bitEnvs: ["账号1", "账号1", "账号2"] } });
  await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });
  assert.deepEqual(h.payloads.submit.bitEnvs, ["账号1", "账号2"]);
  assert.ok(h.logs.some((l) => l.includes("重复名字") && l.includes("账号1")), "设置页来源也要留痕");
});

test("一键全自动：账号本来就不重复时不该报去重警告（别刷屏）", async () => {
  const h = harness();
  await h.pipeline.run({ stages: ALL_STAGES, bitEnvs: ["账号1", "账号2"], ...WITH_TABLES });
  assert.deepEqual(h.payloads.submit.bitEnvs, ["账号1", "账号2"]);
  assert.equal(h.logs.filter((l) => l.includes("重复名字")).length, 0);
});
