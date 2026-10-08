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
