"use strict";

/** 爬题纯协议的单测（假 fetch，不碰网络）。重点锁住"分类名必须是英文"这条。 */

const test = require("node:test");
const assert = require("node:assert");
const { fetchQuestionPage, codeOfCategory } = require("../../electron/src/zhidao/protocol-crawl");

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => { calls.push({ url, init }); const { status = 200, body = "" } = handler(url, init) || {}; return { status, ok: status < 300, text: async () => body }; };
  impl.calls = calls;
  return impl;
}

test("codeOfCategory：中文分类名映射到接口要的英文名（传中文会得到 100004 参数错误）", () => {
  assert.equal(codeOfCategory("情感类"), "emotion");
  assert.equal(codeOfCategory("教育类"), "education");
  assert.equal(codeOfCategory("综合类"), "general");
  assert.equal(codeOfCategory("人物类"), "celebrity");
  // 容错：省掉"类"、或直接给英文
  assert.equal(codeOfCategory("情感"), "emotion");
  assert.equal(codeOfCategory("emotion"), "emotion");
  assert.equal(codeOfCategory("不存在的类"), "");
});

test("fetchQuestionPage：正常解析出 qid/标题/链接", async () => {
  const f = fakeFetch(() => ({
    body: JSON.stringify({ code: 200, data: { list: [{ qid: 3220904808, question: "中东二中的事", query: "远东二中", l1: "教育培训", l2: "K12" }] } }),
  }));
  const r = await fetchQuestionPage({ cookie: "BDUSS=x", category: "教育类", base: 0, rn: 5, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].qid, "3220904808");
  assert.equal(r.rows[0].title, "中东二中的事");
  assert.match(r.rows[0].questionUrl, /question\/hx\/3220904808\.html$/);
  assert.match(f.calls[0].url, /category=education/);
  assert.match(f.calls[0].url, /rn=5/);
  assert.match(f.calls[0].url, /base=0/);
});

test("fetchQuestionPage：分类名不认识时直接返回中文提示，不发请求（省一次必然失败的往返）", async () => {
  const f = fakeFetch(() => ({ body: "{}" }));
  const r = await fetchQuestionPage({ cookie: "x", category: "瞎写的", fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不认识的分类/);
  assert.equal(f.calls.length, 0);
});

test("fetchQuestionPage：没有 qid 的条目被丢掉（没有 qid 就没法去答题）", async () => {
  const f = fakeFetch(() => ({ body: JSON.stringify({ code: 200, data: { list: [{ question: "无qid" }, { qid: 1, question: "有qid" }] } }) }));
  const r = await fetchQuestionPage({ cookie: "x", category: "情感类", fetchImpl: f });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].qid, "1");
});

test("fetchQuestionPage：code≠200 时把平台原话带出来", async () => {
  const f = fakeFetch(() => ({ body: JSON.stringify({ code: 100004, msg: "参数错误" }) }));
  const r = await fetchQuestionPage({ cookie: "x", category: "情感类", fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.reason, /100004/);
});
