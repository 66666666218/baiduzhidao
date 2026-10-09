"use strict";

/**
 * 纯协议提交的单测。
 * 全部用假 fetch —— 不碰网络、不真提交。
 *
 * 注：本轮把请求收敛到 `zhidao/http.js`（统一 UA/超时/退避重试），并加了
 * **token 失效自动刷新**，所以断言跟着调整 —— 这是有意的行为变更，不是测试迁就实现。
 */

const test = require("node:test");
const assert = require("node:assert");

const { fetchSubmitToken, submitAnswer, qidOf, explainSubmitErrno } = require("../../electron/src/zhidao/protocol-submit");

/** 造一个假 fetch：记录收到的请求，按脚本返回 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const { status = 200, body = "" } = handler(url, init, calls.length) || {};
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("fetchSubmitToken：正常拿到 stoken（是 loginInfo 的 stoken，不是 Cookie 的 STOKEN）", async () => {
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
  assert.match(r.reason, /账号凭证|重新/, "要告诉用户怎么办，不能只说失败");
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
  assert.equal(f.calls[0].init.headers["X-ik-token"], "tok", "缺它就一定失败");
  assert.match(f.calls[0].url, /\/msubmit\/answer$/);
  assert.ok(f.calls[0].init.body.includes("qid=1524541973268223980"));
  assert.ok(f.calls[0].init.body.includes("from_source=hx"));
});

test("submitAnswer：没传 token 时会自己去取一次（本轮新增 —— 以前直接判失败）", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("loginInfo")) return { body: JSON.stringify({ isLogin: 1, stoken: "autoTok" }) };
    return { body: JSON.stringify({ errno: 0, data: { aid: 111 } }) };
  });
  const r = await submitAnswer({ qid: "1", content: "x", cookie: "c", fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.aid, "111");
  assert.equal(f.calls.length, 2, "先取 token 再提交");
  assert.equal(f.calls[1].init.headers["X-ik-token"], "autoTok");
});

test("submitAnswer：errno=4（令牌失效）时会自动刷新 token 重试一次（本轮新增）", async () => {
  let submits = 0;
  const f = fakeFetch((url) => {
    if (url.includes("loginInfo")) return { body: JSON.stringify({ isLogin: 1, stoken: "fresh" }) };
    submits += 1;
    // 第一次拒绝（令牌过期），第二次放行
    return { body: JSON.stringify(submits === 1 ? { errno: 4 } : { errno: 0, data: { aid: 999 } }) };
  });
  const r = await submitAnswer({ qid: "1", content: "x", cookie: "c", token: "stale", fetchImpl: f });
  assert.equal(r.ok, true, "刷新后应该成功，而不是整条计失败");
  assert.equal(r.aid, "999");
  assert.equal(submits, 2);
});

test("submitAnswer：内容为空时不去发请求（省一次必然失败的往返）", async () => {
  const f = fakeFetch(() => ({ body: "{}" }));
  const r = await submitAnswer({ qid: "1", content: "   ", cookie: "c", token: "t", fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0, "不该发出去");
});

test("explainSubmitErrno：错误码被翻译成人话 + 下一步，而不是让用户对着数字猜", () => {
  assert.match(explainSubmitErrno(3008), /账号凭证|Cookie/);
  assert.match(explainSubmitErrno(4), /令牌|X-ik-token/);
  assert.match(explainSubmitErrno(5), /已回答|去重/);
  assert.match(explainSubmitErrno(-1), /参数/);
  assert.match(explainSubmitErrno(99999), /99999/, "没收录的码也要带上数字，便于反馈");
});

test("qidOf：长/短两种题目链接都能取到 qid", () => {
  assert.equal(qidOf("https://zhidao.baidu.com/question/hx/1524541973268223980.html"), "1524541973268223980");
  assert.equal(qidOf("https://zhidao.baidu.com/question/3230068417.html"), "3230068417");
  assert.equal(qidOf("https://zhidao.baidu.com/question/hx/1524541973268223980?activity=21th"), "1524541973268223980");
  assert.equal(qidOf("https://zhidao.baidu.com/"), "");
});
