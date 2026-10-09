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
 * 本轮改造：请求走 `zhidao/http.js`（超时 + 退避重试 + 统一 UA），
 * 并且**区分"真没题"和"结构变了"** —— 以前接口改版会被当成空页，
 * 表现为"爬不到题"而不是报错，很难查。
 */

const http = require("./http");

const CATEGORY_API = "/qa/api/query/result/category";
const ACT_PAGE = `${http.HOST}/hd/21th_activity/`;

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
  if (Object.values(CATEGORY_CODE).includes(key)) return key;   // 允许直接传英文名
  return CATEGORY_CODE[`${key}类`] || "";                        // 容错："情感"
}

/**
 * 拉一页题目。
 * @returns {Promise<{ok:boolean, rows:Array, reason:string}>}
 *   rows: [{ qid, title, questionContent, l1, l2, questionUrl }]
 */
async function fetchQuestionPage({ cookie, category, base = 0, rn = 20, fetchImpl, timeoutMs = 15000, dispatcher }) {
  const code = codeOfCategory(category);
  if (!code) return { ok: false, rows: [], reason: `不认识的分类「${category}」（可用：情感类/教育类/综合类/人物类）` };

  const path = `${CATEGORY_API}?category=${encodeURIComponent(code)}&rn=${Math.max(1, Number(rn) || 20)}&base=${Math.max(0, Number(base) || 0)}`;
  const r = await http.requestJson(path, { cookie, referer: ACT_PAGE, dispatcher, timeoutMs, retries: 2, fetchImpl });
  if (!r.ok) return { ok: false, rows: [], reason: r.reason };

  const json = r.json || {};
  if (Number(json.code) !== 200) {
    const hint = Number(json.code) === 100004 ? "（分类名或参数不对）" : "";
    return { ok: false, rows: [], reason: `code=${json.code} ${json.msg || ""}${hint}` };
  }
  // **结构校验**：data.list 不是数组 = 接口改版。以前这里用 `|| []` 兜底，
  // 会把"改版"静默成"这页没题"，连续两页空就结束 —— 用户看到的是"爬不到题"，
  // 而不是"接口变了"，排查方向完全被带偏。
  const list = json.data && json.data.list;
  if (!Array.isArray(list)) {
    return { ok: false, rows: [], reason: "接口返回结构变了（data.list 不是数组）—— 百度可能改了接口，需要更新解析" };
  }
  const rows = list
    .filter((x) => x && x.qid)
    .map((x) => ({
      qid: String(x.qid),
      title: String(x.question || x.query || "").trim(),
      questionContent: String(x.question || "").trim(),
      l1: String(x.l1 || ""),
      l2: String(x.l2 || ""),
      questionUrl: `${http.HOST}/question/hx/${x.qid}.html`,
    }));
  return { ok: true, rows, reason: "" };
}

module.exports = { fetchQuestionPage, codeOfCategory, CATEGORY_CODE, CATEGORY_API };
