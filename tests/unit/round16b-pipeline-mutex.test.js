"use strict";

/**
 * 第 16 轮 E：一键全自动「自己把自己锁在门外」的回归测试（2.0.44 的 P0 回归 → 2.0.45）。
 *
 * ── 用户看到的（原话贴的日志）──
 *     [15:33:27] ⚠️ 确认批量发布权益 失败，后续阶段不再执行：一键全自动正在运行中，请先点「停止当前任务」或等它结束。
 *     ══════ 一键全自动结束：0/2 个阶段成功，1 个阶段被跳过：按题材上传（在「确认批量发布权益」中断） ══════
 * 也就是"点了一键全自动，什么都没跑，还报了一句莫名其妙的一键全自动正在运行中"。
 *
 * ── 根因（我自己造的）──
 * 第 16 轮为了补这个缺口：一键全自动**不在** TaskManager 里跑（它只是编排，按阶段逐个调
 * startTask），所以"阶段之间" `tasks.current` 是空的，用户此刻手点「爬题」会被放行 ——
 * 我在 startTask 开头加了一把 `if (autoPipeline.isRunning()) throw`。
 * 但我忘了：**编排自己正是通过 startTask 启动每一个阶段的**。于是它把自己的第一个阶段
 * 挡在门外，那个阶段瞬间失败、整链按"后续阶段不再执行"中止。
 *
 * ── 这一轮要把三件事钉死 ──
 *   ① 这把锁只能锁**外部**调用（pipeline-guard.js 的 pipelineBlocksTask，纯函数）；
 *   ② 编排注入的必须是带标记的那一份（pipelineStartTask），且**注入点**也要被守住 ——
 *      把它改回裸 `startTask,` 就又是一次全链报废，而那种改动不会有任何编译/测试噪音；
 *   ③ 点过停止之后这把锁必须失效：否则"点了取消，想进行里面的操作也卡"会以另一种形态回来
 *      （编排卡在不可中断的 await 上 → run() 不返回 → isRunning() 永远 true → 每一按都被拒）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  pipelineBlocksTask, pipelineBlockedMessage, pipelineStartTask,
} = require("../../electron/src/workflows/pipeline-guard");
const { createAutoPipeline, normEnvs } = require("../../electron/src/workflows/auto-pipeline");
const { TaskManager } = require("../../electron/src/tasks/manager");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// --------------------------------------------------------- A 组：规则本身（纯函数）

test("A1 编排没在跑：谁都放行（含外面手点的）", () => {
  assert.equal(pipelineBlocksTask({ pipelineRunning: false, pipelineAborted: false, fromPipeline: false }), false);
  assert.equal(pipelineBlocksTask({ pipelineRunning: false, pipelineAborted: true, fromPipeline: false }), false);
});

test("A2 ★ 编排在跑 + 这次是编排自己发起的：必须放行（否则整条链第一个阶段就死）", () => {
  assert.equal(pipelineBlocksTask({ pipelineRunning: true, pipelineAborted: false, fromPipeline: true }), false,
    "编排也是用 startTask 启动阶段的 —— 不放行就是 2.0.44 那个「0/2 个阶段成功」");
});

test("A3 编排在跑 + 外面手点的 + 没停过：拒绝（这把锁存在的唯一理由）", () => {
  assert.equal(pipelineBlocksTask({ pipelineRunning: true, pipelineAborted: false, fromPipeline: false }), true);
});

test("A4 ★ 编排已收到停止请求：放行外面手点的（否则「点了取消」之后每一按都被拒）", () => {
  assert.equal(pipelineBlocksTask({ pipelineRunning: true, pipelineAborted: true, fromPipeline: false }), false,
    "停止后编排不会再拉起新阶段，锁的意义已经消失；此刻收尾中的阶段由 TaskManager 自己的锁兜着");
});

test("A5 参数缺失/undefined 不能抛（调用方漏传一个字段不该让任务起不来）", () => {
  assert.equal(pipelineBlocksTask({}), false);
  assert.equal(pipelineBlocksTask(), false);
  assert.equal(pipelineBlocksTask({ pipelineRunning: 1, fromPipeline: undefined }), true, "真值判定要按布尔语义");
});

test("A6 被拒时的文案要能指导下一步（必须出现「停止」）", () => {
  assert.match(pipelineBlockedMessage(), /停止/);
});

// ------------------------------------------------- B 组：注入包装（结构性防线）

test("B1 pipelineStartTask：转发三个参数、补上 fromPipeline 标记、返回原返回值", async () => {
  const seen = [];
  const marked = pipelineStartTask(async (name, payload, runner, options) => {
    seen.push({ name, payload, runner, options });
    return "结果";
  });
  const fn = () => {};
  const out = await marked("crawl", { a: 1 }, fn);
  assert.equal(out, "结果");
  assert.deepEqual(seen, [{ name: "crawl", payload: { a: 1 }, runner: fn, options: { fromPipeline: true } }]);
});

test("B2 ★ 那两处接线必须留着（改回裸 startTask 就是又一次全链报废，且没有任何报错）", () => {
  const src = read("electron/app-context.js");
  assert.match(src, /startTask:\s*pipelineStartTask\(startTask\)/,
    "createAutoPipeline 注入的必须是带标记的 startTask —— 注入裸 startTask，编排会把自己锁在门外");
  assert.match(src, /pipelineBlocksTask\(\{/,
    "锁本身必须走 pipeline-guard 那一份规则，不能在 startTask 里另写一个判据");
  assert.match(src, /pipelineAborted:\s*Boolean\(autoPipeline && autoPipeline\.isAborted\(\)\)/,
    "漏了「已停止就放行」这一路 → 点取消之后每一按还是被拒");
});

test("B3 auto-pipeline.js 不该知道 fromPipeline 的存在（标记由主进程注入，编排只管调）", () => {
  const src = read("electron/src/workflows/auto-pipeline.js");
  assert.ok(!/fromPipeline/.test(src),
    "编排层出现 fromPipeline 说明它开始自己传标记了 —— 那就会有「新写的阶段忘了传」的下一次事故");
});

// ------------------------------------------------- C 组：整链真跑（复现用户那两行日志）

/**
 * 假依赖，但 `startTask` 是**照着 app-context.js 的接线复刻的**：
 * 同一份 pipelineBlocksTask 规则、同一份文案、同一个「编排注入的是带标记版本」的结构。
 * 这样这一组测的就是真实的互斥行为，而不只是纯函数。
 */
