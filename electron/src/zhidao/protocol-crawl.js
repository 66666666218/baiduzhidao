"use strict";

/**
 * 百度知道「答题区题目列表」纯协议实现。
 *
 * ⚠️ 接口是从活动页的真实 XHR 里抓出来的（做法：开一次窗口、监听切分类时发出的请求）：
 *
 *   GET https://zhidao.baidu.com/qa/api/query/result/category
 *       ?category=<英文分类>&rn=<条数>&base=<偏移>
 *   → {"code":200,"data":{"list":[{"query":"...","question":"...","qid":3220904808,
 *        "l1":"生活和情感","l2":"情感问答","totalClick":2,"totalSearch":13,"pushTime":...}]}}
 *
 * **分类名必须是英文**，中文传进去只会得到 `code:100004 参数错误`：
 *   情感类=emotion  教育类=education  综合类=general  人物类=celebrity
 *   （人物类这个名字花了点功夫才试出来 —— 它返回的 l1 是"人物"，l2 是具体明星名）
 *
 * 至此「爬题」也不再需要开窗口：`/list` 是空壳 SPA、`/question/listajax` 是反爬页，
 * 真正的题目列表一直在活动页的 XHR 里。
 */

const WB = "https://zhidao.baidu.com";
const ACT_PAGE = `${WB}/hd/21th_activity/`;
const CATEGORY_API = "/qa/api/query/result/category";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/** 中文分类名 → 接口要的英文名。找不到返回空串（调用方好据此提示）。 */
const CATEGORY_CODE = {
  "情感类": "emotion",
  "教育类": "education",
  "综合类": "general",
  "人物类": "celebrity",
};

function codeOfCategory(label) {
  const key = String(label || "").trim();
  if (CATEGORY_CODE[key]) return CATEGORY_CODE[key];
  // 容错：允许直接传英文名
  if (Object.values(CATEGORY_CODE).includes(key)) return key;
  // 容错："情感" 这种省掉"类"的写法
  const withSuffix = `${key}类`;
  return CATEGORY_CODE[withSuffix] || "";
}

/**
 * 拉一页题目。
 * @returns {Promise<{ok:boolean, rows:Array, reason:string}>}
 *   rows: [{ qid, title, questionContent, l1, l2 }]
 */
async function fetchQuestionPage({ cookie, category, base = 0, rn = 20, fetchImpl = fetch, timeoutMs = 15000, dispatcher }) {
  const code = codeOfCategory(category);
  if (!code) return { ok: false, rows: [], reason: `不认识的分类「${category}」（可用：情感类/教育类/综合类/人物类）` };
  const url = `${WB}${CATEGORY_API}?category=${encodeURIComponent(code)}&rn=${Math.max(1, Number(rn) || 20)}&base=${Math.max(0, Number(base) || 0)}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        Cookie: String(cookie || ""),
        "User-Agent": UA,
        Referer: ACT_PAGE,
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      dispatcher,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, rows: [], reason: `响应非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` }; }
    if (Number(json.code) !== 200) {
      const hint = Number(json.code) === 100004 ? "（分类名或参数不对）" : "";
      return { ok: false, rows: [], reason: `code=${json.code} ${json.msg || ""}${hint}` };
    }
    const list = (json.data && json.data.list) || [];
    const rows = list
      .filter((x) => x && x.qid)
      .map((x) => ({
        qid: String(x.qid),
        title: String(x.question || x.query || "").trim(),
        questionContent: String(x.question || "").trim(),
        l1: String(x.l1 || ""),
        l2: String(x.l2 || ""),
        questionUrl: `${WB}/question/hx/${x.qid}.html`,
      }));
    return { ok: true, rows, reason: "" };
  } catch (error) {
    return { ok: false, rows: [], reason: `请求失败：${error.message}` };
  }
}

module.exports = { fetchQuestionPage, codeOfCategory, CATEGORY_CODE, CATEGORY_API };
