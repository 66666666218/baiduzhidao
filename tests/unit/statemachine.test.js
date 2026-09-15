"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { TaskStateMachine, STATES, TRANSITIONS } = require("../../electron/src/tasks/statemachine");
const { TaskManager } = require("../../electron/src/tasks/manager");
const { EventBus } = require("../../electron/src/events/bus");

// ---------- 状态机 ----------

test("状态机：合法迁移 PENDING→RUNNING→SUCCESS", () => {
  const events = [];
  const machine = new TaskStateMachine({ taskId: "t1", emit: (e, meta) => events.push({ e, to: meta.to }) });
  assert.equal(machine.state, STATES.PENDING);
  machine.start().succeed();
  assert.equal(machine.state, STATES.SUCCESS);
  assert.ok(machine.isTerminal);
  assert.equal(machine.startedAt && machine.finishedAt ? true : false, true);
  assert.equal(events.filter((x) => x.e === "task.stateChanged").length, 2);
});

test("状态机：非法迁移被拒绝", () => {
  const machine = new TaskStateMachine({});
  assert.throws(() => machine.succeed(), /PENDING → SUCCESS/);
  assert.equal(machine.state, STATES.PENDING);
});

test("状态机：暂停/恢复与取消", () => {
  const machine = new TaskStateMachine({});
  machine.start().pause("checkpoint");
  assert.equal(machine.state, STATES.PAUSED);
  machine.resume();
  assert.equal(machine.state, STATES.RUNNING);
  machine.cancel("user");
  assert.equal(machine.state, STATES.CANCELLED);
  assert.throws(() => machine.start(), /CANCELLED → RUNNING/);
  assert.equal(machine.failReason, null);
});

test("状态机：失败记录原因", () => {
  const machine = new TaskStateMachine({});
  machine.start().fail("boom");
  assert.equal(machine.state, STATES.FAILED);
  assert.equal(machine.failReason, "boom");
});

test("状态机：终态不可再迁移", () => {
  for (const terminal of Object.keys(TRANSITIONS).filter((k) => TRANSITIONS[k].length === 0)) {
    const machine = new TaskStateMachine({});
    machine.start();
    if (terminal === STATES.SUCCESS) machine.succeed();
    if (terminal === STATES.FAILED) machine.fail("x");
    if (terminal === STATES.CANCELLED) machine.cancel("x");
    assert.throws(() => machine.transition(STATES.RUNNING));
  }
});

// ---------- TaskManager v2 ----------

function noopCtx(ctx) {
  // 空任务：直接返回
  return Promise.resolve(ctx.payload);
}

test("TaskManager v2：成功路径发 started/succeeded 事件并存历史", async () => {
  const bus = new EventBus();
  const events = [];
  bus.on("*", (envelope) => events.push(envelope.event));
  const manager = new TaskManager({ eventBus: bus });
  const result = await manager.start("demo", { v: 1 }, async (ctx) => ctx.payload.v + 1);
  assert.equal(result, 2);
  // started + stateChanged(PENDING→RUNNING) + stateChanged(RUNNING→SUCCESS) + succeeded
  assert.deepEqual(events, ["task.started", "task.stateChanged", "task.stateChanged", "task.succeeded"]);
  assert.equal(manager.historyList().length, 1);
  assert.equal(manager.historyList()[0].state, STATES.SUCCESS);
});

test("TaskManager v2：失败路径发 failed 事件且错误向上抛", async () => {
  const bus = new EventBus();
  const events = [];
  bus.on("*", (envelope) => events.push(envelope.event));
  const manager = new TaskManager({ eventBus: bus });
  await assert.rejects(
    () => manager.start("demo", {}, async () => { throw new Error("炸了"); }),
    /炸了/
  );
  assert.ok(events.includes("task.failed"));
  assert.equal(manager.historyList()[0].state, STATES.FAILED);
  assert.equal(manager.historyList()[0].failReason, "炸了");
});

