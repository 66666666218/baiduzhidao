"use strict";

const { SYSTEM_PROMPT } = require("../config");
const { nowText } = require("../config");

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR = /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|timeout|超时/i;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2000;

/** 简单信号量：限制并发数 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit || 1);
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.limit) {
      this.running += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.running += 1;
  }

  release() {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

function defaultFetchImpl(url, options) {
  return fetch(url, options);
}

/**
 * OpenAI 兼容 chat/completions 客户端。
 * - baseURL/model/apiKey 全部可配置（硅基流动、DeepSeek、Kimi、通义等均可）
 * - 可重试错误自动退避重试
 * - 信号量限制并发
 * - 每次调用记录 token 用量（回调 onUsage）
 */
class LlmClient {
  constructor(options = {}) {
    this.setConfig(options);
    this.semaphore = new Semaphore(options.concurrency || 1);
    this.onUsage = typeof options.onUsage === "function" ? options.onUsage : null;
    this.fetchImpl = options.fetchImpl || defaultFetchImpl;
    this.usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  }

  setConfig(patch = {}) {
    // 只覆盖显式提供的字段，且忽略 undefined（避免运行中误清空配置）
    if (patch.baseUrl !== undefined) this.baseUrl = String(patch.baseUrl || "").trim() || "https://api.siliconflow.cn/v1/chat/completions";
    if (patch.apiKey !== undefined) this.apiKey = String(patch.apiKey || "").trim();
    if (patch.model !== undefined) this.model = String(patch.model || "").trim() || "deepseek-ai/DeepSeek-V3";
    if (patch.concurrency !== undefined) this.semaphore = new Semaphore(patch.concurrency || 1);
    if (patch.maxTokens !== undefined) this.maxTokens = Number(patch.maxTokens) || 520;
    if (patch.temperature !== undefined) this.temperature = Number.isFinite(Number(patch.temperature)) ? Number(patch.temperature) : 0.7;
    if (patch.systemPrompt !== undefined && String(patch.systemPrompt || "").trim()) this.systemPrompt = String(patch.systemPrompt);
  }

  ready() {
    return Boolean(this.apiKey && this.baseUrl && this.model);
  }

  buildQuestionText(item, { titleTemplate, introTemplate } = {}) {
    const titleBlock = applyTemplate(titleTemplate || "A列标题：{{标题}}", item);
    const introBlock = applyTemplate(introTemplate || "B列问题内容/简介：{{问题内容}}", item);
    return [titleBlock, introBlock].map((part) => part.trim()).filter(Boolean).join("\n\n");
  }

  async generateAnswer(item, { titleTemplate, introTemplate, onLog } = {}) {
    if (!this.ready()) throw new Error("请先填写 AI API Key。");
    const question = this.buildQuestionText(item, { titleTemplate, introTemplate });
    if (!question.trim()) throw new Error("缺少题目内容，无法生成回答。");
    const answer = await this.chat({
      system: this.systemPrompt || SYSTEM_PROMPT,
      user: `请结合 A 列标题和 B 列问题内容来回答下面这个百度知道情感类问题，只输出回答正文：\n\n${question}`,
      onLog,
    });
    return cleanAnswer(answer);
  }

  async chat({ system, user, onLog }) {
    await this.semaphore.acquire();
    try {
      let lastError = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          return await this.requestOnce(system, user);
        } catch (error) {
          lastError = normalizeError(error);
          const retryable = attempt < MAX_ATTEMPTS && (lastError.status && RETRYABLE_STATUS.has(lastError.status) || RETRYABLE_ERROR.test(lastError.message));
          if (!retryable) break;
          const waitMs = BASE_DELAY_MS * attempt;
          if (onLog) onLog(`AI 请求失败，${waitMs / 1000} 秒后重试 ${attempt + 1}/${MAX_ATTEMPTS}：${lastError.message}`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
      throw lastError || new Error("AI 请求失败。");
    } finally {
      this.semaphore.release();
    }
  }

  async requestOnce(system, user) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`AI API 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content || "";
      if (!String(content).trim()) throw new Error("AI API 没有返回可用回答。");
      const usage = data.usage || {};
      const entry = {
        model: this.model,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        at: nowText(),
      };
      this.usage.calls += 1;
      this.usage.promptTokens += entry.promptTokens;
      this.usage.completionTokens += entry.completionTokens;
      if (this.onUsage) this.onUsage(entry);
      return String(content);
    } finally {
      clearTimeout(timer);
    }
  }
}

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

function normalizeError(error) {
  if (error && error.name === "AbortError") {
    const timeout = new Error("AI 请求超时，请稍后重试。");
    timeout.status = 408;
    return timeout;
  }
  return error instanceof Error ? error : new Error(String(error || "AI 请求失败。"));
}

module.exports = { LlmClient, Semaphore, applyTemplate, cleanAnswer };
