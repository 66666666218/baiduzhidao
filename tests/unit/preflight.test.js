"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  cleanTitle, wrapBareLinks, stripEmptyImg, inspectRow, inspectRows, TITLE_MAX,
} = require("../../electron/src/quality/preflight");

// ---------- 自动修：模板产生的问题 ----------

test("体检：空括号/年份重复/集数残渣 → 自动清理并判为 fix", () => {
  const r = inspectRow({ title: "求篱笆墙外（ ）1-47完整版《2026》网盘资源下载", answer: "正文够长足够通过长度检查的示例内容在这里" });
  assert.equal(r.action, "fix");
  assert.doesNotMatch(r.row.title, /[（(]\s*[）)]/, "空括号要清掉");
  assert.doesNotMatch(r.row.title, /1-47完整版/, "集数残渣要清掉");
  assert.doesNotMatch(r.row.title, /《2026》/, "书名号年份要清掉");
  assert.ok(r.issues.length > 0, "要说明修了什么");
});

test("体检：标题超长 → 截断到平台上限", () => {
  const long = "啊".repeat(80);
  const r = inspectRow({ title: long, answer: "正文够长足够通过长度检查的示例内容在这里" });
  assert.equal(r.action, "fix");
  assert.equal(r.row.title.length, TITLE_MAX);
});

test("体检：空 <img src=\"\"> → 移除", () => {
  const r = inspectRow({ title: "正常标题五个字", answer: '<p>这是一段足够长的回答正文内容，用来通过长度检查，后面还跟着一个空的图片标签需要被移除。</p>\n<img src="" />' });
  assert.equal(r.action, "fix");
  assert.doesNotMatch(r.row.answer, /<img/i);
});

test("体检：裸链接 → 包成 <a href>", () => {
  const r = inspectRow({ title: "正常标题五个字", answer: "取资源 https://pan.baidu.com/s/1abc 提取码 ab12 请自取完整版" });
  assert.equal(r.action, "fix");
  assert.match(r.row.answer, /<a href="https:\/\/pan\.baidu\.com\/s\/1abc">/, "要包成可点击链接");
});

test("体检：已经是 <a href> 的链接不许改动", () => {
  const html = '<p><a href="https://pan.baidu.com/s/1abc">https://pan.baidu.com/s/1abc</a></p>';
  const r = inspectRow({ title: "正常标题五个字", answer: html });
  assert.equal(r.action, "pass");
  assert.equal(r.row.answer, html, "不要重复包装");
});

// ---------- 拦住：救不了的 ----------

test("体检：标题为空 / 回答为空 → drop（平台必填）", () => {
  assert.equal(inspectRow({ title: "", answer: "正文足够长的示例内容在这里" }).action, "drop");
  assert.equal(inspectRow({ title: "正常标题五个字", answer: "" }).action, "drop");
});

test("体检：链接重复 → drop（本批已有同一条）", () => {
  const seen = new Set();
  const first = inspectRow({ title: "正常标题五个字", answer: "这是一段足够长的回答正文，用来通过长度检查，不应该被判为过短。", link: "L1" }, { seenLinks: seen });
  const second = inspectRow({ title: "另一个标题六字", answer: "这是一段足够长的回答正文，用来通过长度检查，不应该被判为过短。", link: "L1" }, { seenLinks: seen });
  assert.equal(first.action, "pass");
  assert.equal(second.action, "drop");
  assert.match(second.issues.join(), /链接重复/);
});

// ---------- 重来一次：AI 生成的问题 ----------

test("体检：AI 痕迹 / 不确定词过多 / 正文过短 → retry（不是直接扔）", () => {
  const base = { title: "正常标题五个字" };
  assert.equal(inspectRow({ ...base, answer: "作为AI，我来回答这个问题，内容要够长才行呢" }).action, "retry");
  assert.equal(inspectRow({ ...base, answer: "可能是这样，也许是那样，大概是吧，似乎如此，或许吧，不一定呢" }).action, "retry");
  assert.equal(inspectRow({ ...base, answer: "太短了" }).action, "retry");
});

test("体检：干净的内容判 pass，不做任何改动", () => {
  const row = { title: "流浪地球网盘资源哪里找", answer: "<p>这是一段完全正常的回答内容，长度也足够通过各项检查，没有任何问题。</p>" };
  const r = inspectRow(row);
  assert.equal(r.action, "pass");
  assert.deepEqual(r.issues, []);
  assert.equal(r.row.title, row.title);
  assert.equal(r.row.answer, row.answer);
});

// ---------- 批量 ----------

test("inspectRows：分档统计 + 原因计数 + 剔除项单独返回", () => {
  const rows = [
    { title: "求篱笆墙外（ ）网盘资源下载", answer: "内容足够长的示例文本在这里，可以正常通过检查。" }, // fix
    { title: "正常标题五个字", answer: "作为AI，我来回答这个问题，内容要够长才行呢" },                   // retry
    { title: "", answer: "内容足够长的示例文本在这里" },                                              // drop
    { title: "另一个正常标题六", answer: "<p>干净的内容，长度也足够，不需要任何改动。</p>" },           // pass
  ];
  const r = inspectRows(rows);
  assert.equal(r.stats.total, 4);
  assert.equal(r.kept.length, 3, "drop 的 1 条不进 kept");
  assert.equal(r.dropped.length, 1);
  assert.equal(r.fixed, 1);
  assert.equal(r.retry, 1);
  assert.ok(r.stats.reasons.length > 0, "要给原因计数");
  assert.match(r.dropped[0].issues.join(), /标题为空/);
});

test("inspectRows：空输入不炸", () => {
  const r = inspectRows(null);
  assert.deepEqual(r.kept, []);
  assert.equal(r.stats.total, 0);
});

// ---------- 工具函数边界 ----------

test("cleanTitle / stripEmptyImg / wrapBareLinks：空输入安全", () => {
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle(null), "");
  assert.equal(stripEmptyImg("").html, "");
  assert.equal(wrapBareLinks(null).html, "");
  assert.equal(wrapBareLinks("没有链接的纯文本").changed, false);
});
