"use strict";

/**
 * 第 16 轮 B：「我只选择了一个账号，但两个账号都跑了」的回归测试。
 *
 * 根因不是"去重没做"（去重早就做了），而是**那些页面根本没有账号框** ——
 * 「自动提交」和「题目爬取」页一直硬编码 `bitEnvs: settings.bitEnvs`（设置页全量账号）。
 * 于是用户在任何地方只留一个号都不生效：设置页有几个号就跑几个号，
 * 而日志里连"这次跑的是哪几个"都没写，只能靠猜。
 *
 * 这一幕在本仓库是**第二次**发生（第一次是「批量上传」页，已修）—— 所以这里除了修，
 * 还要钉死两件事：
 *   1. 会对外动作的入口，账号必须来自「本页账号框优先、留空才回落设置页」的同一套规则；
 *   2. 每次开工都要把「本次参与账号（N 个）：…」打进日志（主进程 + 编排各一份）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { envLabelsOf } = require("../../electron/src/domain/account-topic");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * 剥注释（保字符串）：下面要查的是 `bitEnvs: settings.bitEnvs` 这种**真实代码**，注释里举例不算。
 *
 * ⚠️ **必须先剥行注释、再剥块注释**。反过来做会被「scripts 目录下那些 js」这类写法带偏：
 * 它在**行注释**里出现了块注释的起始符，块注释剥离器会从那里一直吃到下一个块注释结束符，
 * 把中间几百行**真实代码**整段吞掉（本文件写的时候就是这样把 app-context.js 新加的
 * 「本次参与账号」留痕整段吃没了，测试报"没找到"而代码其实就在那儿）。
 * 这正是本项目反复出现的「守卫咬自己的手」，但这次咬的是**被扫文件里的注释**。
 * （同理：注释里想写出块注释的起止符，只能像上面这样用中文描述，直接写会被当成真注释。）
 */
function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 从 renderer.js 里切出 `rpc.invoke("task:xxx", { ... })` 的 payload 块。
 * 用花括号配对而不是正则偷懒：payload 里有嵌套对象/数组，按行猜会切错。
 */
function payloadBlockOf(src, taskName) {
  const marker = `rpc.invoke("task:${taskName}", {`;
  const start = src.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  let i = start + marker.length - 1; // 停在第一个 {
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start); // 没配平（不该发生）—— 返回到末尾，断言照样能抓到问题
}

/** 会对外动作（发出去/扣额度/占空间）的入口：这些地方绝不能硬用设置页全量账号 */
const WRITE_TASKS = ["submit", "upload-by-topic", "batch-upload", "auto-pipeline", "batch-transfer"];

test("A1 envLabelsOf：字符串与 {label} 混排都能取到裸名字，空值剔除", () => {
  assert.deepEqual(envLabelsOf(["A", { label: "B" }, { name: "C" }, "", null, "  "]), ["A", "B", "C"]);
  assert.deepEqual(envLabelsOf(null), []);
});

test("A2 ★ 对外动作的入口，payload 里不许硬编码 settings.bitEnvs（否则用户选了也不生效）", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  for (const name of WRITE_TASKS) {
    const block = payloadBlockOf(src, name);
    assert.ok(block, `renderer.js 里找不到 task:${name} 的调用`);
    assert.ok(!/bitEnvs:\s*settings\.bitEnvs/.test(block),
      `task:${name} 的账号写死成设置页全量 —— 用户在本页只填一个号也拦不住（"选了一个却跑了两个"就是它）`);
  }
});

test("A3 提交/爬取两个页面必须有自己的账号框（没有框就不可能只选一个号）", () => {
  const html = read("electron/renderer/index.html");
  assert.match(html, /id="submitBitEnvs"/, "「自动提交」页缺「本次提交账号」框");
  assert.match(html, /id="crawlBitEnvs"/, "「题目爬取」页缺「本次爬取账号」框");
});

test("A4 两个新框必须真的被读（只加 DOM 不接线 = 又一个「我设了但没生效」）", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  assert.match(src, /resolveEnvsFromBox\("submitBitEnvs"/);
  assert.match(src, /resolveEnvsFromBox\("crawlBitEnvs"/);
  // 上传页那个框沿用同一套规则（历史上它被绕过过一次）
  assert.match(src, /resolveEnvsFromBox\("uploadBitEnv"/);
});

test("A5 回落设置页时必须**说出来**用了哪几个号（静默用全量 = 最贵的一类事故）", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  assert.match(src, /function logEnvSource/, "缺少「账号来源」的统一播报函数");
  assert.match(src, /logEnvSource\("本次提交账号"/);
  assert.match(src, /logEnvSource\("本次爬取账号"/);
  assert.match(src, /用设置页的全部账号/, "回落时必须点明是设置页全量，而不是闷声跑");
});

test("A6 主进程 startTask 必须留痕「本次参与账号」，并对重复名字报警", () => {
  const src = stripComments(read("electron/app-context.js"));
  assert.match(src, /本次参与账号/, "主进程没有统一播报本次账号 —— 用户只能靠猜这次跑了哪几个号");
  assert.match(src, /envLabelsOf\(/, "取号要走 domain/account-topic 的 envLabelsOf，别再自己写一遍");
  assert.match(src, /账号名单里有重复名字/, "同名写两遍 = 那个号被执行两遍，必须当场点名");
});

test("A7 一键全自动也要交代账号是哪来的（无人值守，用户第二天只看结果）", () => {
  const src = stripComments(read("electron/src/workflows/auto-pipeline.js"));
  assert.match(src, /本次参与账号/);
  assert.match(src, /一键全自动页「本次参与的账号」/, "要区分「本页填的」和「回落到设置页的」，否则查不出多跑的那个号哪来的");
});
