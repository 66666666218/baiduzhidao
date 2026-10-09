"use strict";

/**
 * 账号并发相关单测。
 *
 * 并发本身是"同一时段多个账号做同样的事"——平台风控最敏感的特征，
 * 所以这几个不变量必须钉死：
 *   1. 默认必须是 1（顺序执行），不能让"没配置"变成"悄悄并发"；
 *   2. 上限统一（几个任务各写一遍上限，早晚只改了两处）；
 *   3. 同时在跑的 worker 数**真的**不超过上限（不是靠 delay 掩盖）；
 *   4. 单个 worker 抛错不能带走其他人。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  runWithConcurrency,
  accountConcurrencyOf,
  MAX_ACCOUNT_CONCURRENCY,
} = require("../../electron/src/domain/account-topic");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个假的 config 对象（任务层拿到的是 deps.config） */
function fakeConfig(value) {
  return { load: () => ({ accountConcurrency: value }) };
}

test("accountConcurrencyOf：没配置 / 0 / NaN / 负数一律回落到 1（顺序执行）", () => {
  assert.equal(accountConcurrencyOf(undefined), 1);
  assert.equal(accountConcurrencyOf({}), 1);                       // 没有 load()
  assert.equal(accountConcurrencyOf(fakeConfig(undefined)), 1);
  assert.equal(accountConcurrencyOf(fakeConfig(0)), 1);
  assert.equal(accountConcurrencyOf(fakeConfig("abc")), 1);
  assert.equal(accountConcurrencyOf(fakeConfig(-3)), 1);
});

test("accountConcurrencyOf：正常值原样返回，超过上限就夹住", () => {
  assert.equal(accountConcurrencyOf(fakeConfig(3)), 3);
  assert.equal(accountConcurrencyOf(fakeConfig("4")), 4);
  assert.equal(accountConcurrencyOf(fakeConfig(999)), MAX_ACCOUNT_CONCURRENCY);
  assert.equal(accountConcurrencyOf(fakeConfig(2.9)), 2, "小数要取整，不能变成 2.9 个并发");
});

test("runWithConcurrency：同时在跑的 worker 数不超过上限", async () => {
  let inFlight = 0;
  let peak = 0;
  const done = [];
  await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    done.push(item);
    inFlight -= 1;
  });
  assert.ok(peak <= 2, `峰值并发 ${peak} 超过了上限 2`);
  assert.equal(done.length, 6, "每条都要跑到");
  assert.equal(inFlight, 0);
});

test("runWithConcurrency：上限大于条数时按条数跑（不会空转出多余的 runner）", async () => {
  let peak = 0;
  let inFlight = 0;
  await runWithConcurrency(["a"], 10, async () => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await sleep(3);
    inFlight -= 1;
  });
  assert.equal(peak, 1);
});

test("runWithConcurrency：单个 worker 抛错不影响其他条目（单账号失败不能拖垮整轮）", async () => {
  const seen = [];
  await runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    if (item === 2) throw new Error("这个账号坏了");
    await sleep(3);
    seen.push(item);
  });
  assert.deepEqual(seen.sort(), [1, 3, 4], "除了坏的那条，其余都要完成");
});

test("runWithConcurrency：shouldStop 返回 true 时不再领新任务", async () => {
  let stopped = false;
  const seen = [];
  await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 1, async (item) => {
    seen.push(item);
    if (item === 2) stopped = true;
  }, () => stopped);
  assert.deepEqual(seen, [1, 2], "停止信号发出后不该再开始新条目");
});

test("runWithConcurrency：空数组 / 非数组输入不炸", async () => {
  await runWithConcurrency([], 4, async () => { throw new Error("不该被调用"); });
  await runWithConcurrency(null, 4, async () => { throw new Error("不该被调用"); });
});

// ---------- 静态守卫：三个任务都得走同一套并发控制 ----------
// 目的很窄：防止"以后新增了一个按账号跑的任务，忘了接并发设置"，
// 或者"某个任务自己写了一个并发数上限，与设置页那个对不上"。
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", "..", "electron", rel), "utf8");

for (const file of ["src/tasks/submit.js", "src/tasks/passed-count.js", "src/tasks/upload-batch.js"]) {
  test(`${file}：并发走统一的 accountConcurrencyOf（不自己写上限）`, () => {
    const code = src(file);
    assert.match(code, /accountConcurrencyOf\(/, "要使用统一的并发上限读取");
    assert.match(code, /runWithConcurrency\(/, "要用统一的并发调度");
  });
}

test("passed-count.js：每个账号有各自的 browser 变量（并发时不能共用一个）", () => {
  const code = src("src/tasks/passed-count.js");
  // 共享一个 browser 变量时，A 的 finally 会把 B 的连接关掉（或者重复关闭）。
  // 判据是**缩进**：函数体顶层是 2 空格，循环体里是 4 空格以上。
  const m = code.match(/^( *)let browser = null;/m);
  assert.ok(m, "应存在 let browser = null;");
  assert.ok(m[1].length >= 4, `browser 必须声明在循环体内（当前缩进 ${m[1].length}），不能是循环外的共享变量`);
});
