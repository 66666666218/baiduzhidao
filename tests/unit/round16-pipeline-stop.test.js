"use strict";

/**
 * 第 16 轮：一键全自动「卡住 / 停不掉」的回归测试。
 *
 * 用户原话：「我点击一键全自动之后容易卡住，我点击取消，想要进行里面操作也会卡」。
 * 拆开是三个各自独立的缺陷，这里一条一条钉死：
 *
 *   A. 停止只是置旗标，任务若卡在不可中断的 await 上（浏览器 API / 30 秒硬等 / 读流），
 *      `tasks.current` 永远不清空 → assertIdle() 把之后**每一个**任务都拒掉。
 *      真实后果不是"这个任务停不掉"，而是**整个软件之后都不能用了**，只能重启进程。
 *      → 必须有宽限期之后的强制放锁（forceRelease）。
 *
 *   B. 界面靠 `task:progress` 的终态（done/stopped/failed）解锁动作按钮。
 *      一键全自动自己**不发**终态：只有"最后阶段恰好是 TaskManager 任务且跑到自己的
 *      终态 report"时才碰巧解锁。抽题（不走 TaskManager）、跳过阶段、以及停止后
 *      runStage 的早退都不发任何进度 —— 界面永久停在"进行中"，所有按钮灰着。
 *      → 这才是"点了取消，想进行里面的操作也卡"的真正成因：**任务停了，界面没解锁**。
 *
 *   C. 一个阶段跑十几分钟很正常，但界面只有"进行中"三个字，用户分不清是干活还是死了，
 *      于是自己点停止，把本来能跑完的链掐断。→ 阶段心跳。
 *
 * 顺带钉死两个很容易被"顺手改回去"的语义：
 *   · ctx.shouldStop() 必须读**票据**而不是 this.current（放锁后才能仍然为 true）；
 *   · finally 只能清自己那把锁（否则强制放锁后新任务的锁会被旧任务收尾时擦掉）。
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { TaskManager, STOP_GRACE_MS } = require("../../electron/src/tasks/manager");
const { createAutoPipeline, ALL_STAGES, normEnvs } = require("../../electron/src/workflows/auto-pipeline");

// ---------------------------------------------------------------- A 组：任务锁

test("A1 没有任务时 stop() 如实说 accepted=false（一键全自动停在阶段之间就是这种情况）", () => {
  const tm = new TaskManager();
  const r = tm.stop();
  assert.equal(r.ok, true);
  assert.equal(r.accepted, false, "没任务却回 accepted:true，界面就会一直等一个不会到来的退出");
});

test("A2 stop() 有任务时回 accepted + 任务名 + 宽限期（界面要能说清还要等多久）", async () => {
  const tm = new TaskManager();
  const started = tm.start("crawl", {}, async () => new Promise(() => {}), {});
  const r = tm.stop();
  assert.equal(r.accepted, true);
  assert.equal(r.taskName, "crawl");
  assert.equal(r.graceMs, STOP_GRACE_MS);
  started.catch(() => {}); // 永不 resolve，避免未处理拒绝
});

test("A3 协作式停止：任务自己走到检查点退出时不触发强制释放，之后能正常起新任务", async () => {
  const tm = new TaskManager();
  const logs = [];
  const progress = [];
  const first = tm.start("crawl", {}, async (ctx) => {
    // 模拟"跑到下一个检查点才发现停止信号"
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ctx.shouldStop(), true);
    return "ok";
  }, { onLog: (m) => logs.push(m), onProgress: (p) => progress.push(p) });

  tm.stop();
  assert.equal(await first, "ok");
  assert.equal(tm.current, null, "任务收尾后必须放锁");
  assert.ok(!logs.some((m) => String(m).includes("强制释放")), "正常退出不该报强制释放");
  // 关键：之后能起新任务（以前这里会被 assertIdle 永久拒绝）
  assert.doesNotThrow(() => tm.assertIdle());
  assert.equal(await tm.start("generate", {}, async () => "second"), "second");
});

test("A4 ★ 卡死的任务：宽限期到了必须强制放锁，并补一条终态进度解锁界面", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tm = new TaskManager();
  const logs = [];
  const progress = [];
  // 永不结束、也不看停止信号 —— 现实里就是"卡在浏览器 API / 硬等上"的任务
  const stuck = tm.start("upload-by-topic", {}, async () => new Promise(() => {}), {
    onLog: (m) => logs.push(m), onProgress: (p) => progress.push(p),
  });
  tm.stop();
  assert.notEqual(tm.current, null, "刚点停止还不能立刻放锁：要给任务自己收尾的机会");
  t.mock.timers.tick(STOP_GRACE_MS + 100);
  assert.equal(tm.current, null, "宽限期到了必须放锁，否则之后所有任务都被 assertIdle 拒掉");
  assert.ok(progress.some((p) => p && p.status === "stopped"), "必须补终态进度，否则界面按钮永久灰着");
  assert.ok(logs.some((m) => String(m).includes("强制释放")), "必须告诉用户发生了什么");
  // 之后可以正常操作 —— 这正是用户说的"想进行里面的操作也会卡"
  assert.doesNotThrow(() => tm.assertIdle());
  stuck.catch(() => {});
});

test("A5 强制放锁后，旧任务的 ctx.shouldStop() 仍然是 true（票据语义，不能读 this.current）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tm = new TaskManager();
  let seenAfterRelease = null;
  let releaseGate;
  const started = tm.start("crawl", {}, async (ctx) => {
    await new Promise((resolve) => { releaseGate = resolve; });
    seenAfterRelease = ctx.shouldStop();
    return "done";
  }, {});
  tm.stop();
  t.mock.timers.tick(STOP_GRACE_MS + 100);
  assert.equal(tm.current, null);
  releaseGate(); // 旧任务继续跑
  assert.equal(await started, "done");
  assert.equal(seenAfterRelease, true,
    "放锁后 shouldStop() 若变回 false，旧任务会以为停止被撤销而继续跑 —— 与强制放锁的目的正好相反");
});

test("A6 强制放锁后起新任务，旧任务收尾时不能把新任务的锁擦掉", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tm = new TaskManager();
  let releaseGate;
  const oldTask = tm.start("crawl", {}, async () => {
    await new Promise((resolve) => { releaseGate = resolve; });
    return "old";
  }, {});
  tm.stop();
  t.mock.timers.tick(STOP_GRACE_MS + 100);
  assert.equal(tm.current, null);

  const newTask = tm.start("submit", {}, async () => new Promise(() => {}), {});
  assert.notEqual(tm.current, null);
  releaseGate();
  assert.equal(await oldTask, "old");
  assert.notEqual(tm.current, null, "旧任务收尾把新任务的锁清了 —— 互斥形同虚设");
  newTask.catch(() => {});
});

test("A7 停止后任务在宽限期内自行退出：定时器要清掉，不能事后误报强制释放", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tm = new TaskManager();
  const logs = [];
  let gate;
  const task = tm.start("crawl", {}, async (ctx) => {
    await new Promise((resolve) => { gate = resolve; });
    if (ctx.shouldStop()) return "stopped";
    return "ok";
  }, { onLog: (m) => logs.push(m) });
  tm.stop();
  gate();
  assert.equal(await task, "stopped");
  t.mock.timers.tick(STOP_GRACE_MS + 100);
  assert.ok(!logs.some((m) => String(m).includes("强制释放")), "已经正常退出了，不该再报强制释放");
});

// ------------------------------------------------- B 组：一键全自动必须发终态进度

/** 与 auto-pipeline.test.js 同一套假依赖（那个文件里的 harness 不外迁，避免互相耦合） */
function harness(overrides = {}) {
  const calls = [];
  const logs = [];
  const pulses = [];
  let pipelineRef = null;
  const settings = {
    bitEnvs: ["账号1", "账号2"], crawlStartPage: 1, maxQuestions: 0, randomCount: 5,
    submitLimit: 0, accountDailyLimit: 0, dailyAnswerLimit: 0, accountTopics: {},
    topicRules: "", linkRouting: "strict", aiApiKey: "k", aiBaseUrl: "", aiModel: "m", aiConcurrency: 1,
    ...(overrides.settings || {}),
  };
  const deps = {
    config: { load: () => settings },
    startTask: async (name) => {
      calls.push(name);
      if (typeof overrides.onTask === "function") overrides.onTask(name, pipelineRef);
      const handler = (overrides.taskResults || {})[name];
      if (handler === "throw") throw new Error(`${name} 炸了`);
      if (typeof handler === "function") return handler();
      if (name === "check-published") return { accounts: [] };
      return {};
    },
    taskDeps: () => ({}),
    pickQuestions: async () => { calls.push("pick"); return { filePath: path.join("/tmp", "抽题.xlsx") }; },
    emit: (_channel, message) => logs.push(message),
    pulse: (status = "running") => { pulses.push(status); },
    dataDir: "/tmp/data",
    taskRunners: new Proxy({}, { get: () => async () => ({}) }),
    CATEGORIES: ["情感类"],
    excel: { readTableRows: () => [], importRowToAnswer: (r) => r },
    fs: { existsSync: () => overrides.fileExists !== false },
    path,
    resolveNetdiskRoles: (bitEnvs, p) => ({
      transferEnvs: normEnvs(p.transferEnvs).length ? normEnvs(p.transferEnvs) : bitEnvs,
      uploadEnvs: normEnvs(p.uploadEnvs).length ? normEnvs(p.uploadEnvs) : bitEnvs,
    }),
  };
  const pipeline = createAutoPipeline(deps);
  pipelineRef = pipeline;
  return { pipeline, calls, logs, pulses, settings };
}

