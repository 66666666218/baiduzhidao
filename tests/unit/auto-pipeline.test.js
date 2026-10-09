"use strict";

/**
 * 一键全自动编排的单测。全部用**假依赖**（这个模块不 import electron，就是为了这个）。
 *
 * 这套测试要钉死的是"结论必须诚实"这件事 —— 编排最容易出的不是崩溃，而是
 * **漏报**：某个阶段没跑成，但既不进 report 也不算失败，最后告诉用户"全部阶段成功"，
 * 而用户等的恰恰是那一步。历史上真实的两个例子：
 *   · 抽题没产出 → 生成/提交静默跳过，界面说"全部阶段成功"；
 *   · 所有上传账号都没有批量发布权益 → 上传整段跳过，界面还是说"全部阶段成功"。
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { createAutoPipeline, ALL_STAGES, normEnvs, summarizeStage } = require("../../electron/src/workflows/auto-pipeline");

/** 造一套假依赖：记录调用顺序，结果/异常可逐阶段定制 */
function harness(overrides = {}) {
  const calls = [];       // startTask 调用过的任务名
  const payloads = {};    // name -> payload
  const logs = [];
  const pulses = [];      // 收到的进度脉冲状态序列（"running" / "failed"）
  // startTask 是**在装配时就取走**的（工厂里解构），所以测试不能事后替换 h.deps.startTask，
  // 只能通过 overrides.taskResults / overrides.onTask 定制（它们在调用时才读）。
  let pipelineRef = null;
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
      if (typeof overrides.onTask === "function") overrides.onTask(name, pipelineRef);
      const handler = (overrides.taskResults || {})[name];
      if (handler === "throw") throw new Error(`${name} 炸了`);
      if (typeof handler === "function") return handler(payload);
      if (name === "check-published") return { accounts: (overrides.accounts || []) };
      if (name === "search-resources") return {};
      return {};
    },
    taskDeps: () => ({}),
    pickQuestions: async (/* payload */) => {
      calls.push("pick");
      if (overrides.pickCanceled) return { canceled: true };
      if (overrides.pickThrows) throw new Error("题库为空");
      return { filePath: path.join("/tmp", "抽题.xlsx") };
    },
    emit: (channel, message) => logs.push(message),
    pulse: (status = "running") => { pulses.push(status); },
    dataDir: "/tmp/data",
    taskRunners: new Proxy({}, { get: () => async () => ({}) }),
    CATEGORIES: ["情感类"],
    excel: { readTableRows: () => [], importRowToAnswer: (r) => r, answerToRow: (r) => r, ANSWER_HEADERS: [] },
    fs: { existsSync: () => overrides.fileExists !== false },
    path,
    resolveNetdiskRoles: (bitEnvs, p) => ({
      transferEnvs: normEnvs(p.transferEnvs).length ? normEnvs(p.transferEnvs) : bitEnvs,
      uploadEnvs: normEnvs(p.uploadEnvs).length ? normEnvs(p.uploadEnvs) : bitEnvs,
    }),
  };

  const pipeline = createAutoPipeline(deps);
  pipelineRef = pipeline;
  return { pipeline, calls, payloads, logs, settings, deps, ov: overrides, pulses };
}

/** 两个阶段都要用到文件路径（转存要有资源表、上传要有上传专用表），否则会被判为跳过 */
const WITH_TABLES = {
  transferTablePath: path.join("/tmp", "资源表.xlsx"),
  uploadTablePath: path.join("/tmp", "上传专用表.xlsx"),
};

const stageOf = (result, name) => (result.stages || []).find((s) => s.stage === name);

test("normEnvs：字符串与 {label} 两种写法都认，空值剔掉", () => {
  assert.deepEqual(normEnvs(["A", { label: "B" }, { name: "C" }]), ["A", "B", "C"]);
  assert.deepEqual(normEnvs([" A ", "", null, undefined, 0]), ["A"]);
  assert.deepEqual(normEnvs(null), []);
});

