"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { AccountManager } = require("../../electron/src/browser/account-manager");
const { Store } = require("../../electron/src/storage/store");
const { nowText } = require("../../electron/src/config");

function makeStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), "acct-")));
}

test("AccountManager：注册/列表/额度计算", () => {
  const manager = new AccountManager({ store: makeStore(), dailyLimit: 5 });
  manager.register(["账号A", "账号B"]);
  const list = manager.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].remaining, 5);
  assert.equal(list[0].usedToday, 0);
});

test("AccountManager：额度耗尽 acquire 抛出明确错误码", () => {
  const store = makeStore();
  store.upsertAnswer({ questionUrl: "https://x/1", answer: "a", bitEnv: "A", status: "已提交", submittedAt: nowText() });
  store.upsertAnswer({ questionUrl: "https://x/2", answer: "b", bitEnv: "A", status: "已提交", submittedAt: nowText() });
  const manager = new AccountManager({ store, dailyLimit: 2 });
  manager.register(["A"]);
  assert.throws(() => manager.acquire("A"), (error) => error.code === "ACCOUNT_QUOTA_EXCEEDED" && /2\/2/.test(error.message));
});

test("AccountManager：release 累计今日用量、markBlocked 拦截 acquire", () => {
  const manager = new AccountManager({ store: makeStore(), dailyLimit: 5 });
  manager.register(["B"]);
  manager.acquire("B");
  manager.release("B", { count: 2 });
  assert.equal(manager.list()[0].usedToday, 2);
  assert.equal(manager.list()[0].remaining, 3);

  manager.markBlocked("B", "连续验证码");
  assert.throws(() => manager.acquire("B"), (error) => error.code === "ACCOUNT_BLOCKED" && /连续验证码/.test(error.message));
  manager.unblock("B");
  assert.doesNotThrow(() => manager.acquire("B"));
});

test("AccountManager：0=不限额，未知账号自动注册", () => {
  const manager = new AccountManager({ store: makeStore(), dailyLimit: 0 });
  const handle = manager.acquire("新账号");
  assert.equal(handle.dailyLimit, 0);
  assert.equal(manager.list().length, 1);
});

test("AccountManager：跨账号隔离（A 的用量不计到 B）", () => {
  const store = makeStore();
  store.upsertAnswer({ questionUrl: "https://x/1", answer: "a", bitEnv: "A", status: "已提交", submittedAt: nowText() });
  const manager = new AccountManager({ store, dailyLimit: 5 });
  manager.register(["A", "B"]);
  assert.equal(manager.usedToday("A"), 1);
  assert.equal(manager.usedToday("B"), 0);
});

test("AccountManager：历史提交不占「今日」额度（换新电脑/迁移数据不再误报已用完）", () => {
  const store = makeStore();
  // 很久以前提交的 3 条。以前这些会被算进"今天"，于是 acquire 直接抛「今日额度已用完」——
  // 带着旧 answers.json 换到新电脑上一跑，就是这个症状。
  for (const i of [1, 2, 3]) {
    store.upsertAnswer({ questionUrl: `https://old/${i}`, answer: "a", bitEnv: "A", status: "已提交", submittedAt: "2000/01/01 09:00:00" });
  }
  store.upsertAnswer({ questionUrl: "https://new/1", answer: "b", bitEnv: "A", status: "已提交", submittedAt: nowText() });
  const manager = new AccountManager({ store, dailyLimit: 5 });
  manager.register(["A"]);
  assert.equal(manager.usedToday("A"), 1, "只应数今天那 1 条");
  assert.equal(manager.list()[0].remaining, 4);
  assert.doesNotThrow(() => manager.acquire("A"));
});

test("AccountManager：没有时间戳的老记录一律不计（宁可少算，不可多算）", () => {
  const store = makeStore();
  store.upsertAnswer({ questionUrl: "https://no-time/1", answer: "a", bitEnv: "A", status: "已提交" });
  const manager = new AccountManager({ store, dailyLimit: 1 });
  manager.register(["A"]);
  assert.equal(manager.usedToday("A"), 0);
  assert.doesNotThrow(() => manager.acquire("A"), "0 用量不该触发额度拦截");
});