function harness({ markInjection = true, onExternalProbe } = {}) {
  const calls = [];
  const logs = [];
  const pulses = [];
  const ref = { pipeline: null };
  const settings = {
    bitEnvs: ["账号1", "账号2"], crawlStartPage: 1, maxQuestions: 0, randomCount: 5,
    submitLimit: 0, accountDailyLimit: 0, dailyAnswerLimit: 0, accountTopics: {},
    topicRules: "", linkRouting: "strict", aiApiKey: "k", aiBaseUrl: "", aiModel: "m", aiConcurrency: 1,
  };

  // 外部调用（用户手点 / 脚本）用的那一份：带锁
  const startTask = async function startTaskImpl(name, payload, runner, options = {}) {
    if (pipelineBlocksTask({
      pipelineRunning: Boolean(ref.pipeline && ref.pipeline.isRunning()),
      pipelineAborted: Boolean(ref.pipeline && ref.pipeline.isAborted()),
      fromPipeline: Boolean(options.fromPipeline),
    })) {
      throw new Error(pipelineBlockedMessage());
    }
    calls.push(name);
    // 「阶段进行中，用户手点了别的任务」—— 探针由用例注入
    if (typeof onExternalProbe === "function") await onExternalProbe({ name, ref, startTask: startTaskImpl });
    if (name === "check-published") return { accounts: [] };
    return {};
  };

  const deps = {
    config: { load: () => settings },
    startTask: markInjection ? pipelineStartTask(startTask) : startTask,
    taskDeps: () => ({}),
    pickQuestions: async () => ({ filePath: path.join("/tmp", "抽题.xlsx") }),
    emit: (_channel, message) => logs.push(message),
    pulse: (status = "running") => { pulses.push(status); },
    dataDir: "/tmp/data",
    taskRunners: new Proxy({}, { get: () => async () => ({}) }),
    CATEGORIES: ["情感类"],
    excel: { readTableRows: () => [], importRowToAnswer: (r) => r },
    // 空路径一律当"不存在"—— 真实 fs.existsSync("") 就是 false
    fs: { existsSync: (p) => Boolean(String(p || "").trim()) },
    path,
    resolveNetdiskRoles: (bitEnvs, p) => ({
      transferEnvs: normEnvs(p.transferEnvs).length ? normEnvs(p.transferEnvs) : bitEnvs,
      uploadEnvs: normEnvs(p.uploadEnvs).length ? normEnvs(p.uploadEnvs) : bitEnvs,
    }),
  };
  ref.pipeline = createAutoPipeline(deps);
  return { pipeline: ref.pipeline, calls, logs, pulses };
}

