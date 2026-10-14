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
 *
 * ── 第 18-C 轮（2026-10-14 17:55）的后续修正 ──
 * 用户那天贴的是 `net::ERR_CONNECTION_RESET`，**不是**代理错误码，所以"只在命中代理错误时
 * 才重试"这条规则让他一次就撞到墙上。现在不再按错误类型分支：**当前设置 → 临时直连，各试一次**，
 * 中间睡一会儿。判定少一处，就少一个"新错误码没被收录"的静默失效点。
 * A4/A5 已按新设计重写，A5-b 专门守"两次尝试之间真的等了"。
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

test("A4 ★ 失败后要自动换一种方式重试（now：两种方式各试一次）", () => {
  const src = stripComments(read("electron/app-context.js"));
  // ⚠️ 这一条在 2026-10-14（第 18-C 轮）改过：原来是"**只有**命中代理错误才直连重试"，
  // 而当天用户真实撞上的是 `net::ERR_CONNECTION_RESET`（不是代理错误码）→ 一次就放弃。
  // 现在不再按错误类型分支：**当前设置 → 临时直连**，两种方式各试一次。
  // 少一次判定 = 少一个"新错误码没被收录"的静默失效点。
  const start = src.indexOf("async function checkForUpdates(");
  assert.ok(start > 0, "找不到 checkForUpdates");
  const body = src.slice(start, src.indexOf("async function withProxyMode"));
  assert.match(body, /label:\s*"按当前网络设置"/, "第一次要按用户当前的网络设置试");
  assert.match(body, /label:\s*"临时直连"/, "第二次要换直连试");
  assert.match(body, /withProxyMode\(step\.mode/, "重试必须走 withProxyMode（切模式 + 保证还原）");
  assert.match(src, /setProxy\(\{\s*mode\s*\}\)/, "withProxyMode 里要真的切会话的代理模式");
});

test("A5 ★ 换模式重试后**必须还原**代理设置（否则之后爬题/提交/网盘全变直连）", () => {
  const src = stripComments(read("electron/app-context.js"));
  const start = src.indexOf("async function withProxyMode");
  assert.ok(start > 0, "找不到 withProxyMode");
  const body = src.slice(start, start + 1400);
  assert.match(body, /finally/, "还原必须放在 finally 里 —— 成功失败都要还原");
  assert.match(body, /setProxy\(\{\s*mode:\s*"system"\s*\}\)/, "要还原成系统代理，不是留成直连");
});

test("A5-b ★ 两次尝试之间要等一会儿，不能立刻连撞（瞬时故障需要时间自愈）", () => {
  const src = stripComments(read("electron/app-context.js"));
  assert.match(src, /UPDATE_RETRY_DELAY_MS\s*=\s*\d+/, "要有一个明确的等待时长常量");
  const body = src.slice(src.indexOf("async function checkForUpdates("), src.indexOf("async function withProxyMode"));
  assert.match(body, /sleep\(UPDATE_RETRY_DELAY_MS\)/, "换方式之前要 sleep 一下");
  // 等待时长要合理：太短等于没等，太长用户点一下要干等半分钟
  const ms = Number(src.match(/UPDATE_RETRY_DELAY_MS\s*=\s*(\d+)/)[1]);
  assert.ok(ms >= 500 && ms <= 5000, `等待 ${ms}ms 不合理（应在 0.5~5 秒之间）`);
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