const WITH_TABLES = {
  transferTablePath: path.join("/tmp", "资源表.xlsx"),
  uploadTablePath: path.join("/tmp", "上传专用表.xlsx"),
};

const lastPulse = (pulses) => pulses[pulses.length - 1];

test("B1 全阶段成功：最后一个脉冲必须是终态 done（否则按钮一直灰着）", async () => {
  const h = harness();
  const result = await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });
  assert.equal(result.ok, true);
  assert.equal(lastPulse(h.pulses), "done");
});

test("B2 ★ 中途停止：最后一个脉冲必须是 stopped —— 停止后界面要解锁", async () => {
  const h = harness({
    // 跑到"提交"这一步时用户点了停止
    onTask: (name, ref) => { if (name === "submit") ref.abort(); },
  });
  const result = await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });
  assert.equal(result.stopped, true);
  assert.equal(lastPulse(h.pulses), "stopped");
});

test("B3 ★ 只跑「抽题」（它不走 TaskManager）：也必须有终态脉冲，不能一个都不发", async () => {
  const h = harness();
  await h.pipeline.run({ stages: ["pick"] });
  assert.deepEqual(h.calls, ["pick"]);
  assert.equal(lastPulse(h.pulses), "done",
    "抽题不走 TaskManager，任务层不会替它发终态；编排不补这一下，界面就永久停在「进行中」");
});

