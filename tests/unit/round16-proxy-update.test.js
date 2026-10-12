"use strict";

/**
 * 第 16 轮 D：「检查更新 → 更新失败：可能是网络问题（更新服务器连不上）」
 * 真实错误是 `net::ERR_PROXY_CONNECTION_FAILED`。
 *
 * 两个毛病，都要修：
 *   1. **文案把人引错方向**：把"代理连不上"归到"网络问题"里，用户只会反复重连网络，
 *      而真正要动的是"代理"那一项（或让软件自己绕开代理）。
 *   2. **不会自救**：electron 的网络栈走系统代理，代理连不上就整条更新链路失败 ——
 *      而 git/curl 走同一个代理却能通，说明"绕开代理"多半就能成。
 *
 * 修法：命中代理错误 → 临时把默认会话切成直连重试一次 → **必须还原**。
 * ⚠️ 还原是硬要求：setProxy 改的是整个默认会话，不还原的话之后爬题/提交/网盘全变直连，
 * 而用户配代理恰恰是为了不走直连（出口 IP 会被关联）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { describeUpdateError, isProxyError, scrubUrl } = require("../../electron/src/errors");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function stripComments(src) {
  // 先剥行注释再剥块注释：被扫文件里若有行注释含块注释起始符，反过来会吞掉大段真实代码
  return src.replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

test("A1 isProxyError：认得真实见过的代理错误码", () => {
  assert.equal(isProxyError("Error: net::ERR_PROXY_CONNECTION_FAILED"), true);
  assert.equal(isProxyError("net::ERR_TUNNEL_CONNECTION_FAILED"), true);
  assert.equal(isProxyError("ERR_NO_SUPPORTED_PROXIES"), true);
});

test("A2 isProxyError：不把普通网络错误误判成代理问题", () => {
  // 误判的代价：白白多试一次，还把"真的连不上服务器"说成"代理有问题"，把人引错方向
  assert.equal(isProxyError("HttpError: 404 Not Found"), false);
  assert.equal(isProxyError("ETIMEDOUT"), false);
  assert.equal(isProxyError("getaddrinfo ENOTFOUND"), false);
  assert.equal(isProxyError(""), false);
});

test("A3 ★ describeUpdateError 必须把「代理连不上」和「网络问题」分开说", () => {
  const proxyText = describeUpdateError("Error: net::ERR_PROXY_CONNECTION_FAILED");
  assert.match(proxyText, /代理/, "代理错误却报成「网络问题」，用户只会反复重连网络");
  assert.doesNotMatch(proxyText, /^(?!.*代理)可能是网络问题/, "不该再笼统说成网络问题");
  // 普通网络错误仍然归到"网络问题"
  assert.match(describeUpdateError("ETIMEDOUT"), /网络/);
  // 404 仍然是"没发布过"
  assert.match(describeUpdateError("HttpError: 404"), /没有发布/);
});

test("A4 ★ 命中代理错误要自动绕开代理重试", () => {
  const src = stripComments(read("electron/app-context.js"));
  assert.match(src, /isProxyError\(error\)/, "checkForUpdates 里要判定代理错误");
  assert.match(src, /checkForUpdatesDirect/, "要有「绕开代理重试」的实现");
  assert.match(src, /setProxy\(\{\s*mode:\s*"direct"\s*\}\)/, "重试时要真的把会话切成直连");
});

test("A5 ★ 直连重试后**必须还原**代理设置（否则之后爬题/提交/网盘全变直连）", () => {
  const src = stripComments(read("electron/app-context.js"));
  const start = src.indexOf("async function checkForUpdatesDirect");
  assert.ok(start > 0, "找不到 checkForUpdatesDirect");
  const body = src.slice(start, start + 1600);
  assert.match(body, /finally/, "还原必须放在 finally 里 —— 成功失败都要还原");
  assert.match(body, /setProxy\(\{\s*mode:\s*"system"\s*\}\)/, "要还原成系统代理，不是留成直连");
});

test("A6 界面不能再显示 net:: 这种原始串（要显示人话）", () => {
  const src = stripComments(read("electron/app-context.js"));
  assert.match(src, /describeUpdateError\(e\)\}（详细原因见运行日志）/, "update:check 要抛一句人话而不是原始报错");
});

test("A7 代理相关的文案仍然不能泄露仓库地址（用户明确要求）", () => {
  const text = describeUpdateError("Error: net::ERR_PROXY_CONNECTION_FAILED");
  assert.equal(scrubUrl(text).includes("github"), false);
  const src = stripComments(read("electron/src/errors.js"));
  // errors.js 里只允许在 scrubUrl 的抹除匹配式出现仓库坐标，别的地方不许
  const body = src.replace(/function scrubUrl[\s\S]*?\n}/, "");
  assert.doesNotMatch(body, /github\.com/i);
});
