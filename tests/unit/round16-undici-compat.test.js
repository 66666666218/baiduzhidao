"use strict";

/**
 * 第 16 轮 C：「网盘转存阶段立刻 FAILED —— webidl.util.markAsUncloneable is not a function」。
 *
 * 根因（实测，不是猜）：
 *   Electron 33.4.11 内置的是 **Node 20.18.3**，它的 `require("node:worker_threads")`
 *   **没有** `markAsUncloneable`（那个 API 是 Node 22 才加的）。而 undici ≥ 7 的
 *   `lib/web/webidl/index.js` 在加载时就取它并随后调用 ——
 *   于是**只要 `require("undici")` 就抛** `webidl.util.markAsUncloneable is not a function`。
 *
 *   可复现：
 *     ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
 *       -e "console.log(process.versions.node); require('undici')"
 *     → node 20.18.3 / 抛上面的错
 *   而项目里 `electron/src/netdisk/proxy.js` 顶层就 `require("undici")`，
 *   一键全自动跑到「网盘转存」（唯一会取 dispatcher 的阶段）就整个炸掉，
 *   后面的上传也一并没了 —— 用户看到的就是「2/3 个阶段成功（在网盘转存中断）」。
 *
 * 修法两条，都要：
 *   1. undici 钉在 6.x（6.21.3 实测在 Electron 的 Node 20.18.3 下 require + new ProxyAgent 都正常）；
 *   2. proxy.js 改成兜底加载 —— 依赖再出这类问题，退化成直连并**大声告警**，
 *      绝不能把整个任务送走（"一个代理功能把整条链弄断"是最坏的失败形态）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("A1 ★ undici 主版本必须 ≤ 6（≥7 在 Electron 的 Node 20 下 require 即崩）", () => {
  const pkg = JSON.parse(read("package.json"));
  const spec = String((pkg.dependencies || {}).undici || "");
  assert.ok(spec, "package.json 里必须有 undici 依赖声明");
  const major = Number(String(spec).replace(/[^0-9.]/g, "").split(".")[0]);
  assert.ok(major <= 6, `undici 版本 ${spec} 在 Electron 33（Node 20.18.3）下会抛 webidl.util.markAsUncloneable is not a function`);
});

test("A2 proxy.js 不许在顶层裸 require('undici')（必须走兜底，失败要退化成直连）", () => {
  const src = read("electron/src/netdisk/proxy.js");
  // 顶层裸 require 会把加载异常直接抛给调用方 —— 本次事故就是它把转存阶段送走的
  assert.ok(!/^const\s*\{[^}]*\}\s*=\s*require\("undici"\);/m.test(src),
    "proxy.js 顶层裸 require 了 undici —— 一旦依赖不兼容，异常会直接炸掉整个任务");
  assert.match(src, /function requireUndici/, "缺兜底加载函数");
  assert.match(src, /catch\s*\(\s*error\s*\)\s*\{/, "兜底分支要真的吞掉异常");
  assert.match(src, /账号代理功能本次不可用/, "退化成直连时必须**大声说明**，不能静默失效");
});

test("A3 dispatcherFor：空地址/非法地址都返回 undefined 且不抛（直连是安全的降级）", () => {
  const { dispatcherFor } = require("../../electron/src/netdisk/proxy.js");
  assert.doesNotThrow(() => dispatcherFor(""));
  assert.equal(dispatcherFor(""), undefined);
  assert.equal(dispatcherFor(null), undefined);
  // 非法地址：不该抛，应该记警告后返回 undefined（直连）
  assert.doesNotThrow(() => dispatcherFor("这不是一个代理地址"));
});

test("A4 proxyStatus 要能说出代理功能当前可不可用、为什么", () => {
  const { proxyStatus } = require("../../electron/src/netdisk/proxy.js");
  const s = proxyStatus();
  assert.equal(typeof s.ok, "boolean");
  assert.equal(typeof s.reason, "string");
  assert.equal(s.ok, true, `undici 在本环境加载失败：${s.reason}`);
});

test("A5 有代理地址时能真的建出 Agent（证明 dispatcher 链路是通的）", () => {
  const { dispatcherFor } = require("../../electron/src/netdisk/proxy.js");
  const agent = dispatcherFor("http://127.0.0.1:9");
  assert.ok(agent, "配了代理却建不出 Agent，等于代理功能静默失效");
  assert.equal(typeof agent.dispatch, "function", "建出来的不是 dispatcher（fetch 会忽略它）");
  // 同一个地址要复用（每次新建会白白多一轮 TLS 握手）
  assert.equal(dispatcherFor("http://127.0.0.1:9"), agent);
});

// ---------------------------------------------------- B 组：失败不该让最后一步凭空消失

const { createAutoPipeline, normEnvs } = require("../../electron/src/workflows/auto-pipeline");

function harness(overrides = {}) {
  const calls = [];
  const logs = [];
  let pipelineRef = null;
  const settings = {
    bitEnvs: ["账号1"], randomCount: 5, accountTopics: {}, topicRules: "",
    linkRouting: "strict", aiApiKey: "k", aiModel: "m", aiConcurrency: 1,
    ...(overrides.settings || {}),
  };
  const deps = {
    config: { load: () => settings },
    startTask: async (name) => {
      calls.push(name);
      const handler = (overrides.taskResults || {})[name];
      if (handler === "throw") throw new Error(`${name} 炸了`);
      if (typeof handler === "function") return handler();
      if (name === "check-published") return { accounts: [] };
      return {};
    },
    taskDeps: () => ({}),
    pickQuestions: async () => ({ filePath: path.join("/tmp", "抽题.xlsx") }),
    emit: (_c, m) => logs.push(m),
    pulse: () => {},
    dataDir: "/tmp/data",
    taskRunners: new Proxy({}, { get: () => async () => ({}) }),
    CATEGORIES: ["情感类"],
    excel: { readTableRows: () => [], importRowToAnswer: (r) => r },
    // fileExists=false 时任何路径都当不存在（用来造"没有现成上传表"）
    fs: { existsSync: () => overrides.fileExists !== false },
    path,
    resolveNetdiskRoles: (bitEnvs, p) => ({
      transferEnvs: normEnvs(p.transferEnvs).length ? normEnvs(p.transferEnvs) : bitEnvs,
      uploadEnvs: normEnvs(p.uploadEnvs).length ? normEnvs(p.uploadEnvs) : bitEnvs,
    }),
  };
  const pipeline = createAutoPipeline(deps);
  pipelineRef = pipeline;
  return { pipeline, calls, logs };
}

const stageOf = (result, name) => (result.stages || []).find((s) => s.stage === name);

test("B1 ★ 转存失败但**已有现成上传表**：上传要照常跑，不能跟着一起没", async () => {
  const h = harness({ taskResults: { "batch-transfer": "throw" } });
  const result = await h.pipeline.run({
    stages: ["transfer", "upload"],
    transferTablePath: path.join("/tmp", "资源表.xlsx"),
    uploadTablePath: path.join("/tmp", "上传专用表.xlsx"), // 现成的表
  });
  assert.equal(stageOf(result, "transfer").ok, false, "转存确实失败了");
  assert.ok(h.calls.includes("upload-by-topic"),
    "上传读的是现成的上传专用表，跟转存失败无关 —— 为了一个不相干的失败砍掉最后一步，"
    + "用户看到的就只剩「2/3 个阶段成功」，而他要的正是上传");
  assert.equal(stageOf(result, "upload").ok, true);
  assert.equal(result.ok, false, "有阶段失败就不能报成功");
  assert.ok(h.logs.some((m) => String(m).includes("继续上传")), "继续跑必须把理由说清楚");
});

test("B2 转存失败且**没有**上传表：上传要记为跳过，并点名是因为哪一步失败", async () => {
  const h = harness({ taskResults: { "batch-transfer": "throw" } });
  const result = await h.pipeline.run({
    stages: ["transfer", "upload"],
    transferTablePath: path.join("/tmp", "资源表.xlsx"),
    uploadTablePath: "", // 没有现成的表
  });
  assert.ok(!h.calls.includes("upload-by-topic"));
  const up = stageOf(result, "upload");
  assert.ok(up, "上传阶段必须在结果表里留下记录 —— 以前它直接消失，用户不知道第三个阶段去哪了");
  assert.ok(up.skipped);
  assert.match(up.error, /网盘转存/, "跳过原因要点名是哪个阶段失败，只说「没有表」会把人引去改表");
});

test("B3 全成功路径不受影响（上传照常跑、没有多余跳过）", async () => {
  const h = harness();
  const result = await h.pipeline.run({
    stages: ["transfer", "upload"],
    transferTablePath: path.join("/tmp", "资源表.xlsx"),
    uploadTablePath: path.join("/tmp", "上传专用表.xlsx"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, []);
  assert.ok(h.calls.includes("upload-by-topic"));
});

test("B4 ★ 权益门不再被前序失败跳过（否则上传会用未收窄的账号名单）", async () => {
  // 抽题阶段炸掉 → 以前权益门会因为有 failure 而整段不查，uploadEnvs 停留在用户填的原始名单
  const h = harness({ pickThrows: false, taskResults: { crawl: "throw" } });
  const result = await h.pipeline.run({
    stages: ["crawl", "upload"],
    uploadTablePath: path.join("/tmp", "上传专用表.xlsx"),
  });
  assert.ok(h.calls.includes("check-published"),
    "前面失败了就不查权益，等于把「没有批量发布权益」的号也放上去上传 —— 权益门必须照查");
  assert.ok(result.ok === false);
});