/** 用户那次跑的形态：只勾了「按题材上传」，没给上传专用表 → report 恰好 2 项、1 项被跳过 */
const USER_RUN = { stages: ["upload"] };

test("C1 ★★ 注入不带标记时，必须精确复现用户那两行日志（证明这个用例是敏感的）", async () => {
  const h = harness({ markInjection: false });
  await h.pipeline.run(USER_RUN);
  const failLine = h.logs.find((m) => String(m).includes("确认批量发布权益") && String(m).includes("失败"));
  assert.ok(failLine, "第一个阶段应该失败 —— 这正是回归的形态");
  assert.match(failLine, /一键全自动正在运行中/);
  assert.ok(h.logs.some((m) => String(m).includes("0/2 个阶段成功")),
    "结论应该被打成 0/2 —— 也就是用户看到的那一行");
  assert.ok(h.logs.some((m) => String(m).includes("1 个阶段被跳过：按题材上传")));
});

test("C2 ★★ 注入带标记（真实接线）：同一个 payload 下阶段必须真的跑起来，结论不再是 0/2", async () => {
  const h = harness({ markInjection: true });
  const result = await h.pipeline.run(USER_RUN);
  assert.ok(!h.logs.some((m) => String(m).includes("一键全自动正在运行中")),
    "编排自己发起的阶段被拒了 —— 锁又锁到自己人身上了");
  assert.ok(!h.logs.some((m) => String(m).includes("0/2 个阶段成功")));
  assert.deepEqual(h.calls, ["check-published"], "「确认批量发布权益」必须真的执行了");
  assert.ok(h.logs.some((m) => String(m).includes("1/2 个阶段成功")),
    "权益门成功 + 上传因没有上传专用表被跳过 = 1/2，这才是这一轮该有的结论");
  assert.equal(result.ok, true);
});

test("C3 给了上传专用表时，「按题材上传」也要真的跑到（不能只跑权益门就完事）", async () => {
  const h = harness({ markInjection: true });
  await h.pipeline.run({ stages: ["upload"], uploadTablePath: path.join("/tmp", "上传专用表.xlsx") });
  assert.ok(h.calls.includes("upload-by-topic"), `上传阶段没跑，实际只跑了：${h.calls.join("、")}`);
});

test("C4 阶段进行中，用户手点别的任务 → 仍然要被拒（这把锁的本职不能丢）", async () => {
  let probeError = null;
  const h = harness({
    markInjection: true,
    onExternalProbe: async ({ name, ref, startTask }) => {
      if (name !== "check-published" || probeError) return;
      try {
        // 不加标记 = 用户手点
        await startTask("crawl", {}, async () => ({}));
      } catch (error) { probeError = error; }
    },
  });
  await h.pipeline.run(USER_RUN);
  assert.ok(probeError, "编排在跑的时候手点任务竟然被放行了 —— 两条链会抢同一批比特窗口");
  assert.match(probeError.message, /一键全自动正在运行中/);
  assert.ok(!h.calls.includes("crawl"), "被拒的任务不能留下任何「已启动」的痕迹");
});

