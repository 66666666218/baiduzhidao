"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  formatTime,
  summarizeTasks,
  formatTask,
  pickTaskList,
  pickTaskTotal,
  pickUserInfo,
} = require("../../electron/src/netdisk/workbench");

// 真实抓下来的响应片段（/qa/api/bulkqa/tasks）
const REAL_TASKS = [
  { id: 123136, taskName: "测试组1-1/1-4条", status: 2, totalCount: 4, successCount: 4, failCount: 0, usedTotal: 4, createdAt: 1790244948, updatedAt: 1790245060 },
  { id: 122952, taskName: "测试组1-1/1-3条", status: 2, totalCount: 3, successCount: 1, failCount: 2, usedTotal: 1, createdAt: 1790236201, updatedAt: 1790236285 },
  { id: 121337, taskName: "测试组1-1/1-10条", status: 2, totalCount: 10, successCount: 8, failCount: 2, usedTotal: 8, createdAt: 1790169205, updatedAt: 1790169620 },
];

test("summarizeTasks：按平台口径汇总（成功=已收录，失败=被拒）", () => {
  const s = summarizeTasks(REAL_TASKS);
  assert.equal(s.taskCount, 3);
  assert.equal(s.totalRows, 17);
  assert.equal(s.successRows, 13);
  assert.equal(s.failedRows, 4);
  assert.equal(s.usedQuota, 13, "扣的额度 = 成功条数（没收录的不扣）");
  assert.equal(s.hasFailure, true);
  assert.ok(s.firstAt && s.lastAt, "应给出时间范围");
});

test("summarizeTasks：全部成功时不报失败", () => {
  const s = summarizeTasks([REAL_TASKS[0]]);
  assert.equal(s.successRows, 4);
  assert.equal(s.failedRows, 0);
  assert.equal(s.hasFailure, false);
});

test("summarizeTasks：空/异常输入不炸", () => {
  for (const input of [[], null, undefined, [null, {}], "不是数组"]) {
    const s = summarizeTasks(input);
    assert.equal(s.taskCount, 0);
    assert.equal(s.hasFailure, false);
  }
});

test("formatTask：三种情形分别说人话", () => {
  assert.match(formatTask(REAL_TASKS[0]), /全部收录 4\/4/);
  assert.match(formatTask(REAL_TASKS[1]), /收录 1\/3，被拒 2 条/);
  assert.match(formatTask({ taskName: "空任务", totalCount: 0 }), /状态未知/);
  assert.match(formatTask({}), /状态未知/, "缺字段也不炸");
});

test("formatTime：非法时间戳返回空串而不是 Invalid Date", () => {
  assert.equal(formatTime(0), "");
  assert.equal(formatTime(NaN), "");
  assert.equal(formatTime("abc"), "");
  assert.ok(formatTime(1790244948).length > 0);
});

test("pickTaskList / pickTaskTotal：取列表与总数", () => {
  const resp = { code: 200, data: { list: REAL_TASKS, total: 122 } };
  assert.equal(pickTaskList(resp).length, 3);
  assert.equal(pickTaskTotal(resp), 122);
});

test("pickTaskList：接口结构变了就返回空数组，不抛错（调用方好据此提示改版）", () => {
  assert.deepEqual(pickTaskList(null), []);
  assert.deepEqual(pickTaskList({}), []);
  assert.deepEqual(pickTaskList({ data: { list: "不是数组" } }), []);
});

test("pickUserInfo：用真实响应字段（username 全小写 / quota / isBanned）", () => {
  // 真实响应（实测抓取）
  const real = { code: 200, msg: "success", data: { hasPermission: true, quota: 10000, usedQuota: 0, username: "俊哦情0I", avatar: "…", isBanned: false, banDays: -1 } };
  const info = pickUserInfo(real);
  assert.equal(info.name, "俊哦情0I", "字段是 username 不是 userName——按驼峰猜过，名字一直是空的");
  assert.equal(info.remainingQuota, 10000);
  assert.equal(info.usedQuota, 0);
  assert.equal(info.banned, false);
  assert.equal(info.hasPermission, true);
});

test("pickUserInfo：封禁状态要能报出来（工作台自己会说账号被封）", () => {
  const info = pickUserInfo({ data: { username: "x", quota: 0, isBanned: true, banDays: 7 } });
  assert.equal(info.banned, true);
  assert.equal(info.banDays, 7);
});

test("pickUserInfo：缺字段时给 NaN 而不是 0（0 会被误读成额度用完）", () => {
  assert.ok(Number.isNaN(pickUserInfo({}).remainingQuota));
  assert.equal(pickUserInfo({}).banned, false, "缺字段时默认不算封禁");
});
