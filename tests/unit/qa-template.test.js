"use strict";

const test = require("node:test");
const assert = require("node:assert");

const qaLib = require("../../electron/src/netdisk/qa-template-lib");

// 这两条是照真实审核结果定的（实测 108 条软件内上传）：
// 含空 <img src=""> 的那组被拒 13.8%，不含的 0%；裸链接那组 12.3%，<a> 那组 6.9%。
// 平台把带无效元素 / 裸链接的回答判成"审核失败"。

test("buildAnswerHtml：绝不产出空的 <img src=\"\">", () => {
  const html = qaLib.buildAnswerHtml("https://pan.baidu.com/s/abc123", "一部电影");
  assert.doesNotMatch(html, /<img/i, "空 img 是无效元素，实测 12 条被拒全在含它的那组");
});

test("buildAnswerHtml：即便调用方传了 keepImg=true 也不产出空 img", () => {
  // 历史上 8 个脚本都传 true——留开关等于留一个把坏元素放回去的口子，所以直接删掉
  const html = qaLib.buildAnswerHtml("https://pan.baidu.com/s/abc123", "一部电影", true);
  assert.doesNotMatch(html, /<img/i);
});

test("buildAnswerHtml：链接必须是可点的 <a href>，不能是裸 URL", () => {
  const url = "https://pan.baidu.com/s/abc123";
  const html = qaLib.buildAnswerHtml(url, "一部电影");
  // 用 includes 而不是拼正则：URL 里有点和斜杠，模板字符串里写 \s 又会被解析成 s，坑多
  assert.ok(html.includes(`<a href="${url}">`), "链接要包成 <a href>");
  assert.ok(html.includes(`>${url}</a>`), "锚文本也要是链接本身，让人看得见");
});

test("buildAnswerHtml：链接为空时不产出 href=\"\" 这种坏属性", () => {
  const html = qaLib.buildAnswerHtml("", "无链接");
  assert.match(html, /<a href=""><\/a>|简介：无链接/, "空链接不能炸，也不该产坏属性");
});

test("buildAnswerHtml：简介原文保留", () => {
  const html = qaLib.buildAnswerHtml("https://pan.baidu.com/s/1", "剧情扎实");
  assert.match(html, /简介：剧情扎实/);
});

// ---------- 标题质量（照被拒条目修的三处） ----------
const { parseName, buildTitle } = require("../../electron/src/netdisk/qa-template-lib");

test("标题不再年份重复（实测事故：同一个年份出现三次）", () => {
  // 资源名「兰香如故《2026》1-47完整版2026电影」原本产出
  // 「哪里有兰香如故《2026》1-47完整版2026电影2026电视剧的…」
  const meta = parseName("兰香如故《2026》1-47完整版2026电影");
  for (let i = 0; i < 8; i += 1) {
    const t = buildTitle(meta, i);
    assert.ok((t.match(/2026/g) || []).length <= 1, `模板 ${i} 年份重复了：${t}`);
  }
});

test("标题清掉书名号年份与集数残渣", () => {
  const meta = parseName("兰香如故《2026》1-47完整版2026");
  assert.doesNotMatch(meta.title, /[《》]/, "书名号年份是元数据，标题不需要");
  assert.doesNotMatch(meta.title, /\d+\s*[-~]\s*\d+\s*完整版/, "集数残渣要清掉");
  assert.match(meta.title, /兰香如故/);
});

test("非影视资源不套「电影/电视剧」模板（实测：抖音技术资源被拼成「…电影…」）", () => {
  for (const raw of ["抖音最新注册跳核对技术", "Photoshop 绿色版软件下载", "三体全集小说txt电子书"]) {
    const meta = parseName(raw);
    assert.equal(meta.kind, "资源", `${raw} 不该被判成影视`);
    for (let i = 0; i < 8; i += 1) {
      const t = buildTitle(meta, i);
      assert.doesNotMatch(t, /电影|电视剧|动漫全集/, `模板 ${i} 仍写了影视词：${t}`);
    }
  }
});

test("影视资源照常写「电影/电视剧」（别把上一条修过头）", () => {
  assert.equal(parseName("流浪地球（2019）").kind, "电影");
  assert.match(buildTitle(parseName("流浪地球（2019）"), 0), /电影/);
  assert.equal(parseName("兰香如故1-47完整版").kind, "剧集");
  assert.match(buildTitle(parseName("兰香如故1-47完整版"), 0), /电视剧/);
});

test("标题长度仍在平台要求的 5~49 字之间", () => {
  for (const raw of ["流浪地球（2019）", "抖音最新注册跳核对技术", "短", "很长很长很长很长很长很长很长很长很长很长很长很长的资源名字测试用"]) {
    const meta = parseName(raw);
    for (let i = 0; i < 8; i += 1) {
      const t = buildTitle(meta, i);
      assert.ok(t.length >= 5 && t.length <= 49, `模板 ${i} 长度越界(${t.length})：${t}`);
    }
  }
});