test("C5 ★ 阶段进行中点过停止之后，外面手点的任务必须立刻放行（不再被这把锁挡）", async () => {
  let probeError = null;
  let probed = false;
  const h = harness({
    markInjection: true,
    onExternalProbe: async ({ name, ref, startTask }) => {
      if (name !== "check-published" || probed) return;
      probed = true;
      ref.pipeline.abort();               // 用户点了「停止当前任务」
      try {
        await startTask("crawl", {}, async () => ({}));
      } catch (error) { probeError = error; }
    },
  });
  await h.pipeline.run(USER_RUN);
  assert.equal(probeError, null,
    "停止之后还被锁着，用户就会看到「点了取消，其他操作也卡」—— 那正是本轮要修掉的现象");
  assert.ok(h.calls.includes("crawl"), "停止后外部任务应当能开工（此后由 TaskManager 自己的锁兜着）");
});

// ------------------------------------------------- D 组：等价的旧入口不能复活

test("D1 app-context.js 里不能再出现那把锁的老写法（内联判据 = 两份规则各自演进）", () => {
  const src = read("electron/app-context.js")
    // ⚠️ 必须先剥行注释、再剥块注释：本文件里有一句含块注释起始符的行注释，
    // 反过来剥会把中间几百行真实代码整段吞掉（这个坑本仓库踩过）。
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // 行首锚定：`} else if (autoPipeline && autoPipeline.isRunning()) {`（task:stop 里那句）
  // 是**正常**用法，不能被误伤 —— 老写法是独立成句的 `if (...)`。
  assert.ok(!/^[ \t]*if\s*\(\s*autoPipeline\s*&&\s*autoPipeline\.isRunning\(\)\s*\)/m.test(src),
    "startTask 里又出现了内联的 isRunning 判断 —— 判据必须只有 pipeline-guard.js 那一份");
  assert.match(src, /throw new Error\(pipelineBlockedMessage\(\)\)/,
    "拒绝时必须抛公共文案，不能自己另写一句");
});

// ------------------------------------------------- E 组：「点了暂停没反应」的同类缺陷

test("E1 没有任务时 pause() 必须如实回 accepted=false（界面据此才知道不该假装已暂停）", () => {
  const tm = new TaskManager();
  const r = tm.pause();
  assert.equal(r.ok, true);
  assert.equal(r.accepted, false,
    "回 accepted:true 会让界面把「暂停任务」换成「恢复任务」，而其实什么都没暂停 —— 一键全自动停在阶段之间时正是这种情况");
  assert.equal(tm.resume().resumed, false);
});

test("E2 有任务时 pause()/resume() 才是有效（别把上一条修成永假）", async () => {
  const tm = new TaskManager();
  const started = tm.start("crawl", {}, async () => new Promise(() => {}), {});
  assert.equal(tm.pause().accepted, true);
  assert.equal(tm.resume().resumed, true);
  started.catch(() => {});
});

test("E3 ★ 三个按钮的入口都必须对「其实没有任务」留痕（停止上轮已修，暂停/恢复是同一类）", () => {
  const src = read("electron/app-context.js");
  assert.match(src, /if\s*\(result && result\.accepted\)/, "停止按钮必须区分有没有真的停到东西");
  assert.match(src, /当前没有可暂停的任务（一键全自动停在阶段之间时就是这样）/,
    "没任务时点暂停以前一点反馈都没有 —— 用户会以为按钮坏了");
  assert.match(src, /当前没有处于暂停状态的任务（恢复请求已忽略）/);
});

test("E4 渲染端点暂停而主进程没回应时，不能完全静默", () => {
  const src = read("electron/renderer/renderer.js");
  assert.match(src, /暂停请求没有送达主进程/,
    "rpc 失败被 catch(()=>null) 吃掉之后什么都不显示，用户只会反复点");
});
