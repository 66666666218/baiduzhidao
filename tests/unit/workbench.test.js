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

// ---------- 逐条被拒原因（结果文件） ----------
const { pickFailedRows, countReasons } = require("../../electron/src/netdisk/workbench");

// 真实结果表的行（实测抓取）：qid / 问题 / 答案 / 是否成功 / 失败原因 / 问题链接
const RESULT_ROWS = [
  { qid: 0, 问题: "兰香如故《2026》1-47完整版网盘链接哪里找", 答案: "<p>https://pan.baidu.com/s/1GTCJgTma</p>", 是否成功: "否", 失败原因: "审核失败", 问题链接: "" },
  { qid: 3159397590, 问题: "哪里有篱笆墙外电影的百度云资源分享", 答案: "<p><a href=\"https://pan.baidu.com/s/1X2p\">x</a></p>", 是否成功: "是", 失败原因: "", 问题链接: "https://zhidao.baidu.com/question/342803180260296325.html" },
  { qid: 0, 问题: "求埃及王子完整版网盘资源下载", 答案: "<p>https://pan.baidu.com/s/1dVU6WHJkg</p>", 是否成功: "否", 失败原因: "审核失败", 问题链接: "" },
  { qid: 123, 问题: "重复的那条", 答案: "x", 是否成功: "否", 失败原因: "URL重复提交", 问题链接: "" },
];

test("pickFailedRows：只挑被拒的行，并带上原因", () => {
  const failed = pickFailedRows(RESULT_ROWS);
  assert.equal(failed.length, 3, "4 行里 3 行被拒");
  assert.ok(failed.every((r) => r.reason), "每条都要有原因");
  assert.equal(failed[0].reason, "审核失败");
  assert.equal(failed[2].reason, "URL重复提交");
});

test("pickFailedRows：把 qid 和「答案里有没有网盘链接」一并带出来（归因要用）", () => {
  const failed = pickFailedRows(RESULT_ROWS);
  const byTitle = (kw) => failed.find((r) => r.title.includes(kw));
  assert.equal(byTitle("兰香如故").qid, 0, "平台自动建题的行 qid 是 0");
  assert.equal(byTitle("兰香如故").hasLink, true, "答案里有网盘链接");
  assert.equal(byTitle("重复的那条").qid, 123, "有真实 qid 的行照常带出来");
});

test("pickFailedRows：成功行不算；原因缺失时给占位而不是空串", () => {
  const failed = pickFailedRows([{ qid: 1, 是否成功: "否", 失败原因: "" }]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, "(未给出原因)");
});

test("pickFailedRows：空/异常输入不炸", () => {
  assert.deepEqual(pickFailedRows(null), []);
  assert.deepEqual(pickFailedRows([]), []);
  assert.deepEqual(pickFailedRows([null, undefined]), []);
});

test("countReasons：按次数降序", () => {
  const reasons = countReasons(pickFailedRows(RESULT_ROWS));
  assert.deepEqual(reasons, [{ reason: "审核失败", count: 2 }, { reason: "URL重复提交", count: 1 }]);
});