test("TaskManager v2：停止后任务以 CANCELLED 收尾", async () => {
  const bus = new EventBus();
  const events = [];
  bus.on("*", (envelope) => events.push(envelope.event));
  const manager = new TaskManager({ eventBus: bus });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const p = manager.start("demo", {}, async (ctx) => {
    await gate;
    return ctx.shouldStop() ? "stopped" : "done";
  });
  await new Promise((r) => setTimeout(r, 50));
  manager.stop();
  release();
  const result = await p;
  assert.equal(result, "stopped");
  assert.ok(events.includes("task.cancelled"));
  assert.equal(manager.historyList()[0].state, STATES.CANCELLED);
});

test("TaskManager v2：暂停检查点挂起，恢复后继续", async () => {
  const bus = new EventBus();
  const events = [];
  bus.on("*", (envelope) => events.push(envelope.event));
  const manager = new TaskManager({ eventBus: bus });
  const marks = [];
  const p = manager.start("demo", {}, async (ctx) => {
    marks.push("before");
    while (!ctx.shouldStop()) {
      await ctx.pausePoint("mid");
      marks.push("loop");
      await new Promise((r) => setTimeout(r, 25));
    }
    return "stopped";
  });
  // 等任务跑到检查点循环
  await new Promise((r) => setTimeout(r, 60));
  manager.pause();
  const frozenAt = marks.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(marks.length, frozenAt, "挂起后不应继续推进");
  assert.equal(manager.currentState().state, STATES.PAUSED);
  manager.resume();
  await new Promise((r) => setTimeout(r, 150));
  manager.stop();
  const result = await p;
  assert.equal(result, "stopped");
  assert.ok(events.includes("task.paused") && events.includes("task.resumed"));
  assert.ok(marks.filter((m) => m === "loop").length >= 1, "恢复后应继续推进");
});

test("TaskManager v2：暂停中停止 → CANCELLED 且任务退出", async () => {
  const manager = new TaskManager({ eventBus: new EventBus() });
  const p = manager.start("demo", {}, async (ctx) => {
    while (!ctx.shouldStop()) {
      await ctx.pausePoint("mid");
      await new Promise((r) => setTimeout(r, 25));
    }
    return "stopped";
  });
  await new Promise((r) => setTimeout(r, 60));
  manager.pause();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(manager.currentState().state, STATES.PAUSED);
  manager.stop();
  const result = await p;
  assert.equal(result, "stopped");
  assert.equal(manager.historyList()[0].state, STATES.CANCELLED);
});

test("TaskManager v2：互斥（运行中再 start 抛错）", async () => {
  const manager = new TaskManager({ eventBus: new EventBus() });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const p1 = manager.start("a", {}, async () => { await gate; return 1; });
  await assert.rejects(() => manager.start("b", {}, async () => 2), /已有任务正在运行/);
  release();
  await p1;
});

test("TaskManager v2：updateLiveSettings 运行中热更新（修复 v1 缺失方法）", async () => {
  const manager = new TaskManager({ eventBus: new EventBus() });
  // 无任务时调用不报错
  manager.updateLiveSettings({ a: 1 });
  let seen = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const p = manager.start("demo", { model: "old" }, async (ctx) => {
    seen = ctx.livePayload().model;
    await gate;
    seen = ctx.livePayload().model;
    return seen;
  });
  await new Promise((r) => setTimeout(r, 50));
  manager.updateLiveSettings({ model: "new" });
  release();
  const result = await p;
  assert.equal(result, "new");
});

test("TaskManager v2：stop 优先于 pause", async () => {
  const manager = new TaskManager({ eventBus: new EventBus() });
  const p = manager.start("demo", {}, async (ctx) => {
    manager.pause();
    await ctx.pausePoint("mid");
    return ctx.shouldStop() ? "stopped" : "resumed";
  });
  await new Promise((r) => setTimeout(r, 80));
  manager.stop();
  const result = await p;
  assert.equal(result, "stopped");
  assert.equal(manager.historyList()[0].state, STATES.CANCELLED);
});
