"use strict";

/**
 * 第 9 轮：从**本机参考实现**（C:\Users\周万鹏\wangpan 的 baidu provider）补三条实测结论。
 *
 * 为什么现在才拿到：用户之前给的 Gitee 地址（qingchuangjy/wangpan）其实已不可访问
 * （Gitee 用户接口 404、仓库接口 "Not Found Project"），但那份代码就在本机
 * C:\Users\周万鹏\wangpan。它的 CHANGELOG 里记了三条本项目缺的东西：
 *
 *   ① **errno=115 = 百度禁止二次分享**（永久性，换号/等明天都没用）
 *      → 必须与"每日 300 上限"分开处置：上限封账号、禁分享只放弃这一条；
 *   ② **errno=4 且 duplicated 为空时，按「目标目录 + 分享真实路径」拼出落盘路径**
 *      → 以前拿不到路径就抛错，导致该条每轮被当失败重来（重传+再分享），纯属自伤；
 *   ③ **顶层 errno=0 但 info[0].errno 有错时，把 info 的 errno 提升到顶层**
 *      → 否则"容量不足/登录失效"会被误判成成功，最后报一句"未取得落盘路径"。
 */

const test = require("node:test");
const assert = require("node:assert");

const { isShareForbiddenError } = require("../../electron/src/netdisk/share");
const { runShareStep, nextUsableEnv, decideCapacityOutcome } = require("../../electron/src/tasks/batch-transfer");
const protocol = require("../../electron/src/netdisk/protocol");

// ─────────────────────────────────────────────────────────────
// ① errno=115：禁止二次分享 —— 与每日上限是两回事
// ─────────────────────────────────────────────────────────────

test("isShareForbiddenError：errno=115 算禁止分享", () => {
  assert.equal(isShareForbiddenError(Object.assign(new Error("x"), { errno: 115 })), true);
});

test("isShareForbiddenError：文案含『分享』+『禁止/不允许/无法分享』也算", () => {
  assert.equal(isShareForbiddenError(new Error("share/pset errno=115: 该文件禁止分享")), true);
  assert.equal(isShareForbiddenError(new Error("此分享内容不允许被再次分享")), true);
});

test("isShareForbiddenError：不能把『每日上限』误判成禁止分享（两者处置不同）", () => {
  assert.equal(isShareForbiddenError(new Error("share/pset errno=120: 分享次数已达上限")), false);
  assert.equal(isShareForbiddenError(new Error("创建分享失败")), false);
  assert.equal(isShareForbiddenError(new Error("share/pset 非 JSON: HTTP 502")), false);
});

test("runShareStep：errno=115 → 只放弃这一条，**不封禁账号**（同账号其它资源还能建分享）", async () => {
  const shareBlocked = new Set();
  const r = await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked, sharesByEnv: new Map(), warnedSoft: new Set(), log: () => {},
    createShareFn: async () => { throw Object.assign(new Error("share/pset errno=115: 禁止分享"), { errno: 115 }); },
  });
  assert.equal(r.shareFailed, true);
  assert.equal(r.shareForbidden, true);
  assert.equal(r.shareLimited, false, "禁止分享不是每日上限");
  assert.equal(shareBlocked.size, 0, "绝不能因此把账号加进封禁名单");
});

test("runShareStep：errno=115 的日志要点明『换号/等明天都没用』", async () => {
  const logs = [];
  await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked: new Set(), sharesByEnv: new Map(), warnedSoft: new Set(), log: (m) => logs.push(m),
    createShareFn: async () => { throw Object.assign(new Error("errno=115"), { errno: 115 }); },
  });
  assert.ok(logs.some((l) => l.includes("禁止二次分享")), "要说明是禁止分享");
  assert.ok(logs.some((l) => l.includes("换号") && l.includes("明天")), "要说明这不是临时问题");
});

test("runShareStep：errno=120 → 仍然封禁账号（每日上限，换号/明天能好）", async () => {
  const shareBlocked = new Set();
  const r = await runShareStep({
    makeShare: true, env: "账号1", bduss: "b", stoken: "s", toPaths: ["/x"], dispatcher: undefined,
    shareBlocked, sharesByEnv: new Map(), warnedSoft: new Set(), log: () => {},
    createShareFn: async () => { throw Object.assign(new Error("分享次数已达上限"), { errno: 120 }); },
  });
  assert.equal(r.shareLimited, true);
  assert.equal(r.shareForbidden, false);
  assert.equal(shareBlocked.has("账号1"), true, "每日上限才封禁账号");
});