test("全阶段：按顺序跑完，报告里每一步都有记录，结论为成功且没有跳过", async () => {
  const h = harness();
  const result = await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });

  // 权益门在转存之前：它决定"哪些账号能上传"，转存要用它算出来的那批号去搜资源
  assert.deepEqual(h.calls,
    ["crawl", "pick", "generate", "submit", "check-published", "batch-transfer", "upload-by-topic", "check-published"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, []);
  // 爬题按分类逐次跑
  assert.equal(h.calls.filter((c) => c === "crawl").length, 1);
  // check-published 被调了两次：一次权益门、一次查收录
  assert.equal(h.calls.filter((c) => c === "check-published").length, 2);
  assert.ok(h.pulses.length > 0, "每个阶段开始都要发一次进度脉冲，否则界面像卡死");
});

test("阶段顺序：报告里的顺序必须与流程一致（用户是靠这个看卡在哪一步）", async () => {
  const h = harness();
  const result = await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });
  assert.deepEqual(result.stages.map((s) => s.stage),
    ["crawl", "pick", "generate", "submit", "checkPermission", "transfer", "upload", "checkPublished"]);
});

test("★ 回归：勾了「生成答案」但没勾「抽题」——必须记为跳过，不能装作跑过了", async () => {
  const h = harness();
  const result = await h.pipeline.run({ stages: ["generate", "submit"] });

  assert.ok(!h.calls.includes("generate"), "没有抽题产物，生成不该被调用");
  const g = stageOf(result, "generate");
  const s = stageOf(result, "submit");
  assert.ok(g && g.skipped, "生成阶段必须在报告里留下一条跳过记录");
  assert.match(g.error, /抽题/);
  assert.ok(s && s.skipped);
  // 关键：ok 仍然是 true（没有任何阶段失败），所以**界面必须靠 skipped 才知道不能报"全部成功"**
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped.map((x) => x.stage).sort(), ["generate", "submit"]);
});

test("抽题失败/被取消：下游不再跑，失败本身是结论（不再逐条补「跳过」，那只是啰嗦）", async () => {
  const canceled = harness({ pickCanceled: true });
  const r1 = await canceled.pipeline.run({ stages: ["pick", "generate"] });
  assert.equal(r1.ok, false);
  assert.equal(stageOf(r1, "pick").ok, false);
  assert.match(stageOf(r1, "pick").error, /取消/);
  assert.ok(!canceled.calls.includes("generate"), "前面失败了就不该再往下跑");
  assert.deepEqual(r1.skipped, [], "失败已由 ❌ 呈现，下游不必再各挂一条跳过");

  const thrown = harness({ pickThrows: true });
  const r2 = await thrown.pipeline.run({ stages: ["pick", "generate"] });
  assert.equal(r2.ok, false);
  assert.match(stageOf(r2, "pick").error, /题库为空/);
});

test("★ 回归：所有上传账号都没有批量发布权益 —— 上传要记为跳过，并说清原因", async () => {
  const h = harness({ accounts: [{ envLabel: "账号1", hasPermission: false }, { envLabel: "账号2", hasPermission: false }] });
  const result = await h.pipeline.run({ stages: ["upload"] });

  assert.ok(!h.calls.includes("upload-by-topic"), "被权益门拦掉就不该真去上传");
  const u = stageOf(result, "upload");
  assert.ok(u && u.skipped);
  assert.match(u.error, /批量发布权益|未登录/);
  assert.deepEqual(result.skipped.map((x) => x.stage), ["upload"]);
});

test("权益未知（hasPermission=null）不算被拒 —— 不能因为查不到就误封账号", async () => {
  const h = harness({ accounts: [{ envLabel: "账号1", hasPermission: null, ok: false }] });
  await h.pipeline.run({ stages: ["upload"], uploadTablePath: path.join("/tmp", "上传专用表.xlsx") });
  assert.ok(h.calls.includes("upload-by-topic"), "只有在明确 hasPermission===false 时才拦");
});

test("某阶段抛错：后续阶段不再执行，结论为失败并指出卡在哪个阶段", async () => {
  const h = harness({ taskResults: { generate: "throw" } });
  const result = await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });

  assert.equal(result.ok, false);
  assert.ok(h.calls.includes("generate"));
  assert.ok(!h.calls.includes("submit"), "失败之后不该继续往下跑");
  assert.ok(!h.calls.includes("batch-transfer"));
  const g = stageOf(result, "generate");
  assert.equal(g.ok, false);
  assert.equal(g.skipped, undefined, "失败不是跳过，两者不能混");
  assert.match(h.logs.join("\n"), /在「生成答案」中断|生成答案」失败/);
});

