"use strict";

/**
 * 网盘协议层 `panFetch` 的单测。全部用假 fetch —— 不碰网络、不碰真实账号。
 *
 * 盯的是三件"漏了不会立刻报错、但后果很实在"的事：
 *   1. UA / Cookie 必须带上（漏了 = 被当成未登录或机器人）；
 *   2. dispatcher 必须带上（漏了 = 这一条走直连，同一批操作从两个 IP 发出）；
 *   3. 超时必须带上（漏了 = 网络卡住时整条链永久吊住，日志里一条错都没有）。
 * 顺带盯 set-cookie 回写：以前每个调用点都要自己 jar.apply，漏一处 Cookie 就丢了。
 */

const test = require("node:test");
const assert = require("node:assert");

const protocol = require("../../electron/src/netdisk/protocol");

/** 造一个够用的假响应：只有 headers.getSetCookie / json / text 被用到 */
function fakeResponse(body = {}, { setCookies = [], status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { getSetCookie: () => setCookies },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** 临时替换 global.fetch，跑完恢复 */
async function withFetch(impl, run) {
  const original = global.fetch;
  global.fetch = impl;
  try { return await run(); } finally { global.fetch = original; }
}

test("panFetch：自动带上统一 UA、jar 的 Cookie、代理 dispatcher、超时", async () => {
  const calls = [];
  const dispatcher = { __fake: "proxy-agent" };
  const jar = new protocol.Jar("BDUSS_VALUE", "STOKEN_VALUE", dispatcher);

  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return fakeResponse({ errno: 0 });
  }, () => protocol.panFetch(jar, "https://pan.baidu.com/api/list?dir=%2F"));

  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.equal(init.headers["User-Agent"], protocol.UA);
  assert.equal(init.headers.Cookie, "BDUSS=BDUSS_VALUE; STOKEN=STOKEN_VALUE");
  assert.equal(init.dispatcher, dispatcher, "漏了它这条请求就走直连 —— 正是要防的那种");
  assert.ok(init.signal, "必须有超时信号");
});

test("panFetch：referer 只在传了的时候才带（没传就不该凭空造一个）", async () => {
  const seen = [];
  const jar = new protocol.Jar("B", "");
  await withFetch(async (url, init) => { seen.push(init.headers); return fakeResponse({}); }, async () => {
    await protocol.panFetch(jar, "https://pan.baidu.com/a", { referer: "https://pan.baidu.com/s/abc" });
    await protocol.panFetch(jar, "https://pan.baidu.com/b");
  });
  assert.equal(seen[0].Referer, "https://pan.baidu.com/s/abc");
  assert.equal(seen[1].Referer, undefined);
});

test("panFetch：调用方传的 header 能覆盖默认值（比如网盘要用客户端型 UA）", async () => {
  const seen = [];
  const jar = new protocol.Jar("B", "");
  await withFetch(async (url, init) => { seen.push(init.headers); return fakeResponse({}); },
    () => protocol.panFetch(jar, "https://pan.baidu.com/x", { headers: { "User-Agent": "netdisk;P2SP" } }));
  assert.equal(seen[0]["User-Agent"], "netdisk;P2SP");
  assert.equal(seen[0].Cookie, "BDUSS=B", "覆盖 UA 不该把 Cookie 一起弄丢");
});

test("panFetch：把响应的 set-cookie 回写进 jar（否则后续请求会丢登录态）", async () => {
  const jar = new protocol.Jar("OLD", "");
  await withFetch(async () => fakeResponse({}, { setCookies: ["BDUSS=NEW; Path=/; HttpOnly", "BAIDUID=XYZ; Path=/"] }),
    () => protocol.panFetch(jar, "https://pan.baidu.com/x"));
  assert.match(jar.str(), /BDUSS=NEW/);
  assert.match(jar.str(), /BAIDUID=XYZ/);
});

test("processOne：不像分享链接的输入给明确报错，而不是 TypeError 崩在 m[1]", async () => {
  const jar = new protocol.Jar("B", "");
  await assert.rejects(
    () => protocol.processOne(jar, { link: "https://pan.baidu.com/", pwd: "", destDir: "/x" }),
    /不认识的分享链接/
  );
});

test("processOne：verify 返回风控码时标记 risk（供上层全局暂停用）", async () => {
  const jar = new protocol.Jar("B", "");
  await withFetch(async () => fakeResponse({ errno: -62 }), async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "1234", destDir: "/x" }),
      (err) => err.risk === true && /verify风控/.test(err.message)
    );
  });
});

test("processOne：提取码为空且 verify 被拒 → 报错要指向「去补提取码」，而不是只丢一个 errno", async () => {
  // 真机现场：搜到的一条资源提取码为空，而那条分享确实需要码 —— 转存时只报
  // `verify errno=-9`，用户完全不知道该干什么。现在直接告诉他去哪儿补。
  const jar = new protocol.Jar("B", "");
  await withFetch(async () => fakeResponse({ errno: -9 }), async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "", destDir: "/x" }),
      (err) => /提取码/.test(err.message) && /补上|删掉/.test(err.message)
    );
  });
});

test("processOne：有提取码时 verify 被拒仍走原来的错误（不要把所有失败都说成缺码）", async () => {
  const jar = new protocol.Jar("B", "");
  await withFetch(async () => fakeResponse({ errno: -9 }), async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" }),
      (err) => /verify errno=-9/.test(err.message) && !/提取码」是空的/.test(err.message)
    );
  });
});
