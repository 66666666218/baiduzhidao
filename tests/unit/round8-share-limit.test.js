"use strict";

/**
 * 第 8 轮：转存成功 ≠ 分享成功 —— 每日 300 分享上限的误判修复。
 *
 * 背景（来自 GitHub 上 BaiduPanFilesTransfers 等开源工具的实测文档）：
 *   百度硬限制 **单账号每日最多 300 个分享链接**，超出后 share/pset 会拒绝。
 *   这不是 Cookie 失效、也不是转存失败。但 batch-transfer 以前把"建分享失败"误当成
 *   "整条转存失败"——于是已经落盘的文件被算作失败、下次又被重新转存（errno=4 重复）
 *   + 再次建分享（继续被拒），形成"虚假失败"死循环，还白白消耗写请求撞限流窗口。
 *
 * 本轮把"建分享"从外层 catch 里摘出来，单独成 runShareStep：
 *   - 转存成了、分享失败 → 记 share_failed（不重传、不计失败、不触发连败熔断）；
 *   - 若判定是每日上限 → 该账号加入 shareBlocked，本批剩余项只转存不建分享。
 *
 * 这里用注入的假 createShare 把 runShareStep 的判定逻辑全测到，不碰真实网络。
 */

const test = require("node:test");
const assert = require("node:assert");

const { isShareLimitError, SHARE_DAILY_LIMIT } = require("../../electron/src/netdisk/share");
const { runShareStep } = require("../../electron/src/tasks/batch-transfer");

// ─────────────────────────────────────────────────────────────
// isShareLimitError：判定"每日分享上限"还是"普通分享错误"
// ─────────────────────────────────────────────────────────────

test("isShareLimitError：errno=120 算每日上限", () => {
  assert.equal(isShareLimitError(Object.assign(new Error("x"), { errno: 120 })), true);
});

test("isShareLimitError：文案含『分享』+『上限/次数/限制』算每日上限", () => {
  assert.equal(isShareLimitError(new Error("share/pset errno=-20: 分享次数已达上限")), true);
  assert.equal(isShareLimitError(new Error("分享数量超过每日限制")), true);
  assert.equal(isShareLimitError(new Error("当天分享已达到上限")), true);
});

test("isShareLimitError：普通分享错误（网络抖动/无 link）不算上限", () => {
  assert.equal(isShareLimitError(new Error("创建分享失败")), false);
  assert.equal(isShareLimitError(new Error("share/pset errno=-6: 未登录")), false);
  assert.equal(isShareLimitError(new Error("share/pset 非 JSON: HTTP 502")), false);
});

// ─────────────────────────────────────────────────────────────
// runShareStep：成功 / 各类失败 / 上限封禁 / 不建分享
// ─────────────────────────────────────────────────────────────

function fakeShare(makeLink = true, throwErr = null) {
  return async () => {
    if (throwErr) throw throwErr;
    return { link: makeLink ? "https://pan.baidu.com/s/abc" : "", password: "wxyz" };
  };
}

test("runShareStep：建分享成功 → 返回 ownLink、shareFailed=false、计数 +1", async () => {
  const shareBlocked = new Set();
  const sharesByEnv = new Map();
  const warnedSoft = new Set();
  const logs = [];
  const r = await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked, sharesByEnv, warnedSoft, log: (m) => logs.push(m), createShareFn: fakeShare(true),
  });
  assert.equal(r.shareFailed, false);
  assert.equal(r.shareLimited, false);
  assert.match(r.ownLink, /^https:\/\/pan\.baidu\.com\/s\/abc\?pwd=wxyz$/);
  assert.equal(sharesByEnv.get("账号1"), 1, "该账号分享计数 +1");
});

test("runShareStep：makeShare=false → 不调用 createShare、ownLink 为空、shareFailed=false", async () => {
  let called = 0;
  const r = await runShareStep({
    makeShare: false, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked: new Set(), sharesByEnv: new Map(), warnedSoft: new Set(), log: () => {},
    createShareFn: async () => { called += 1; return { link: "L", password: "p" }; },
  });
  assert.equal(r.shareFailed, false);
  assert.equal(r.ownLink, "");
  assert.equal(called, 0, "createShare 不应被调用");
});

test("runShareStep：普通分享错误（非上限）→ shareFailed=true、shareLimited=false、不封禁账号", async () => {
  const shareBlocked = new Set();
  const r = await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked, sharesByEnv: new Map(), warnedSoft: new Set(), log: () => {},
    createShareFn: fakeShare(true, new Error("创建分享失败")),
  });
  assert.equal(r.shareFailed, true);
  assert.equal(r.shareLimited, false, "普通错误不应判定为每日上限");
  assert.equal(shareBlocked.has("账号1"), false, "普通错误不应封禁账号");
  assert.match(r.shareErrMsg, /创建分享失败/);
});

test("runShareStep：每日上限错误 → shareFailed=true、shareLimited=true、账号被封禁", async () => {
  const shareBlocked = new Set();
  const r = await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked, sharesByEnv: new Map(), warnedSoft: new Set(), log: () => {},
    createShareFn: fakeShare(true, new Error("share/pset errno=120: 分享次数已达上限")),
  });
  assert.equal(r.shareFailed, true);
  assert.equal(r.shareLimited, true);
  assert.equal(shareBlocked.has("账号1"), true, "撞上限的账号必须被加入封禁名单");
});

test("runShareStep：账号已封禁 → 直接返回 shareFailed+shareLimited，不再调用 createShare", async () => {
  let called = 0;
  const shareBlocked = new Set(["账号1"]);
  const r = await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked, sharesByEnv: new Map(), warnedSoft: new Set(), log: () => {},
    createShareFn: async () => { called += 1; return { link: "L", password: "p" }; },
  });
  assert.equal(r.shareFailed, true);
  assert.equal(r.shareLimited, true);
  assert.equal(called, 0, "封禁后不应再打分享接口");
});

test("runShareStep：逼近上限时提前警告一次（软上限，SHARE_DAILY_LIMIT-10）", async () => {
  const shareBlocked = new Set();
  const sharesByEnv = new Map();
  const warnedSoft = new Set();
  const logs = [];
  // 先填到 软上限-1，再跑一次触发警告
  sharesByEnv.set("账号1", SHARE_DAILY_LIMIT - 11);
  const r = await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked, sharesByEnv, warnedSoft, log: (m) => logs.push(m), createShareFn: fakeShare(true),
  });
  assert.equal(r.shareFailed, false);
  assert.equal(sharesByEnv.get("账号1"), SHARE_DAILY_LIMIT - 10, "计数正确累加");
  assert.equal(warnedSoft.has("账号1"), true, "逼近上限应触发软警告");
  assert.ok(logs.some((l) => l.includes("逼近") && l.includes(String(SHARE_DAILY_LIMIT))), "日志要说出具体上限数字");
});

test("runShareStep：软警告只报一次（不打刷屏）", async () => {
  const logs = [];
  let env = new Map([["账号1", SHARE_DAILY_LIMIT - 11]]);
  const warnedSoft = new Set();
  for (let i = 0; i < 3; i += 1) {
    await runShareStep({
      makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
      shareBlocked: new Set(), sharesByEnv: env, warnedSoft, log: (m) => logs.push(m), createShareFn: fakeShare(true),
    });
  }
  const warns = logs.filter((l) => l.includes("逼近"));
  assert.equal(warns.length, 1, "软警告只能报一次");
});
