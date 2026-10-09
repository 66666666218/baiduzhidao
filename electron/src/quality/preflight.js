"use strict";

/**
 * 提交前体检（preflight）。
 *
 * 为什么要它：审核是**异步**的——提交之后要等平台几小时到一天才知道结果，
 * 而且结果只能看到「被拒 N 条」。等发现被拒，额度和账号已经搭进去了。
 * 这里把已经摸清楚的**确定性规则**前置到提交之前：能修的当场修，修不了的拦下来，
 * 不留到事后追查。
 *
 * 三档处置：
 *   fix   能自动修好（模板产生的问题：空括号 / 年份重复 / 残渣 / 空 img / 裸链接 / 标题超长）
 *   retry 值得重来一次（AI 生成的问题：过短 / AI 痕迹 / 不确定词）——本模块只标记，重生成由调用方做
 *   drop  救不了，别提交（标题为空 / 链接重复 / 反复不达标）
 *
 * 规则来源全部是**实测**（平台审核结果文件里逐条看出来的），不是拍脑袋：
 * 空 img 那组被拒 13.8%、裸链接 12.3% vs <a> 6.9%、标题重复年份、空括号…
 */

/** 平台对标题的硬要求：5~49 字 */
const TITLE_MIN = 5;
const TITLE_MAX = 49;

/** 模板可能产生的标题残渣（清理后会留下这些东西） */
const TITLE_JUNK = [
  /[（(]\s*[）)]/g,                       // 空括号（技术词/年份被摘掉后留下）
  /[《【]\s*(19\d{2}|20\d{2})\s*[》】]/g,   // 书名号年份（元数据）
  /\d+\s*[-~—]\s*\d+\s*(?:完整版|全)/g,     // 集数区间残渣：1-47完整版
  /[（(]\s*(19\d{2}|20\d{2})\s*[）)]/g,    // 括号年份
];

/** AI 痕迹 / 不确定词（与 quality/gate.js 口径一致） */
const AI_TRACE = /作为(一个)?AI|我是(一个)?AI|语言模型|人工智能助手/i;
const UNCERTAIN = /可能|也许|大概|似乎|应该是|或许是|不一定/g;

function cleanTitle(text) {
  let t = String(text || "");
  for (const re of TITLE_JUNK) t = t.replace(re, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

/** 把裸 URL 包成 <a href>（实测：裸链接被拒 12.3%，<a> 只有 6.9%） */
function wrapBareLinks(html) {
  const text = String(html || "");
  if (/<a\s+href=/i.test(text)) return { html: text, changed: false };
  const url = (text.match(/https?:\/\/[^\s<>"'，。；、）)】]+/) || [])[0];
  if (!url) return { html: text, changed: false };
  return { html: text.replace(url, `<a href="${url}">${url}</a>`), changed: true };
}

/** 去掉空的 <img src="">（实测：12 条被拒全在含它的组里） */
function stripEmptyImg(html) {
  const text = String(html || "");
  const next = text.replace(/<img[^>]*src\s*=\s*["']\s*["'][^>]*>/gi, "").replace(/\n{3,}/g, "\n\n");
  return { html: next, changed: next !== text };
}

/**
 * 体检一行。
 * @param {{title:string, answer:string, link?:string}} row
 * @param {{seenLinks?: Set<string>}} options
 * @returns {{action:"pass"|"fix"|"retry"|"drop", issues:string[], row:object}}
 *          row 是（可能已修好的）副本；action=drop 时调用方应剔除该行
 */
function inspectRow(row, options = {}) {
  const source = row || {};
  const issues = [];
  let action = "pass";
  const bump = (level) => {
    const order = { pass: 0, fix: 1, retry: 2, drop: 3 };
    if (order[level] > order[action]) action = level;
  };

  // ---------- 链接重复：救不了，直接剔 ----------
  const link = String(source.link || "").trim();
  if (link && options.seenLinks && options.seenLinks.has(link)) {
    return { action: "drop", issues: ["链接重复（本批已有一条）"], row: { ...source } };
  }
  if (link && options.seenLinks) options.seenLinks.add(link);

  // ---------- 标题 ----------
  let title = String(source.title || "").trim();
  if (!title) {
    return { action: "drop", issues: ["标题为空，平台必填"], row: { ...source } };
  }
  const cleaned = cleanTitle(title);
  if (cleaned !== title) {
    issues.push(`标题含模板残渣，已清理（${title.length}→${cleaned.length} 字）`);
    title = cleaned;
    bump("fix");
  }
  if (title.length > TITLE_MAX) {
    issues.push(`标题超长（${title.length} > ${TITLE_MAX}），已截断`);
    title = title.slice(0, TITLE_MAX).trim();
    bump("fix");
  }
  if (title.length < TITLE_MIN) {
    // 太短的标题靠截断救不回来——这是生成端的问题，让它重来
    issues.push(`标题过短（${title.length} < ${TITLE_MIN} 字）`);
    bump("retry");
  }

  // ---------- 回答正文 ----------
  let answer = String(source.answer || "");
  if (!answer.trim()) {
    return { action: "drop", issues: ["回答内容为空，平台必填"], row: { ...source } };
  }
  const noImg = stripEmptyImg(answer);
  if (noImg.changed) {
    issues.push("含空的 <img src=\"\">（无效元素），已移除");
    answer = noImg.html;
    bump("fix");
  }
  const wrapped = wrapBareLinks(answer);
  if (wrapped.changed) {
    issues.push("链接是裸文本，已包成 <a href>（可点击）");
    answer = wrapped.html;
    bump("fix");
  }
  if (AI_TRACE.test(answer)) {
    issues.push("含 AI 痕迹用语");
    bump("retry");
  }
  const uncertain = (answer.match(UNCERTAIN) || []).length;
  if (uncertain >= 5) {
    issues.push(`不确定词过多（${uncertain} 处）`);
    bump("retry");
  }
  if (answer.replace(/<[^>]+>/g, "").trim().length < 20) {
    issues.push("回答正文过短");
    bump("retry");
  }

  return { action, issues, row: { ...source, title, answer } };
}

/**
 * 批量体检。
 * @returns {{kept:Array, dropped:Array, fixed:number, retry:number, stats:object}}
 */
function inspectRows(rows, options = {}) {
  const seenLinks = options.seenLinks || new Set();
  const kept = [];
  const dropped = [];
  const reasonCount = new Map();
  let fixed = 0;
  let retry = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const verdict = inspectRow(row, { ...options, seenLinks });
    if (verdict.action === "fix") fixed += 1;
    if (verdict.action === "retry") retry += 1;
    if (verdict.action === "drop") {
      dropped.push({ ...verdict.row, issues: verdict.issues });
      for (const issue of verdict.issues) reasonCount.set(issue, (reasonCount.get(issue) || 0) + 1);
      continue;
    }
    kept.push(verdict.row);
  }
  return {
    kept,
    dropped,
    fixed,
    retry,
    stats: {
      total: Array.isArray(rows) ? rows.length : 0,
      kept: kept.length,
      dropped: dropped.length,
      fixed,
      retry,
      reasons: [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    },
  };
}

module.exports = {
  TITLE_MIN,
  TITLE_MAX,
  cleanTitle,
  wrapBareLinks,
  stripEmptyImg,
  inspectRow,
  inspectRows,
};
