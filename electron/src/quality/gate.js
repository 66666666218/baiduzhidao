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
 * 决策规则：任一硬伤（空/过短/超长/AI 痕迹/敏感词/答非所问/照抄既有回答）→ REVIEW；
 * 软性问题（Markdown 残留/标题复读/相关性低/重复度）扣分，score < 60 → REVIEW。
 */

function buildQualityGate({ minLength = 50, maxLength = 500, reviewThreshold = 60 } = {}) {
  return {
    options: { minLength, maxLength, reviewThreshold },
    /** existingAnswers: 既有回答数组（重复度比对），可选 */
    evaluate(answer, { title, questionContent, existingAnswers } = {}) {
      const text = String(answer || "").trim();
      const length = evaluateLength(text, this.options);
      // 离谱长度先短路：对几十万~几百万字跑 bigram/相似度扫描没有意义，
      // 而且会独占事件循环几十秒，把整个任务的进度条卡死。
      if (text.length > this.options.maxLength * 20) {
        const reason = `超长（${text.length} 字，上限 ${this.options.maxLength}）`;
        return {
          decision: "REVIEW",
          score: 0,
          checks: { length, format: {}, risk: {}, titleEcho: false, relevance: 0, relevanceRecall: 0, duplicate: 0, skippedForLength: true },
          issues: [reason],
          reviewReason: reason,
        };
      }
      const format = evaluateFormat(text);
      const checks = {
        length,
        format,
        risk: { riskWords: format.riskWords },
        titleEcho: evaluateTitleEcho(text, title),
        relevance: evaluateRelevance(text, { title, questionContent }),
        relevanceRecall: evaluateQuestionRecall(text, { title, questionContent }),
        duplicate: evaluateDuplicate(text, existingAnswers),
      };
      const issues = [];
      let score = 100;

      // 答非所问：只在"字符覆盖"和"题面连续片段命中"两个信号同时极低时才拦。
      // 实测边界（22 条真实历史答案 + 手写对抗样本）：真回答相关性 0.33~0.86、
      // 题面命中 0.02~0.40；完全同领域但离题的建议文 0.071/0.023。
      // 换句话说这层启发抓得住"整段搬运别处文字"，抓不住泛泛而谈的模板话——
      // 阈值再放宽就会误伤真回答，所以刻意保守。
      const offTopic = checks.relevance < 0.2 && checks.relevanceRecall < 0.05 && text.length >= this.options.minLength;

      if (checks.length.tooShort) { issues.push(`过短（${text.length} 字）`); score -= 40; }
      // 超长不是"扣几分"能了结的：几十万字的搬运稿没有人工复核价值，也不该进提交链路
      if (checks.length.tooLong) { issues.push(`超长（${text.length} 字，上限 ${this.options.maxLength}）`); score -= 40; }
      if (checks.format.markdownResidue) { issues.push("含 Markdown/HTML 残留"); score -= 15; }
      if (checks.format.riskWords) { issues.push("含 AI 痕迹/敏感词"); score -= 45; }
      if (checks.format.uncertainWords) { issues.push(`不确定词 ${checks.format.uncertainCount} 处（规则红线：大量不确定词=无效回答）`); score -= 35; }
      if (checks.titleEcho) { issues.push("复读标题"); score -= 15; }
      // 相关性低与答非所问是同一根因的两级表现，命中后者就不再重复扣前者的分，
      // 否则分数会被推到 0 附近，质检列失去区分度（判 REVIEW 的结论两者本来就一致）
      if (checks.relevance < 0.2 && !offTopic) { issues.push(`与问题相关性低（${(checks.relevance * 100).toFixed(0)}%）`); score -= 20; }
      if (checks.duplicate >= 0.9) { issues.push("与既有回答高度重复"); score -= 30; }
      if (!text) { issues.push("空回答"); score = 0; }
      if (offTopic) { issues.push(`疑似答非所问（相关性 ${(checks.relevance * 100).toFixed(0)}%、题面片段命中 ${(checks.relevanceRecall * 100).toFixed(0)}%）`); score -= 40; }

      score = Math.max(0, Math.min(100, score));
      // 硬伤：空/过短/超长/风险词/不确定词密集/答非所问/整段照抄既有回答——任一命中直接 REVIEW
      const hardFail =
        !text ||
        checks.length.tooShort ||
        checks.length.tooLong ||
        checks.format.riskWords ||
        checks.format.uncertainWords ||
        offTopic ||
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
    // Markdown/HTML 残留：标题井号、粗体、代码块、标签，以及列表/引用/链接语法
    markdownResidue: /^#{1,6}\s|\n#{1,6}\s|\*\*|```|<\/?[a-z][a-z0-9]*>/i.test(text) ||
      /^\s*[-*+]\s+/m.test(text) || /^\s*\d+[.)]\s+/m.test(text) ||
      /^\s*>\s/m.test(text) || /\[[^\]\n]{1,80}\]\([^)\n]{1,200}\)/.test(text),
    riskWords: hasAiTrace(text) || /赌球|代开发票|办证|加微信|刷单/i.test(text),
    uncertainWords: countUncertainWords(text) >= 4,
    uncertainCount: countUncertainWords(text),
  };
}

