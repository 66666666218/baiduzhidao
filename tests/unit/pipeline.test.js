"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { Pipeline } = require("../../electron/src/workflows/pipeline");
const { EventBus } = require("../../electron/src/events/bus");

test("Pipeline：阶段链式传递与结果收集", async () => {
  const pipeline = new Pipeline({
    name: "demo",
    stages: [
      { name: "s1", run: async () => 1 },
      { name: "s2", run: async ({ previous }) => previous.s1 + 1 },
      { name: "s3", run: async ({ previous }) => previous.s2 * 10 },
    ],
  });
  const result = await pipeline.run({ input: {} });
  assert.deepEqual(result, { s1: 1, s2: 2, s3: 20 });
});

test("Pipeline：事件（stageStarted/Succeeded/Failed）", async () => {
  const bus = new EventBus();
  const events = [];
  bus.on("pipeline.*", (e) => events.push(e.event + ":" + e.stage));
  const pipeline = new Pipeline({
    name: "demo",
    eventBus: bus,
    stages: [
      { name: "ok", run: async () => 1 },
      { name: "boom", run: async () => { throw new Error("x"); } },
    ],
  });
  await assert.rejects(() => pipeline.run({}), /\[阶段失败:boom\]/);
  assert.ok(events.includes("pipeline.stageStarted:ok"));
  assert.ok(events.includes("pipeline.stageSucceeded:ok"));
  assert.ok(events.includes("pipeline.stageFailed:boom"));
});

test("Pipeline：失败即停（后续阶段不执行）", async () => {
  let ran = false;
  const pipeline = new Pipeline({
    name: "demo",
    stages: [
      { name: "a", run: async () => { throw new Error("中断"); } },
      { name: "b", run: async () => { ran = true; } },
    ],
  });
  await assert.rejects(() => pipeline.run({}));
  assert.equal(ran, false);
});

test("Pipeline：断点续跑（completedStages 跳过，跳过阶段向下游传 null）", async () => {
  const runs = [];
  const saved = [];
  const pipeline = new Pipeline({
    name: "demo",
    checkpoint: { load: () => ({ completedStages: ["a"] }), save: (s) => saved.push(s) },
    stages: [
      { name: "a", run: async () => { runs.push("a"); return 1; } },
      { name: "b", run: async ({ previous }) => { runs.push("b"); return (previous.a || 0) + 2; } },
    ],
  });
  const result = await pipeline.run({});
  assert.deepEqual(result, { a: null, b: 2 }, "b 收到 previous.a=null → 0+2");
  assert.deepEqual(runs, ["b"], "已完成的 a 不应重复执行");
  assert.ok(saved.some((s) => s.completedStages.includes("b")));
});

test("Pipeline：checkpoint.save 每阶段推进一次", async () => {
  const saved = [];
  const pipeline = new Pipeline({
    name: "demo",
    checkpoint: { load: () => null, save: (s) => saved.push(s.completedStages.slice()) },
    stages: [
      { name: "a", run: async () => 1 },
      { name: "b", run: async () => 2 },
    ],
  });
  await pipeline.run({});
  assert.deepEqual(saved, [["a"], ["a", "b"]]);
});
