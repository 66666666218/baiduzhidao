"use strict";

/**
 * 纯协议提交的单测。
 * 全部用假 fetch —— 不碰网络、不真提交。
 * 重点锁住那几个"少一个就失败"的点，免得以后被顺手改掉。
 */

const test = require("node:test");
const assert = require("node:assert");

const { fetchSubmitToken, submitAnswer, qidOf } = require("../../electron/src/zhidao/protocol-submit");

/** 造一个假 fetch：记录收到的请求，按脚本返回 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const { status = 200, body = "" } = handler(url, init) || {};
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("fetchSubmitToken：正常拿到 stoken（注意是 loginInfo 的 stoken，不是 Cookie 的 STOKEN）", async () => {
  const f = fakeFetch(() => ({ body: JSON.stringify({ isLogin: 1, userName: "天一项目社", stoken: "abc123" }) }));
  const r = await fetchSubmitToken("BDUSS=x", { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.token, "abc123");
  assert.equal(r.userName, "天一项目社");
  assert.match(f.calls[0].url, /\/api\/loginInfo\?t=\d+$/, "应带时间戳防缓存");
  assert.equal(f.calls[0].init.headers.Cookie, "BDUSS=x");
});

test("fetchSubmitToken：isLogin≠1 时给出「重新粘贴 Cookie」的明确指引（这是最常见的坑）", async () => {
  const f = fakeFetch(() => ({ body: JSON.stringify({ isLogin: 0 }) }));
  const r = await fetchSubmitToken("BDUSS=x", { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /重新粘贴/, "要告诉用户怎么办，不能只说失败");
});

test("fetchSubmitToken：没有 stoken 字段时明确报出来（接口改版的第一信号）", async () => {
  const f = fakeFetch(() => ({ body: JSON.stringify({ isLogin: 1, userName: "x" }) }));
  const r = await fetchSubmitToken("BDUSS=x", { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stoken/);
});

test("submitAnswer：必须带 X-ik-token —— 这是卡了我很久的那一个头", async () => {
  const f = fakeFetch(() => ({ body: JSON.stringify({ errno: 0, data: { aid: 5208513518 } }) }));
  const r = await submitAnswer({ qid: "1524541973268223980", content: "答案", cookie: "BDUSS=x", token: "tok", fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.aid, "5208513518");
  const h = f.calls[0].init.headers;
  assert.equal(h["X-ik-token"], "tok", "缺它就一定失败");
  assert.match(f.calls[0].url, /\/msubmit\/answer$/);
  assert.ok(f.calls[0].init.body.includes("qid=1524541973268223980"));
  assert.ok(f.calls[0].init.body.includes("from_source=hx"));
});

test("submitAnswer：没有 token 时不去发请求（省一次必然失败的往返）", async () => {
  const f = fakeFetch(() => ({ body: "{}" }));
  const r = await submitAnswer({ qid: "1", content: "x", cookie: "c", token: "", fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0, "不该发出去");
});

test("submitAnswer：errno 被翻译成人话，而不是让用户对着数字猜", async () => {
  const cases = [[3008, /Cookie 不完整/], [4, /X-ik-token/], [5, /已回答过/]];
  for (const [errno, re] of cases) {
    const f = fakeFetch(() => ({ body: JSON.stringify({ errno }) }));
    const r = await submitAnswer({ qid: "1", content: "x", cookie: "c", token: "t", fetchImpl: f });
    assert.equal(r.ok, false);
    assert.match(r.reason, re, `errno=${errno} 应有可读解释`);
  }
});

test("qidOf：长/短两种题目链接都能取到 qid", () => {
  assert.equal(qidOf("https://zhidao.baidu.com/question/hx/1524541973268223980.html"), "1524541973268223980");
  assert.equal(qidOf("https://zhidao.baidu.com/question/3230068417.html"), "3230068417");
  assert.equal(qidOf("https://zhidao.baidu.com/question/hx/1524541973268223980?activity=21th"), "1524541973268223980");
  assert.equal(qidOf("https://zhidao.baidu.com/"), "");
});