// ─────────────────────────────────────────────────────────────
// ② protocol.processOne：errno=4 且 duplicated 为空 → 拼出落盘路径
// ─────────────────────────────────────────────────────────────

function fakeResponse(body = {}, { setCookies = [] } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status: 200,
    headers: { getSetCookie: () => setCookies },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

async function withFetch(impl, run) {
  const original = global.fetch;
  global.fetch = impl;
  try { return await run(); } finally { global.fetch = original; }
}

test("protocol：errno=4 且 duplicated/info 都没路径时，按『目标目录+分享真实路径』拼出来盘路径", async () => {
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({
    errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
    file_list: [
      { fs_id: 1, isdir: 0, size: 100, server_filename: "星际穿越.mkv", path: "/电影/星际穿越.mkv" },
      { fs_id: 2, isdir: 0, size: 200, server_filename: "流浪地球2.mp4", path: "/电影/流浪地球2.mp4" },
    ],
  });
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/api/create")) return fakeResponse({ errno: 0 });
    // errno=4 但 duplicated / info 都不给路径 —— 实测里百度会这样
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 4, show_msg: "已存在" });
    return fakeResponse({});
  }, async () => {
    const r = await protocol.processOne(jar, {
      link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destParent: "/来自转存/账号A/资源表", fallbackName: "00001",
    });
    assert.equal(r.dup, true, "仍标记为重复转存");
    assert.deepEqual(r.toPaths, ["/来自转存/账号A/资源表/星际穿越.mkv/电影/星际穿越.mkv", "/来自转存/账号A/资源表/星际穿越.mkv/电影/流浪地球2.mp4"],
      "落盘路径 = 最终目录 + 分享里的真实相对路径（含子目录）");
  });
});

test("protocol：errno=4 时 duplicated 有路径仍优先用百度给的（拼路径只是兜底）", async () => {
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
    file_list: [{ fs_id: 1, isdir: 0, size: 100, server_filename: "a.mkv", path: "/a.mkv" }] });
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/api/create")) return fakeResponse({ errno: 0 });
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 4, duplicated: { list: [{ path: "/真实/路径/a.mkv" }] } });
    return fakeResponse({});
  }, async () => {
    const r = await protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" });
    assert.deepEqual(r.toPaths, ["/真实/路径/a.mkv"], "有真实路径时不该被兜底覆盖");
  });
});

test("protocol：errno=4 且既无路径也无分享文件信息时，仍然明确报错", async () => {
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt", file_list: [] });
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 4 });
    return fakeResponse({});
  }, async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" }),
      /重复转存但未取得已有文件路径|分享里没有文件/
    );
  });
});

// ─────────────────────────────────────────────────────────────
// ③ protocol.processOne：info 层 errno 提升到顶层
// ─────────────────────────────────────────────────────────────

test("protocol：顶层 errno=0 但 info[0].errno=-9（容量不足）→ 报出真实 errno，而不是『未取得落盘路径』", async () => {
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
    file_list: [{ fs_id: 1, isdir: 0, size: 100, path: "/a.mkv" }] });
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/api/create")) return fakeResponse({ errno: 0 });
    // 顶层 0，真实错误只在 info 层 —— 这正是以前被误判成"成功但无路径"的形态
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 0, info: [{ errno: -9, path: "/a.mkv" }] });
    return fakeResponse({});
  }, async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" }),
      (err) => {
        assert.match(err.message, /errno=-9/, `要把真实 errno 报出来，实际：${err.message}`);
        assert.doesNotMatch(err.message, /未取得落盘路径/, "不该拿兜底文案盖住真实原因");
        return true;
      }
    );
  });
});

test("protocol：info[0].errno=0（正常）不会误提升，成功路径不受影响", async () => {
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
    file_list: [{ fs_id: 1, isdir: 0, size: 100, path: "/a.mkv" }] });
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/api/create")) return fakeResponse({ errno: 0 });
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 0, info: [{ errno: 0, path: "/a.mkv" }], extra: { list: [{ to: "/x/a.mkv" }] } });
    return fakeResponse({});
  }, async () => {
    const r = await protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" });
    assert.deepEqual(r.toPaths, ["/x/a.mkv"], "info.errno=0 不该被当成错误");
  });
});