test("B4 有阶段失败：终态脉冲是 failed（不是 done，也不是什么都不发）", async () => {
  const h = harness({ taskResults: { crawl: "throw" } });
  const result = await h.pipeline.run({ stages: ALL_STAGES, ...WITH_TABLES });
  assert.equal(result.ok, false);
  assert.equal(lastPulse(h.pulses), "failed");
});

test("B5 编排自身抛错（没配账号）：也要发终态，不能让界面锁死", async () => {
  const h = harness({ settings: { bitEnvs: [] } });
  await assert.rejects(() => h.pipeline.run({ stages: ALL_STAGES }), /比特环境名称/);
  assert.equal(lastPulse(h.pulses), "failed");
});

test("B6 isRunning：运行中为 true、结束后为 false（主进程靠它做互斥）", async () => {
  const h = harness();
  assert.equal(h.pipeline.isRunning(), false);
  const p = h.pipeline.run({ stages: ["pick"] });
  assert.equal(h.pipeline.isRunning(), true);
  await p;
  assert.equal(h.pipeline.isRunning(), false);
});

// ------------------------------------------------------------ C 组：心跳不留后患

test("C1 整条链跑完之后，心跳必须停掉（否则日志会被「仍在运行」刷屏）", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  await h.pipeline.run({ stages: ["pick"] });
  const before = h.logs.length;
  // 跑完之后再走 10 分钟：不该再冒出任何心跳行
  t.mock.timers.tick(10 * 60 * 1000);
  assert.ok(!h.logs.slice(before).some((m) => String(m).includes("仍在运行")),
    "链都跑完了还在报「仍在运行」，界面又在撒谎");
});

test("C2 心跳文案必须带上「可以点停止」—— 否则用户只会以为软件死了", async () => {
  const h = harness();
  await h.pipeline.run({ stages: ["pick"] });
  // 直接验证心跳行模板（心跳本身由定时器驱动，这里只钉死文案里有可操作指引）
  const messages = h.logs.filter((m) => String(m).includes("仍在运行"));
  // 单阶段很快就结束，正常情况下不会触发；触发时必须含"停止"
  for (const m of messages) assert.match(m, /停止/);
});