test("手动停止：阶段之间停下，后续记为「已停止」，结论是 stopped 而不是成功", async () => {
  const h = harness();
  // 爬题一开始就模拟用户点了停止（onTask 在 startTask 调用时才读，所以能事后挂上）
  h.ov.onTask = (name, p) => { if (name === "crawl") p.abort(); };
  const result = await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });

  assert.equal(result.stopped, true);
  assert.equal(result.ok, false, "手动停止不是成功 —— 以前这里因为旗标被提前复位，永远是 false");
  assert.ok(!h.calls.includes("submit"));
  const later = result.stages.filter((s) => s.error === "已停止");
  assert.ok(later.length >= 2, "停止之后每个阶段都要有记录");
  assert.deepEqual(result.skipped, [], "「已停止」不该混进跳过清单里再说一遍");
});

test("停止旗标在下一轮开始时复位：上一轮的停止不能把下一轮也掐死", async () => {
  const h = harness();
  h.ov.onTask = (name, p) => { if (name === "crawl") p.abort(); };
  await h.pipeline.run({ stages: ["crawl", "pick"] });
  h.ov.onTask = null;
  const second = await h.pipeline.run({ stages: ["crawl", "pick"] });
  assert.equal(second.stopped, false);
  assert.equal(second.ok, true);
});

test("没有账号：直接抛配置错误（让界面显示「请先去设置页填账号」），不写进阶段报告", async () => {
  const h = harness({ settings: { bitEnvs: [] } });
  await assert.rejects(() => h.pipeline.run({ stages: ALL_STAGES }), /比特环境名称/);
  assert.deepEqual(h.calls, []);
});

test("只勾一个阶段时，别的阶段既不入报告也不算跳过（那是用户的意思，不是漏跑）", async () => {
  const h = harness();
  const result = await h.pipeline.run({ stages: ["pick"] });
  assert.deepEqual(result.stages.map((s) => s.stage), ["pick"]);
  assert.deepEqual(result.skipped, []);
});

test("转存：没给资源表且自动搜索也没产出 → 记为跳过而不是静默消失", async () => {
  const h = harness({ fileExists: false });
  const result = await h.pipeline.run({ stages: ["transfer"] });
  const t = stageOf(result, "transfer");
  assert.ok(t && t.skipped);
  assert.match(t.error, /资源表/);
  assert.ok(h.calls.includes("search-resources"), "没给资源表时应先自动搜一遍");
});

test("转存账号分工：转存账号 / 搜资源账号各按自己的那批走", async () => {
  // 没给资源表 → 走"自动搜资源"，此时搜的是**上传账号**那批（题材绑定挂在它们身上）
  const searching = harness();
  await searching.pipeline.run({ stages: ["transfer"], bitEnvs: ["账号1"], transferEnvs: ["甲"], uploadEnvs: ["乙"] });
  assert.deepEqual(searching.payloads["search-resources"].bitEnvs, ["乙"]);

  // 给了资源表 → 直接转存，用的是**转存账号**
  const direct = harness();
  await direct.pipeline.run({ stages: ["transfer"], bitEnvs: ["账号1"], transferEnvs: ["甲"], uploadEnvs: ["乙"], transferTablePath: path.join("/tmp", "资源表.xlsx") });
  assert.deepEqual(direct.payloads["batch-transfer"].bitEnvs, ["甲"]);

  // 都没指定 → 回落到"本次参与的账号"
  const fallback = harness();
  await fallback.pipeline.run({ stages: ["transfer"], bitEnvs: ["账号1"], transferTablePath: path.join("/tmp", "资源表.xlsx") });
  assert.deepEqual(fallback.payloads["batch-transfer"].bitEnvs, ["账号1"]);
});

test("转存产出的上传专用表会喂给上传阶段，不用人工再选一次文件", async () => {
  const out = path.join("/tmp", "上传专用表.xlsx");
  const h = harness();
  h.ov.taskResults = { "batch-transfer": () => ({ outputPath: out, count: 3 }) };
  const result = await h.pipeline.run({ stages: ["transfer", "upload"], ...WITH_TABLES });
  assert.ok(result.ok);
  assert.equal(h.payloads["upload-by-topic"].filePath, out);
});

