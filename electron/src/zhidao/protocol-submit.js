"use strict";

/**
 * 百度知道「提交回答」纯协议实现。
 *
 * ⚠️ 这一块的接口细节是从开源项目 junhaideng/baidu-zhidao 得到启发的 ——
 * 它点破了我卡住很久的那一步：**提交必须带 `X-ik-token`**。
 * 在此之前我做了 5 种组合（纯 HTTP / headless Edge / 有头 Edge / 各种 header）
 * 全部失败，还错误地归因到"指纹校验"。实际上是少了一个请求头。
 *
 * 实测（2026-10-09）：
 *   POST https://zhidao.baidu.com/msubmit/answer
 *   header: X-ik-token: <stoken>   ← 来自 /api/loginInfo 的 **stoken 字段**
 *                                     （注意：**不是** Cookie 里那个 STOKEN）
 *   body:   qid=<题目id>&from_source=hx&content=<URL编码的答案>
 *   → {"errno":0,"data":{"qid":"...","aid":5208513518}}   ✅
 *
 * 两个容易踩的坑（都实测过）：
 *  1. **Cookie 要用 zhidao 域那一份**。把全量 66 条（含 pan/passport 等跨域）
 *     拼在一起会因"同名不同域"互相覆盖，登录态直接没了（表现为 isLogin=0、
 *     提交 errno:3008）。参考实现的做法也是"从 F12 复制 zhidao 的 cookie"。
 *  2. **stoken 必须现取**，别缓存太久 —— 它是会话级的。
 */

const WB = "https://zhidao.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/**
 * 取提交用的 token（顺便确认登录态）。
 * @returns {Promise<{ok:boolean, token:string, userName:string, reason:string}>}
 */
async function fetchSubmitToken(cookie, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `${WB}/api/loginInfo?t=${Date.now()}`;
  try {
    const res = await fetchImpl(url, {
      headers: { Cookie: cookie, "User-Agent": UA, Referer: WB },
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, token: "", userName: "", reason: `loginInfo 非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` }; }
    if (Number(json.isLogin) !== 1) {
      return { ok: false, token: "", userName: "", reason: "Cookie 无效或已过期（isLogin≠1）——请到「网盘管理」重新粘贴" };
    }
    const token = String(json.stoken || "").trim();
    if (!token) return { ok: false, token: "", userName: json.userName || "", reason: "loginInfo 里没有 stoken 字段（接口可能变了）" };
    return { ok: true, token, userName: String(json.userName || ""), reason: "" };
  } catch (error) {
    return { ok: false, token: "", userName: "", reason: `取 token 失败：${error.message}` };
  }
}

/**
 * 提交一条回答。
 * @returns {Promise<{ok:boolean, aid:string, reason:string}>}
 */
async function submitAnswer({ qid, content, cookie, token, fetchImpl = fetch, timeoutMs = 20000 }) {
  if (!qid) return { ok: false, aid: "", reason: "缺少 qid" };
  if (!String(content || "").trim()) return { ok: false, aid: "", reason: "回答内容为空" };
  if (!token) return { ok: false, aid: "", reason: "缺少 X-ik-token" };

  const url = `${WB}/msubmit/answer`;
  const body = new URLSearchParams({ qid: String(qid), from_source: "hx", content: String(content) }).toString();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "User-Agent": UA,
        "X-ik-token": token,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: `${WB}/question/hx/${qid}?activity=21th&autoOpenAnswer=voice&qpi=21th_activity`,
        Origin: WB,
      },
      body,
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, aid: "", reason: `响应非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` }; }
    if (Number(json.errno) === 0) return { ok: true, aid: String((json.data && json.data.aid) || ""), reason: "" };
    // 常见错误码翻译成人话，别让用户对着数字猜
    const hint = {
      3008: "Cookie 不完整 —— 请粘贴 zhidao.baidu.com 域那一份（别用全量拼接）",
      4: "缺 X-ik-token 或已过期",
      5: "该题已回答过 / 提交被去重",
    }[Number(json.errno)] || "";
    return { ok: false, aid: "", reason: `errno=${json.errno}${hint ? "（" + hint + "）" : ""}` };
  } catch (error) {
    return { ok: false, aid: "", reason: `提交请求失败：${error.message}` };
  }
}

/** 从题库链接里取 qid */
function qidOf(url) {
  const m = String(url || "").match(/question\/(?:hx\/)?(\d+)/);
  return m ? m[1] : "";
}

module.exports = { fetchSubmitToken, submitAnswer, qidOf, WB, UA };
