"use strict";

/**
 * ★ 页面元素定义集中于此（v2 修复旧版 P2 问题）。
 * 2026-09-13 真实页面校准：活动页类名从下划线风格(answer-section__question)
 * 改为中划线风格(answer-section-question)，分类新增"人物类"，分页为 button.pager-num。
 * 以下选择器同时兼容新旧两种类名（逗号多选）。
 * 页面再次改版时只需修改本文件，再跑 tests/e2e 回归。
 */

const activityUrl = "https://zhidao.baidu.com/hd/21th_activity/";

const SEL = {
  // ---- 活动页：答题区题卡（新：中划线 / 旧：下划线） ----
  zone: {
    cards: ".answer-section-question, .answer-section__question",
    cardTitle: ".answer-section-question-title, .answer-section__question-title",
    goAnswerBtn: ".answer-section-btn, .answer-section__btn",
    zoneTabText: "答题区",
  },

  // ---- 活动页：分类标签（真实结构：button.answer-section-tab + 文本） ----
  category: {
    tabSelector: ".answer-section-tab",
    // 活动页当前真实分类（人物类为 2026-09 新增）
    labels: ["情感类", "教育类", "综合类", "人物类"],
  },

  // ---- 活动页：分页（真实结构：button.pager-num/.pager-next/.pager-jump-input） ----
  pager: {
    activeNum: ".pager-num.is-active, .answer-section__pager-num.is-active",
    pageNum: ".pager-num, .answer-section__pager-num",
    jumpInput: ".pager-jump-input, .answer-section__pager-jump-input",
    nextBtn: ".pager-next",
    prevBtn: ".pager-prev",
    nextTextPattern: /^(>|›|»|下一页)$/,
    nextClassPattern: /next|right|pager-next|pagination-next/i,
  },

  // ---- 题目详情页 ----
  question: {
    // 标题候选，按优先级
    titleCandidates: ["h1", ".question-title", ".title", "[class*='question'][class*='title']"],
    // 回答编辑器候选（富文本 div / textarea / iframe）
    editorCandidates: [
      ".ueditor textarea",
      ".edit-area textarea",
      ".question-answer textarea",
      "textarea[name='content']",
      "textarea[placeholder]",
      "[contenteditable='true']",
    ],
    // “回答”入口按钮（详情页先点开编辑器）
    answerButtonCandidates: [".answer-btn", ".wgt-answer .answer-button", "button:has-text('我来答')", "a:has-text('我来答')"],
    // 提交按钮
    submitCandidates: [
      ".answer-button:has-text('提交回答')",
      "button:has-text('提交回答')",
      "a:has-text('提交回答')",
      ".btn-submit",
    ],
  },

  // ---- 活动页：当天通过数（文本 "x/y"） ----
  passed: {
    progressPattern: /(\d+)\s*\/\s*(\d+)/,
  },

  // ---- 百度风控页识别 ----
  verifyPattern: /百度安全验证|请完成下方验证|滑动完成拼图|验证码|安全验证|verify|captcha/i,
};

module.exports = { SEL, activityUrl };
