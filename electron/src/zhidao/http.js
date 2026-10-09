"use strict";

/**
 * 百度知道侧**纯协议请求**的公共底座。
 *
 * 为什么要有它：同一个"带 Cookie 发请求 → 读文本 → parse JSON → 判 code"的骨架，
 * 此前在 `protocol-submit` / `protocol-crawl` / `upload-batch` / `passed-count`
 * 里各写了一遍，连 UA 都不统一（其中一处是裸 `Mozilla/5.0`，那是强机器人特征）。
 * 抽出来之后：UA / 超时 / 重试 / 代理 / 错误文案只有一处定义。
 *
 * **重试策略**（这是本轮的主要目的）：只对**临时性**失败重试 ——
 * 网络错误、超时、5xx、429。业务错误码（errno/code）一律不重试：
 * 那些是"平台明确告诉你不该这么干"，重试只会加重风控。
 */

const HOST = "https://zhidao.baidu.com";
// 有且只有这一份 UA。改这里，全链生效。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 判断是否值得重试：网络/超时/限流/服务端错误 → 值；业务错误 → 不值 */
function isTransient(error) {
  const msg = String((error && error.message) || error || "");
  if (/abort|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)) return true;
  const status = Number(error && error.status);
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * 发一个协议请求并解析 JSON。带超时与退避重试。
 *
 * @returns {Promise<{ok:boolean, status:number, json:any, text:string, reason:string, attempts:number}>}
 *   `ok` 只表示"拿到了可解析的 JSON"；**业务是否成功由调用方判 code/errno**。
 */
async function requestJson(pathname, {
  cookie = "",
  method = "GET",
  body,
  headers = {},
  dispatcher,
  referer,
  timeoutMs = 15000,
  retries = 2,
  fetchImpl = fetch,
} = {}) {
  const url = pathname.startsWith("http") ? pathname : `${HOST}${pathname}`;
  const finalHeaders = {
    Cookie: String(cookie || ""),
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    ...(referer ? { Referer: referer } : {}),
    ...headers,
  };
  const total = Math.max(0, Number(retries) || 0);
  let lastReason = "";
  for (let attempt = 0; attempt <= total; attempt += 1) {
    if (attempt > 0) await sleep(600 * attempt + Math.random() * 400);   // 退避，带抖动
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: finalHeaders,
        body,
        dispatcher,
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      lastReason = `网络错误：${error.message}`;
      if (attempt < total && isTransient(error)) continue;
      return { ok: false, status: 0, json: null, text: "", reason: lastReason, attempts: attempt + 1 };
    }
    const text = await res.text().catch(() => "");
    const status = Number(res.status) || 0;
    if (status === 429 || (status >= 500 && status < 600)) {
      lastReason = `服务端 ${status}（多为限流/抖动）`;
      if (attempt < total) continue;
      return { ok: false, status, json: null, text, reason: lastReason, attempts: attempt + 1 };
    }
    let json = null;
    try { json = JSON.parse(text); } catch {
      // 返回 HTML 通常是撞上了登录页/提示页 —— 不是瞬时问题，重试没意义
      return { ok: false, status, json: null, text, reason: `响应不是 JSON（HTTP ${status}，多为登录态失效或访问过于频繁）`, attempts: attempt + 1 };
    }
    return { ok: true, status, json, text, reason: "", attempts: attempt + 1 };
  }
  return { ok: false, status: 0, json: null, text: "", reason: lastReason || "未知", attempts: total + 1 };
}

/**
 * 取登录信息（含提交/上传要用的 `stoken`）。
 *
 * ⚠️ 两个曾经踩过的坑：
 *  1. **必须用 zhidao 域那一份 Cookie**。把全量跨域 Cookie 拼在一起会因"同名不同域"
 *     互相覆盖，登录态直接失效（表现为 isLogin=0）。
 *  2. **`stoken` 是会话级的**，长批次跑到一半可能失效 —— 所以调用方遇到鉴权类错误码时
 *     应该重新调一次本函数，而不是拿旧的接着用。
 */
async function fetchLoginInfo(cookie, opts = {}) {
  const r = await requestJson(`/api/loginInfo?t=${Date.now()}`, {
    cookie,
    referer: HOST,
    retries: (opts.retries === undefined ? 2 : opts.retries),
    ...opts,
  });
  if (!r.ok) return { ok: false, token: "", userName: "", reason: r.reason };
  const j = r.json || {};
  if (Number(j.isLogin) !== 1) {
    return { ok: false, token: "", userName: "", reason: "Cookie 无效或已过期（isLogin≠1）—— 请到「账号凭证」页重新「登录并提取」" };
  }
  const token = String(j.stoken || "").trim();
  if (!token) return { ok: false, token: "", userName: String(j.userName || ""), reason: "loginInfo 里没有 stoken 字段（接口可能改版）" };
  return { ok: true, token, userName: String(j.userName || ""), reason: "" };
}

/**
 * 把「账号凭证」里的凭据拼成 Cookie 串。
 * **只用 BDUSS + STOKEN 两条**（BDUSS 是百度全域 Cookie，网盘和知道通用）。
 */
function cookieOf(cred) {
  if (!cred || !cred.bduss) return "";
  const bduss = String(cred.bduss).trim();
  if (!bduss) return "";
  const stoken = String(cred.stoken || "").trim();
  return `BDUSS=${bduss}${stoken ? "; STOKEN=" + stoken : ""}`;
}

module.exports = { requestJson, fetchLoginInfo, cookieOf, isTransient, HOST, UA, sleep };
