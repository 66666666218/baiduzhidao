"use strict";

/**
 * ★ 页面元素定义集中于此（v2 修复旧版 P2 问题）。
 * 百度知道页面改版时，只需修改本文件，再跑 tests/e2e 回归。
 * 操作代码（zhidao.js）只允许引用本文件导出的常量。
 */

const activityUrl = "https://zhidao.baidu.com/hd/21th_activity/";

const SEL = {
  // ---- 活动页：答题区 ----
  zone: {
    cards: ".answer-section__question",
    cardTitle: ".answer-section__question-title",
    goAnswerBtn: ".answer-section__btn",
    zoneTabText: "答题区",
  },

  // ---- 活动页：分类标签 ----
  category: {
    // 依次尝试精确文本匹配
    labels: ["情感类", "教育类", "综合类"],
  },

  // ---- 活动页：分页 ----
  pager: {
    activeNum: ".answer-section__pager-num.is-active",
    pageNum: ".answer-section__pager-num",
    jumpInput: ".answer-section__pager-jump-input",
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

  // ---- 活动页：当天通过数 ----
  passed: {
    itemRoot: "[class*='account'], [class*='env'], li",
    progressPattern: /(\d+)\s*\/\s*(\d+)/,
  },

  // ---- 百度风控页识别 ----
  verifyPattern: /百度安全验证|请完成下方验证|滑动完成拼图|验证码|安全验证|verify|captcha/i,
};

module.exports = { SEL, activityUrl };
