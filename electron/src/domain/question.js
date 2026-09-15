"use strict";

/**
 * 领域模型 v2.1-②：Question 生命周期。
 *
 * 设计原则：
 * - 现有 bank.json 记录格式不变（向后兼容），新字段以渐进方式叠加
 * - lifecycle 状态机驱动：DISCOVERED → READY → ANSWERING → ANSWERED
 *   → REVIEW_REQUIRED → APPROVED → SUBMITTING → SUBMITTED
 * - fingerprint = 去除参数后的 URL + 标题归一化哈希，用于跨参数去重
 * - 非法迁移抛错；查询类函数（canTransition/isTerminal）供 UI/任务使用
 */

const crypto = require("crypto");

const QUESTION_STATES = {
  DISCOVERED: "DISCOVERED",       // 爬到/导入，未校验
  READY: "READY",                 // 已入库待生成
  ANSWERING: "ANSWERING",         // AI 生成中
  ANSWERED: "ANSWERED",           // 已生成回答
  ANSWER_FAILED: "ANSWER_FAILED", // 生成失败（可重试）
  REVIEW_REQUIRED: "REVIEW_REQUIRED", // 质检未过，待人工
  APPROVED: "APPROVED",           // 人工/质检通过
  SUBMITTING: "SUBMITTING",       // 提交中
  SUBMITTED: "SUBMITTED",         // 已发布
  SUBMIT_FAILED: "SUBMIT_FAILED", // 提交失败
};

const ANSWER_STATES = {
  NONE: "NONE",
  GENERATING: "GENERATING",
  GENERATED: "GENERATED",
  FAILED: "FAILED",
};

const SUBMISSION_STATES = {
  NOT_SUBMITTED: "NOT_SUBMITTED",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  FAILED: "FAILED",
};

const QUESTION_TRANSITIONS = {
  DISCOVERED: ["READY"],
  READY: ["ANSWERING", "SUBMITTING"],
  ANSWERING: ["ANSWERED", "ANSWER_FAILED"],
  ANSWER_FAILED: ["ANSWERING", "READY"], // 重试
  ANSWERED: ["REVIEW_REQUIRED", "APPROVED", "SUBMITTING"],
  REVIEW_REQUIRED: ["APPROVED", "ANSWERING"], // 人工放行或重新生成
  APPROVED: ["SUBMITTING"],
  SUBMITTING: ["SUBMITTED", "SUBMIT_FAILED"],
  SUBMIT_FAILED: ["SUBMITTING", "REVIEW_REQUIRED"],
  SUBMITTED: [],
};

function canTransitionQuestion(from, to) {
  return (QUESTION_TRANSITIONS[from] || []).includes(to);
}

/** 归一化指纹：URL 取 pathname（剥离 ?activity=... 等参数）+ 标题去空白 */
function questionFingerprint({ questionUrl, title } = {}) {
  let path = "";
  try {
    path = new URL(String(questionUrl || "")).pathname.replace(/\/+$/, "");
  } catch {
    path = String(questionUrl || "").toLowerCase().replace(/\s+/g, "");
  }
  const normalizedTitle = String(title || "").replace(/\s+/g, "").toLowerCase();
  return crypto.createHash("sha256").update(`${path}|${normalizedTitle}`).digest("hex").slice(0, 24);
}

/**
 * 把旧版 bank/answers 记录升级为带生命周期的模型（纯函数，不改原对象）。
 * 兼容规则：
 * - 有 answer → ANSWERED；status 已提交 → SUBMITTED；质检未过 → REVIEW_REQUIRED
 * - 其余 → READY（DISCOVERED 仅在既无标题校验也无链接时）
 */
function toQuestionModel(record = {}) {
  const base = {
    id: record.id || `q_${questionFingerprint(record)}`,
    fingerprint: record.fingerprint || questionFingerprint(record),
    source: record.source || "baidu_zhidao",
    category: record.category || "",
    title: String(record.title || ""),
    questionContent: String(record.questionContent || ""),
    questionUrl: String(record.questionUrl || ""),
    bitEnv: record.bitEnv || "",
    status: record.status || "",
    createdAt: record.createdAt || "",
    crawl: {
      firstSeenAt: record.createdAt || "",
      lastSeenAt: record.lastSeenAt || record.createdAt || "",
      sourcePage: record.sourcePage || null,
    },
    answer: {
      state: ANSWER_STATES.NONE,
      content: String(record.answer || ""),
      model: record.model || "",
      quality: record.quality || "",
    },
    submission: {
      state: SUBMISSION_STATES.NOT_SUBMITTED,
      account: record.bitEnv || "",
      submittedAt: record.submittedAt || "",
      confirmed: Boolean(record.confirmed),
    },
    lifecycle: record.lifecycle || "",
  };

  // 生命周期推导（显式 lifecycle 优先，其次按记录字段推断）
  if (base.lifecycle && canTransitionQuestion(QUESTION_STATES.DISCOVERED, base.lifecycle) || isKnownState(base.lifecycle)) {
    base.lifecycle = base.lifecycle;
  } else if (base.submission.submittedAt) {
    base.lifecycle = QUESTION_STATES.SUBMITTED;
  } else if (String(record.status || "").includes("提交失败")) {
    base.lifecycle = QUESTION_STATES.SUBMIT_FAILED;
  } else if (base.answer.content) {
    base.lifecycle = base.answer.quality && !/通过/.test(base.answer.quality) && /过短|痕迹|复读/.test(base.answer.quality)
      ? QUESTION_STATES.REVIEW_REQUIRED
      : QUESTION_STATES.ANSWERED;
  } else {
    base.lifecycle = base.title || base.questionUrl ? QUESTION_STATES.READY : QUESTION_STATES.DISCOVERED;
  }

  base.answer.state = base.answer.content
    ? ANSWER_STATES.GENERATED
    : base.lifecycle === QUESTION_STATES.ANSWERING
      ? ANSWER_STATES.GENERATING
      : base.lifecycle === QUESTION_STATES.ANSWER_FAILED
        ? ANSWER_STATES.FAILED
        : ANSWER_STATES.NONE;
  base.submission.state = base.submission.submittedAt
    ? SUBMISSION_STATES.SUBMITTED
    : base.lifecycle === QUESTION_STATES.SUBMITTING
      ? SUBMISSION_STATES.SUBMITTING
      : base.lifecycle === QUESTION_STATES.SUBMIT_FAILED
        ? SUBMISSION_STATES.FAILED
        : SUBMISSION_STATES.NOT_SUBMITTED;

  return base;
}

function isKnownState(state) {
  return Object.values(QUESTION_STATES).includes(state);
}

/** 带校验的状态推进（返回新 lifecycle；非法迁移抛错） */
function advanceQuestionLifecycle(record, to) {
  const from = record.lifecycle || toQuestionModel(record).lifecycle;
  if (!canTransitionQuestion(from, to)) {
    throw new Error(`非法题目生命周期迁移：${from} → ${to}`);
  }
  return from;
}

module.exports = {
  QUESTION_STATES,
  ANSWER_STATES,
  SUBMISSION_STATES,
  QUESTION_TRANSITIONS,
  canTransitionQuestion,
  questionFingerprint,
  toQuestionModel,
  advanceQuestionLifecycle,
};
