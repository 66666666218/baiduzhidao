"use strict";

/**
 * 百度知道「提交回答」纯协议实现。
 *
 * ⚠️ 接口细节来自开源项目 junhaideng/baidu-zhidao —— 它点破了我卡很久的那一步：
 * **提交必须带 `X-ik-token`**。在此之前我试了 5 种组合（纯 HTTP / headless Edge /
 * 有头 Edge / 各种 header）全部失败，还错误地归因到"指纹校验"。实际是少一个请求头。
 *
 *   POST https://zhidao.baidu.com/msubmit/answer
 *   header: X-ik-token: <stoken>   ← 来自 /api/loginInfo 的 **stoken 字段**
 *   body:   qid=<题目id>&from_source=hx&content=<URL编码的答案>
 *   → {"errno":0,"data":{"qid":"...","aid":5208513518}}   ✅
 *
 * 本轮改造：请求统一走 `zhidao/http.js`（超时 + 退避重试 + 统一 UA），
 * 并加了**遇鉴权类错误自动刷新 token 重试一次** —— `stoken` 是会话级的，
 * 长批次跑到一半会失效，以前只能整条计失败。
 */

const http = require("./http");

const WB = http.HOST;

/** 提交接口的错误码 → 人话 + 下一步 */
function explainSubmitErrno(errno) {
  const n = Number(errno);
  if (n === 0) return "";
  const table = {
    3008: "Cookie 不完整 —— 请到「账号凭证」页重新「登录并提取」（务必用 zhidao 域那一份，别把多个域的 Cookie 拼在一起）",
    4: "提交令牌失效或缺失（X-ik-token）—— 已尝试自动刷新；若仍失败请重新登录",
    5: "该题已回答过，或提交被平台去重",
    "-1": "参数不合法（qid 或内容格式）",
  };
  return table[n] || `平台返回 errno=${n}（未收录的错误码，可截图反馈）`;
}

/** 取提交用的 token（附带确认登录态）。现在统一走 http 模块。 */
async function fetchSubmitToken(cookie, opts = {}) {
  return http.fetchLoginInfo(cookie, opts);
}

/**
 * 提交一条回答。
 * @param {object} o
 * @param {string} o.qid
 * @param {string} o.content
 * @param {string} o.cookie
 * @param {string} [o.token] 省略的话内部自己取（首次调用建议显式传，避免每条都查一次）
 * @param {Function} [o.onRefresh] token 失效并刷新成功时回调，便于调用方更新自己那份
 */
async function submitAnswer({ qid, content, cookie, token, fetchImpl, timeoutMs = 20000, dispatcher, onRefresh }) {
  if (!qid) return { ok: false, aid: "", reason: "缺少 qid" };
  if (!String(content || "").trim()) return { ok: false, aid: "", reason: "回答内容为空" };

  let tk = token;
  // 没给 token 就自己取一次（也顺带验证了登录态）
  if (!tk) {
    const got = await fetchSubmitToken(cookie, { fetchImpl, dispatcher });
    if (!got.ok) return { ok: false, aid: "", reason: got.reason };
    tk = got.token;
  }

  const body = new URLSearchParams({ qid: String(qid), from_source: "hx", content: String(content) }).toString();

  // 最多两次：第一次用传入的 token；若报鉴权类错误（4/3008），刷新 token 再试一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r = await http.requestJson("/msubmit/answer", {
      cookie,
      method: "POST",
      headers: {
        "X-ik-token": tk,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: `${WB}/question/hx/${qid}?activity=21th&autoOpenAnswer=voice&qpi=21th_activity`,
      },
      body,
      dispatcher,
      timeoutMs,
      retries: 1,                 // 网络层重试 1 次（业务错误不重试）
      fetchImpl,
    });
    if (!r.ok) return { ok: false, aid: "", reason: r.reason };
    const json = r.json || {};
    if (Number(json.errno) === 0) return { ok: true, aid: String((json.data && json.data.aid) || ""), reason: "" };

    const authFailed = Number(json.errno) === 4 || Number(json.errno) === 3008;
    if (authFailed && attempt === 0) {
      // token 过期是**预期内**的事（会话级），刷新一次再试，别让整条计失败
      const again = await fetchSubmitToken(cookie, { fetchImpl, dispatcher });
      if (again.ok) {
        tk = again.token;
        if (typeof onRefresh === "function") { try { onRefresh(tk); } catch { /* 忽略 */ } }
        continue;
      }
    }
    return { ok: false, aid: "", reason: explainSubmitErrno(json.errno) || `提交失败（errno=${json.errno}）` };
  }
  return { ok: false, aid: "", reason: "提交失败：令牌刷新后仍被拒绝" };
}

/** 从题目链接里取 qid */
function qidOf(url) {
  const m = String(url || "").match(/question\/(?:hx\/)?(\d+)/);
  return m ? m[1] : "";
}

module.exports = { fetchSubmitToken, submitAnswer, qidOf, explainSubmitErrno, WB, UA: http.UA };