/**
 * AI 自述/拒答话术。刻意写得窄：只抓"以第一人称自称模型"和"抱歉+无法"这类
 * 成对结构，不收 人工智能/机器人/数据 这类在正常回答里会作为话题词出现的单词，
 * 否则科普类答案会被整片误判成硬伤。
 */
function hasAiTrace(text) {
  // 后两条必须带第一人称主语：它们抓的是"模型自述受限"，不是"某事做不到"。
  // 不带主语时，"志愿填报无法获取最新计划""账目上没有数据可查"这类正常人话会整片被判成硬伤。
  return /作为\s*(?:一个)?\s*(?:AI|人工智能|大模型|语言模型|(?:AI|虚拟)\s*助手|聊天机器人)/i.test(text) ||
    /我\s*(?:只是|是)\s*(?:一个)?\s*(?:AI|人工智能|大模型|语言模型|聊天机器人|虚拟助手)/i.test(text) ||
    /(?:我|我们|本人)无法(?:直接)?(?:访问|获取|连接)(?:互联网|网络|实时|最新)/i.test(text) ||
    /我(?:并|也|还)?没有(?:实时|最新)?的?(?:数据|信息)(?:更新)?/i.test(text) ||
    /我的训练数据/i.test(text) ||
    /抱歉[，,、]?\s*我?(?:无法|不能|没法|暂时不能|暂未)/i.test(text) ||
    /我无法(?:直接|提供|给出|回答|确认|验证)/i.test(text);
}

function stripSpaces(text) {
  // 复读检测要把"标 题 拆 开 / 插符号"这类排版变体也算命中。
  // 用 Unicode 标点/符号类别而不是手挑几个：全角！？：；《》…【】原先不在集合里，
  // 在标题里插这些符号就能绕过复读检测。
  return String(text || "").replace(/[\p{P}\p{S}\s　]/gu, "");
}

/**
 * 相关性两个指标的分母都来自题面长度。题面越长，同一份切题答案的分数被系统性拉低
 * （实测：短题面 0.30/0.146，3000 字题面 0.214/0.068，已经贴近 0.2/0.05 的硬伤线），
 * 所以只在题面前部窗口上比对——标题在前，最具区分度的信息就在这一段。
 */
const QUESTION_SCOPE_CHARS = 200;

function questionScope({ title, questionContent }) {
  const question = stripSpaces((title || "") + (questionContent || ""));
  return question.slice(0, QUESTION_SCOPE_CHARS);
}

function evaluateTitleEcho(text, title) {
  const cleanTitle = stripSpaces(title);
  if (cleanTitle.length < 8) return false;
  return stripSpaces(text).includes(cleanTitle.slice(0, Math.min(cleanTitle.length, 12)));
}

/** 相关性启发：max(bigram 精度, 问题字符覆盖率)——转述类回答靠字符覆盖不误杀 */
function evaluateRelevance(text, { title, questionContent }) {
  const question = questionScope({ title, questionContent });
  const answer = stripSpaces(text);
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
  const charCoverage = questionCoverage(answer, question);
  return Math.max(bigramRate, charCoverage * 0.9);
}

/**
 * 题面二元组被回答命中的比例（召回率）。与字符覆盖率的差别是关键：
 * 把题面字符打乱重排、或答一段同领域但离题的文字，字符覆盖率仍然很高，
 * 而连续两字命中会掉到接近 0。
 */
function evaluateQuestionRecall(text, { title, questionContent }) {
  const question = questionScope({ title, questionContent });
  const answer = stripSpaces(text);
  if (question.length < 4) return 1;
  if (!answer) return 0;
  const answerBigrams = new Set();
  for (let i = 0; i < answer.length - 1; i += 1) answerBigrams.add(answer.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < question.length - 1; i += 1) {
    if (answerBigrams.has(question.slice(i, i + 2))) hit += 1;
  }
  return hit / Math.max(1, question.length - 1);
}

function questionCoverage(answer, question) {
  const qChars = new Set(question);
  let covered = 0;
  for (const ch of new Set(answer)) {
    if (qChars.has(ch)) covered += 1;
  }
  return qChars.size ? covered / qChars.size : 1;
}

// 规则红线：「大量'可能''通常'等不确定字段」= AI 痕迹 = 无效回答
// 「尽可能」是"尽量"的肯定式表达，不是犹豫，不能算进不确定词——建议文里它出现频率很高，
// 计入会虚增计数把正常回答推到 >=4 的硬伤线上。
function countUncertainWords(text) {
  const matches = String(text || "").match(/(?<!尽)可能|通常|一般来说|大概|或许|也许/g) || [];
  return matches.length;
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

module.exports = { buildQualityGate, evaluateLength, evaluateFormat, evaluateRelevance, evaluateQuestionRecall, evaluateDuplicate, similarity };
