"use strict";

/**
 * Quality Gate（v2.1-⑥）：AI 回答发布前的明确质量控制门。
 *
 * 检查项：长度 / 格式残留（Markdown 头、代码块）/ AI 痕迹词 / 标题复读 /
 * 与问题相关性（字符重叠度启发）/ 重复度（与既有回答比对）。
 *
 * 输出统一决策结构：
 *   { decision: "PASS" | "REVIEW", score: 0-100, checks: {...}, issues: [...] }
 *
 * 决策规则：任一硬伤（空/过短/AI 痕迹/敏感词）→ REVIEW；
 * 软性问题（偏长/相关性低）扣分，score < 60 → REVIEW。
 */

function buildQualityGate({ minLength = 50, maxLength = 500, reviewThreshold = 60 } = {}) {
  return {
    options: { minLength, maxLength, reviewThreshold },
    /** existingAnswers: 既有回答数组（重复度比对），可选 */
    evaluate(answer, { title, questionContent, existingAnswers } = {}) {
      const text = String(answer || "").trim();
      const checks = {
        length: evaluateLength(text, this.options),
        format: evaluateFormat(text),
        risk: { riskWords: evaluateFormat(text).riskWords },
        titleEcho: evaluateTitleEcho(text, title),
        relevance: evaluateRelevance(text, { title, questionContent }),
        duplicate: evaluateDuplicate(text, existingAnswers),
      };
      const issues = [];
      let score = 100;

      if (checks.length.tooShort) { issues.push(`过短（${text.length} 字）`); score -= 40; }
      if (checks.length.tooLong) { issues.push(`偏长（${text.length} 字）`); score -= 10; }
      if (checks.format.markdownResidue) { issues.push("含 Markdown/HTML 残留"); score -= 15; }
      if (checks.format.riskWords) { issues.push("含 AI 痕迹/敏感词"); score -= 45; }
      if (checks.format.uncertainWords) { issues.push(`不确定词 ${checks.format.uncertainCount} 处（规则红线：大量不确定词=无效回答）`); score -= 35; }
      if (checks.titleEcho) { issues.push("复读标题"); score -= 15; }
      if (checks.relevance < 0.15) { issues.push(`与问题相关性低（${(checks.relevance * 100).toFixed(0)}%）`); score -= 20; }
      if (checks.duplicate >= 0.9) { issues.push("与既有回答高度重复"); score -= 30; }
      if (!text) { issues.push("空回答"); score = 0; }

      score = Math.max(0, Math.min(100, score));
      // 硬伤：空/过短/风险词/不确定词密集/整段搬运（非原创）——任一命中直接 REVIEW
      const hardFail =
        !text ||
        text.length < this.options.minLength ||
        checks.format.riskWords ||
        checks.format.uncertainWords ||
        checks.duplicate >= 0.9;
      const decision = hardFail || score < this.options.reviewThreshold ? "REVIEW" : "PASS";

      return {
        decision,
        score,
        checks,
        issues,
        reviewReason: issues.join("；"),
      };
    },
  };
}

function evaluateLength(text, { minLength, maxLength }) {
  return { tooShort: text.length < minLength, tooLong: text.length > maxLength };
}

function evaluateFormat(text) {
  return {
    markdownResidue: /^#{1,6}\s|\n#{1,6}\s|\*\*|```|<\/?[a-z][a-z0-9]*>/i.test(text),
    riskWords: /作为AI|作为一个AI|AI助手|语言模型|无法访问互联网|训练数据/i.test(text) ||
      /赌球|代开发票|办证|加微信|刷单/i.test(text),
    uncertainWords: countUncertainWords(text) >= 4,
    uncertainCount: countUncertainWords(text),
  };
}

// 规则红线：「大量'可能''通常'等不确定字段」= AI 痕迹 = 无效回答
function countUncertainWords(text) {
  const matches = String(text || "").match(/可能|通常|一般来说|大概|或许|也许/g) || [];
  return matches.length;
}

function evaluateTitleEcho(text, title) {
  const cleanTitle = String(title || "").replace(/\s+/g, "");
  if (cleanTitle.length < 8) return false;
  return String(text).replace(/\s+/g, "").includes(cleanTitle.slice(0, Math.min(cleanTitle.length, 12)));
}

/** 相关性启发：max(bigram 重叠率, 问题字符覆盖率)——转述类回答靠字符覆盖不误杀 */
function evaluateRelevance(text, { title, questionContent }) {
  const question = String((title || "") + (questionContent || "")).replace(/\s+/g, "");
  const answer = String(text || "").replace(/\s+/g, "");
  if (question.length < 4) return 1;
  if (!answer) return 0;
  // 1) bigram 重叠率
  const bigrams = new Set();
  for (let i = 0; i < question.length - 1; i += 1) bigrams.add(question.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < answer.length - 1; i += 1) {
    if (bigrams.has(answer.slice(i, i + 2))) hit += 1;
  }
  const bigramRate = Math.min(1, hit / Math.max(4, answer.length - 1));
  // 2) 问题字符覆盖率（集合交集/问题字符集合）
  const qChars = new Set(question);
  let covered = 0;
  for (const ch of new Set(answer)) {
    if (qChars.has(ch)) covered += 1;
  }
  const charCoverage = qChars.size ? covered / qChars.size : 1;
  return Math.max(bigramRate, charCoverage * 0.9);
}

function evaluateDuplicate(text, existingAnswers) {
  if (!Array.isArray(existingAnswers) || !existingAnswers.length) return 0;
  let max = 0;
  const target = text.replace(/\s+/g, "");
  for (const existing of existingAnswers) {
    const other = String(existing || "").replace(/\s+/g, "");
    if (!other) continue;
    const overlap = similarity(target, other);
    max = Math.max(max, overlap);
  }
  return max;
}

/** 粗粒度相似度：公共字符比例（无分词依赖） */
function similarity(a, b) {
  if (!a || !b) return 0;
  const setB = new Map();
  for (const ch of b) setB.set(ch, (setB.get(ch) || 0) + 1);
  let common = 0;
  for (const ch of a) {
    const count = setB.get(ch) || 0;
    if (count > 0) {
      common += 1;
      setB.set(ch, count - 1);
    }
  }
  return common / Math.max(a.length, b.length);
}

module.exports = { buildQualityGate, evaluateLength, evaluateFormat, evaluateRelevance, evaluateDuplicate, similarity };