test("protocol：errno=2（目标路径不存在）不能被 info 提升覆盖（回落分支要保住）", async () => {
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
    file_list: [{ fs_id: 1, isdir: 0, size: 100, path: "/a.mkv" }] });
  let transferCalls = 0;
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/api/create")) return fakeResponse({ errno: 0 });
    if (url.includes("/share/transfer")) {
      transferCalls += 1;
      // 第一次：errno=2 且 info 里带个 2（提升后仍是 2，不改变行为）
      if (transferCalls === 1) return fakeResponse({ errno: 2, info: [{ errno: 2 }] });
      return fakeResponse({ errno: 0, extra: { list: [{ to: "/顶层/a.mkv" }] } });  // 回落到顶层目录成功
    }
    return fakeResponse({});
  }, async () => {
    const r = await protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destParent: "/转存根/账号A/资源表", fallbackName: "00001" });
    assert.equal(r.fellBack, true, "errno=2 的回落分支必须仍然生效");
    assert.deepEqual(r.toPaths, ["/顶层/a.mkv"]);
  });
});

// ─────────────────────────────────────────────────────────────
// ④ 容量不足：只废这个账号，不废整批（参考实现的"换账号继续"结论）
// ─────────────────────────────────────────────────────────────

const CREDS = [{ env: "账号1" }, { env: "账号2" }, { env: "账号3" }];

test("nextUsableEnv：跳过网盘已满的账号，从游标位置往后找", () => {
  const exhausted = new Set(["账号1"]);
  assert.equal(nextUsableEnv(CREDS, exhausted, 0).env, "账号2", "账号1 满了就该用账号2");
  assert.equal(nextUsableEnv(CREDS, exhausted, 1).env, "账号2", "游标指向满账号时要往后找到第一个能用的");
  assert.equal(nextUsableEnv(CREDS, exhausted, 2).env, "账号3");
});

test("nextUsableEnv：环形查找 —— 前面的账号满了也能绕回后面的", () => {
  const exhausted = new Set(["账号2", "账号3"]);
  assert.equal(nextUsableEnv(CREDS, exhausted, 1).env, "账号1", "2/3 都满了，从 2 起要绕回 1");
});

test("nextUsableEnv：全部账号都满时返回 null（调用方据此停）", () => {
  assert.equal(nextUsableEnv(CREDS, new Set(["账号1", "账号2", "账号3"]), 0), null);
});

test("nextUsableEnv：没有账号满时按游标原样返回", () => {
  assert.equal(nextUsableEnv(CREDS, new Set(), 1).env, "账号2");
  assert.equal(nextUsableEnv(CREDS, new Set(), 5).env, "账号3", "游标越界要按取模处理");
});

test("decideCapacityOutcome：还有别的账号 → 不停批、串行时本 worker 继续换号", () => {
  const r = decideCapacityOutcome({ creds: CREDS, exhaustedEnvs: new Set(["账号1"]), env: "账号2", cc: 1 });
  assert.equal(r.stopAll, false, "一个账号满了不该停整批");
  assert.equal(r.exitWorker, false, "串行时还能换号，worker 不该退出");
  assert.deepEqual(r.restEnvs, ["账号3"], "要报出还剩哪些账号可用");
});

test("decideCapacityOutcome：并行时本线程账号满了 → 本线程退出，但不停整批", () => {
  const r = decideCapacityOutcome({ creds: CREDS, exhaustedEnvs: new Set(["账号1"]), env: "账号2", cc: 3 });
  assert.equal(r.stopAll, false, "其它线程有自己的账号，批不该停");
  assert.equal(r.exitWorker, true, "本线程不能抢别的账号（线程≤账号数是硬前提）");
});

test("decideCapacityOutcome：所有账号都满 → 才真正停整批", () => {
  const r = decideCapacityOutcome({ creds: CREDS, exhaustedEnvs: new Set(["账号1", "账号2"]), env: "账号3", cc: 1 });
  assert.equal(r.stopAll, true);
  assert.equal(r.exitWorker, true);
  assert.deepEqual(r.restEnvs, []);
});

test("decideCapacityOutcome：同一个账号重复报满不会把别人算进去", () => {
  const r = decideCapacityOutcome({ creds: CREDS, exhaustedEnvs: new Set(["账号1"]), env: "账号1", cc: 1 });
  assert.equal(r.stopAll, false);
  assert.deepEqual(r.restEnvs, ["账号2", "账号3"]);
});