test("生成阶段必须把 filePath 传给任务（少了它答案只留在内存里，提交阶段会读空）", async () => {
  const h = harness();
  await h.pipeline.run({ stages: ["pick", "generate"] });
  assert.ok(h.payloads.generate.filePath, "生成任务只在给了 filePath 时才写回表格");
  assert.deepEqual(h.payloads.generate.bitEnvs, undefined, "生成不需要账号，别把 bitEnvs 塞进去");
});

test("★ 回归：失败发生在任务启动之前时，必须补一条终止进度（否则界面永久停在运行中）", async () => {
  // pulse 把界面切成"运行中"（按钮禁用）之后，本来是靠任务自己发 done/failed 收尾的。
  // 而"题库为空"这类错误抛在 startTask **之前** —— 不收尾的话按钮一直点不动。
  const h = harness({ pickThrows: true });
  const result = await h.pipeline.run({ stages: ["pick"] });

  assert.equal(result.ok, false);
  assert.equal(h.pulses[0], "running", "阶段开始先切运行中");
  assert.equal(h.pulses[h.pulses.length - 1], "failed", "收尾必须是终止状态");
});

test("重入保护：连点两次「开始」，第二次直接拒绝（否则它会把第一次的停止旗标清掉）", async () => {
  const h = harness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.ov.taskResults = { crawl: () => gate };   // 让第一次卡在第一阶段

  const first = h.pipeline.run({ stages: ["crawl"] });
  await new Promise((r) => setTimeout(r, 0));   // 让第一次真正进入 crawl
  await assert.rejects(() => h.pipeline.run({ stages: ["crawl"] }), /正在运行中/);

  release();
  const result = await first;
  assert.equal(result.ok, true, "第一次不该被第二次影响");
});

// ---------- 阶段摘要：结果表不能只写「✅ 爬题」 ----------
// 整链是无人值守跑的，用户第二天回来看的就是结果表那几行。爬了 0 题也叫成功，
// 所以每个阶段必须报出"做出了多少"，异常数字才有机会被一眼看见。

test("summarizeStage：每个阶段都报出实际做出了多少", () => {
  assert.equal(summarizeStage("crawl", { added: 7 }), "新增 7 题");
  assert.equal(summarizeStage("pick", { count: 12, filePath: "D:/x/抽题.xlsx" }), "抽到 12 条 → D:/x/抽题.xlsx");
  assert.equal(summarizeStage("generate", { count: 12, failed: 0 }), "生成 12 条");
  assert.equal(summarizeStage("generate", { count: 10, failed: 2 }), "生成 10 条，失败 2 条");
  assert.equal(summarizeStage("submit", { count: 9, failed: 1 }), "提交成功 9 条，失败 1 条");
  assert.equal(summarizeStage("search", { count: 30 }), "搜到 30 条资源");
  assert.equal(summarizeStage("transfer", { count: 25, outputPath: "D:/y/上传表.xlsx" }), "转存 25 条 → D:/y/上传表.xlsx");
  assert.equal(summarizeStage("upload", { uploaded: 480 }), "上传 480 行");
});

test("summarizeStage：权益门报「可用账号数」，不能把「查不到」算成「没有」", () => {
  // hasPermission=null 是"未知"（未登录/查询失败），按可用算 —— 与编排里的权益门同一口径
  const accounts = [
    { envLabel: "A", hasPermission: true },
    { envLabel: "B", hasPermission: null },
    { envLabel: "C", hasPermission: false },
  ];
  assert.equal(summarizeStage("checkPermission", { accounts }), "可用上传账号 2/3 个");
  assert.equal(summarizeStage("checkPermission", { accounts: [] }), "", "一个账号都没查到时不必显示");
});

test("summarizeStage：查收录的「已收录」要按账号 summary 累加（checked 是账号数，不是条数）", () => {
  const r = {
    checked: 2,   // 成功核对到的**账号数**
    failedRows: 3,
    accounts: [
      { envLabel: "A", ok: true, summary: { successRows: 40, failedRows: 3 } },
      { envLabel: "B", ok: true, summary: { successRows: 10, failedRows: 0 } },
      { envLabel: "C", ok: false, hasPermission: null, error: "未登录" },
    ],
  };
  assert.equal(summarizeStage("checkPublished", r), "已收录 50 条，被拒 3 条");
  // 查了但一个都没核对成功：不能只留一个光秃秃的 ✅（那和"核对了、结果为零"长得一样），
  // 也不能显示"已收录 0 条"（那会被读成"确实收录了 0 条"）。
  assert.match(summarizeStage("checkPublished", { accounts: [{ envLabel: "C", ok: false }] }), /未核对到任何账号/);
  assert.equal(summarizeStage("checkPublished", { accounts: [] }), "", "压根没查时不必显示");
});

