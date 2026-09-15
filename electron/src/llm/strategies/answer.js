"use strict";

/**
 * 回答策略（v2.1-⑤）：把"如何向 LLM 提问"从传输层（Provider）拆出。
 * 策略只负责：模板渲染 → 消息构造 → 结果清洗。可替换/可扩展
 * （rewrite、quality 等新策略按同一接口添加）。
 */

const { SYSTEM_PROMPT } = require("../../config");

const DEFAULT_TITLE_TEMPLATE = "A列标题：{{标题}}";
const DEFAULT_INTRO_TEMPLATE = "B列问题内容/简介：{{问题内容}}";

function createAnswerStrategy({ systemPrompt, titleTemplate, introTemplate } = {}) {
  const strategy = {
    kind: "answer",
    systemPrompt: String(systemPrompt || "").trim() || SYSTEM_PROMPT,
    titleTemplate: titleTemplate || DEFAULT_TITLE_TEMPLATE,
    introTemplate: introTemplate || DEFAULT_INTRO_TEMPLATE,
  };
  return strategy;
}

/** 占位符渲染：{{标题}} {{问题内容}} {{题目链接}} {{比特环境}} */
function applyTemplate(template, item) {
  const source = item || {};
  const replacements = {
    标题: String(source.title || ""),
    问题内容: String(source.questionContent || ""),
    简介: String(source.questionContent || ""),
    题目链接: String(source.questionUrl || ""),
    链接: String(source.questionUrl || ""),
    比特环境: String(source.bitEnv || ""),
    状态: String(source.status || ""),
  };
  return String(template || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key) => {
    const value = replacements[String(key).trim()];
    return value === undefined ? "" : value;
  });
}

/** 构造 chat 入参 */
function buildChat(strategy, item) {
  const titleBlock = applyTemplate(strategy.titleTemplate, item);
  const introBlock = applyTemplate(strategy.introTemplate, item);
  const question = [titleBlock, introBlock].map((part) => part.trim()).filter(Boolean).join("\n\n");
  if (!question.trim()) throw new Error("缺少题目内容，无法生成回答。");
  return {
    system: strategy.systemPrompt,
    user: `请结合 A 列标题和 B 列问题内容来回答下面这个百度知道情感类问题，只输出回答正文：\n\n${question}`,
  };
}

/** 回答清洗：去标题前缀/章节残留/多余空行，限长 */
function cleanAnswer(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^回答[:：]\s*/, "")
    .replace(/^草稿[:：]\s*/, "")
    .replace(/^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:结论|真实细节|问题本质|实操建议|观点升华|总结|分析|建议)\s*[:：、.-]?\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 1000)
    .trim();
}

module.exports = { createAnswerStrategy, applyTemplate, buildChat, cleanAnswer, DEFAULT_TITLE_TEMPLATE, DEFAULT_INTRO_TEMPLATE };
