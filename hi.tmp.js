"use strict";

/** 一次性修改（跑完即删）：upload-batch / passed-count 的协议函数改用公共 http 模块。 */

const fs = require("fs");
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);

function sub(file, oldLines, newLines, tag, mustReplace = true) {
  let s = fs.readFileSync(file, "utf8");
  const eol = s.indexOf(CRLF) >= 0 ? CRLF : LF;
  const oldS = oldLines.join(eol);
  const n = s.split(oldS).length - 1;
  if (n !== 1) { console.log(`✗ ${tag}：匹配 ${n} 次`); return mustReplace ? 1 : 0; }
  fs.writeFileSync(file, s.replace(oldS, newLines.join(eol)));
  console.log(`· ${tag} 已改`);
  return 0;
}

let bad = 0;

// ---------- passed-count：fetchProgressByProtocol 改用公共模块 ----------
bad += sub("electron/src/tasks/passed-count.js", [
'const WB = "https://zhidao.baidu.com";',
'const PROGRESS_API = "/qa/api/activity/anniversary21/answer-progress";',
], [
'const http = require("../zhidao/http");',
'const PROGRESS_API = "/qa/api/activity/anniversary21/answer-progress";',
'// 活动页地址：这个接口属于活动页，Referer 必须是它。',
'// 以前这里写的是 batch-upload 页 —— 语义错配；UA 更是裸 `Mozilla/5.0`（强机器人特征）。',
'const ACT_PAGE = `${http.HOST}/hd/21th_activity/`;',
], "passed-count 常量");

bad += sub("electron/src/tasks/passed-count.js", [
'async function fetchProgressByProtocol(cookie, { fetchImpl = fetch, timeoutMs = 12000, dispatcher } = {}) {',
'  try {',
'    const res = await fetchImpl(WB + PROGRESS_API, {',
'      headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0", Referer: `${WB}/b/batch/batch-upload`, "X-Requested-With": "XMLHttpRequest" },',
'      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,',
'      dispatcher,',
'    });',
'    const text = await res.text();',
'    const json = JSON.parse(text);',
'    if (Number(json.code) !== 200 || !json.data) return null;',
'    const done = Number(json.data.valid_answer_count) || 0;',
'    // 当前所处档位的门槛就是"分母"；没有档位信息时退化成 0（调用方按 unknown 处理）',
'    const total = Number((json.data.next_tier && json.data.next_tier.threshold) || 0) || 0;',
'    return { done, total };',
'  } catch {',
'    return null;',
'  }',
'}',
], [
'async function fetchProgressByProtocol(cookie, { fetchImpl, timeoutMs = 12000, dispatcher } = {}) {',
'  // 走公共底座：统一 UA / 超时 / 退避重试（以前一次网络抖动就静默返回 null，',
'  // 调用方只能"回落到窗口"——为读一个数字白开一份 Chromium）。',
'  const r = await http.requestJson(PROGRESS_API, { cookie, referer: ACT_PAGE, dispatcher, timeoutMs, retries: 2, fetchImpl });',
'  if (!r.ok) return { ok: false, reason: r.reason };',
'  const json = r.json || {};',
'  if (Number(json.code) !== 200 || !json.data) return { ok: false, reason: `code=${json.code} ${json.msg || ""}` };',
'  const done = Number(json.data.valid_answer_count) || 0;',
'  // 当前所处档位的门槛就是"分母"；没有档位信息时退化成 0（调用方按 unknown 处理）',
'  const total = Number((json.data.next_tier && json.data.next_tier.threshold) || 0) || 0;',
'  return { ok: true, done, total, reason: "" };',
'}',
], "passed-count fetchProgressByProtocol");

// 调用方：got 现在有 ok 字段
bad += sub("electron/src/tasks/passed-count.js", [
'        const got = await fetchProgressByProtocol(cookie, { dispatcher });',
'        if (got) {',
], [
'        const got = await fetchProgressByProtocol(cookie, { dispatcher });',
'        if (got.ok) {',
], "passed-count 调用方");

bad += sub("electron/src/tasks/passed-count.js", [
'        log(`${envLabel} 纯协议取数失败，回落到窗口`);',
], [
'        log(`${envLabel} 纯协议取数失败（${got.reason}），回落到窗口`);',
], "passed-count 失败原因");

// ---------- upload-batch：fetchIkToken → 公共 fetchLoginInfo ----------
bad += sub("electron/src/tasks/upload-batch.js", [
'const WB_HOST = "https://zhidao.baidu.com";',
'const UPLOAD_API = "/qa/api/bulkqa/upload";',
'const UA_PROTO = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";',
], [
'const http = require("../zhidao/http");',
'const WB_HOST = http.HOST;',
'const UPLOAD_API = "/qa/api/bulkqa/upload";',
'const UA_PROTO = http.UA;   // UA 只有一处定义（zhidao/http.js）',
], "upload-batch 常量");

bad += sub("electron/src/tasks/upload-batch.js", [
'async function fetchIkToken(cookie, { fetchImpl = fetch, timeoutMs = 12000, dispatcher } = {}) {',
'  try {',
'    const res = await fetchImpl(`${WB_HOST}/api/loginInfo?t=${Date.now()}`, {',
'      headers: { Cookie: cookie, "User-Agent": UA_PROTO, Referer: WB_HOST },',
'      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,',
'      dispatcher,',
'    });',
'    const json = JSON.parse(await res.text());',
'    if (Number(json.isLogin) !== 1) return { ok: false, token: "", reason: "Cookie 无效或已过期（isLogin≠1）——请到「账号凭证」重新粘贴" };',
'    const token = String(json.stoken || "").trim();',
'    if (!token) return { ok: false, token: "", reason: "loginInfo 里没有 stoken 字段（接口可能改版）" };',
'    return { ok: true, token, reason: "" };',
'  } catch (error) {',
'    return { ok: false, token: "", reason: `取 token 失败：${error.message}` };',
'  }',
'}',
], [
'async function fetchIkToken(cookie, opts = {}) {',
'  // 统一走公共底座（以前这里和 protocol-submit、app-context 各写了一份取 token）。',
'  return http.fetchLoginInfo(cookie, opts);',
'}',
], "upload-batch fetchIkToken");

if (bad) { console.log(`=== 有 ${bad} 处未命中，请看上面 ===`); process.exit(1); }
console.log("=== 全部完成 ===");