test("summarizeStage：字段缺失/非数字一律给 0，摘要里绝不出现 NaN/undefined", () => {
  for (const stage of ["crawl", "pick", "generate", "submit", "search", "transfer", "upload"]) {
    const text = summarizeStage(stage, undefined);
    assert.doesNotMatch(text, /NaN|undefined|null/, `${stage} 的摘要不该带 NaN/undefined：${text}`);
  }
  assert.equal(summarizeStage("pick", { count: "abc" }), "抽到 0 条");
  assert.equal(summarizeStage("不存在的阶段", { count: 1 }), "");
});

test("报告里成功阶段带 summary、失败/跳过阶段带 error（两者不同时出现）", async () => {
  const h = harness();
  // crawl 阶段会把任务的 `count` 累加成自己的 `added`（真实任务返回的是 count）
  h.ov.taskResults = { crawl: () => ({ count: 5 }) };
  const result = await h.pipeline.run({ stages: ["crawl", "pick"] });

  const crawl = stageOf(result, "crawl");
  assert.equal(crawl.summary, "新增 5 题");
  assert.equal(crawl.error, undefined, "成功的阶段不该有 error");

  const failed = harness({ taskResults: { crawl: "throw" } });
  const r2 = await failed.pipeline.run({ stages: ["crawl"] });
  assert.equal(stageOf(r2, "crawl").summary, undefined, "失败的阶段不该有 summary");
  assert.ok(stageOf(r2, "crawl").error);
});

// ---------- 本轮产出清单 ----------
// 无人值守跑完之后，用户最先想知道的是"东西在哪"。这些路径以前只散落在日志里。

test("artifacts：抽题表/上传专用表/收录核对/被拒明细都要进清单", async () => {
  const pick = path.join("/tmp", "抽题.xlsx");
  const uploadTable = path.join("/tmp", "上传专用表.xlsx");
  const collect = path.join("/tmp", "收录核对.xlsx");
  const rejected = path.join("/tmp", "被拒明细.xlsx");
  const h = harness({ accounts: [{ envLabel: "账号1", hasPermission: true }] });
  h.ov.taskResults = {
    "batch-transfer": () => ({ outputPath: uploadTable, count: 3 }),
    "check-published": () => ({ accounts: [{ envLabel: "账号1", ok: true, summary: { successRows: 3, failedRows: 1 } }], outputPath: collect, failedPath: rejected, failedRows: 1, checked: 1 }),
  };

  const result = await h.pipeline.run({ stages: ["pick", "generate", "transfer", "upload"], ...WITH_TABLES, uploadTablePath: "" });
  const paths = result.artifacts.map((a) => a.path);

  assert.ok(paths.includes(pick), `抽题表应在产物里：${JSON.stringify(result.artifacts)}`);
  assert.ok(paths.includes(uploadTable), "转存产出应进产物");
  assert.ok(paths.includes(collect) && paths.includes(rejected), "收录核对与被拒明细都应进产物");
  assert.ok(result.artifacts.every((a) => a.label && a.path), "每条都要有名字和路径");
});

test("artifacts：空路径不进清单（否则界面上会出现点不开的按钮）", async () => {
  const h = harness();
  h.ov.taskResults = {
    // 查收录没产出任何表（一条都没核对上），outputPath/failedPath 都是空串
    "check-published": () => ({ accounts: [], outputPath: "", failedPath: "", failedRows: 0, checked: 0 }),
  };
  const result = await h.pipeline.run({ stages: ["transfer", "upload"], ...WITH_TABLES });
  assert.deepEqual(result.artifacts.map((a) => a.path).filter((x) => !x), []);
  assert.ok(!result.artifacts.some((a) => a.path === ""));
});

test("artifacts：一个阶段都没跑成时是空数组，不是 null（界面直接 .length 读它）", async () => {
  const h = harness({ taskResults: { crawl: "throw" } });
  const result = await h.pipeline.run({ stages: ["crawl"] });
  assert.ok(Array.isArray(result.artifacts));
  assert.deepEqual(result.artifacts, []);
});
