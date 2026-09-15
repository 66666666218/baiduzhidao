"use strict";

const { nowText } = require("../config");
const { createOpenAiCompatibleProvider, describeProvider } = require("./providers/openai-compatible");
const { createAnswerStrategy, buildChat, cleanAnswer, applyTemplate } = require("./strategies/answer");

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR = /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|timeout|超时/i;
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
 * LLM 客户端（v2.1-⑤）：Provider + Strategy 分层。
 *
 * - 传输层委托 Provider（openai-compatible，可替换其它供应商实现）
 * - 提问方式委托 Strategy（answer 策略，模板/清洗可独立演进）
 * - 本层只保留：并发闸、重试退避、用量记账、配置热更新
 * - 公开 API 与 v2 保持一致（setConfig/ready/generateAnswer/chat），tasks 零改动
 */
class LlmClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || defaultFetchImpl;
    this.onUsage = typeof options.onUsage === "function" ? options.onUsage : null;
    this.semaphore = new Semaphore(options.concurrency || 1);
    this.usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
    this.strategy = createAnswerStrategy({
      systemPrompt: options.systemPrompt,
      titleTemplate: options.titleTemplate,
      introTemplate: options.introTemplate,
    });
    this.setConfig(options);
  }

  setConfig(patch = {}) {
    // 只覆盖显式提供的字段，且忽略 undefined（避免运行中误清空配置）
    if (patch.baseUrl !== undefined) this.baseUrl = String(patch.baseUrl || "").trim() || "https://api.siliconflow.cn/v1/chat/completions";
    if (patch.apiKey !== undefined) this.apiKey = String(patch.apiKey || "").trim();
    if (patch.model !== undefined) this.model = String(patch.model || "").trim() || "deepseek-ai/DeepSeek-V3";
    if (patch.concurrency !== undefined) this.semaphore = new Semaphore(patch.concurrency || 1);
    if (patch.maxTokens !== undefined) this.maxTokens = Number(patch.maxTokens) || 520;
    if (patch.temperature !== undefined) this.temperature = Number.isFinite(Number(patch.temperature)) ? Number(patch.temperature) : 0.7;
    if (patch.systemPrompt !== undefined && String(patch.systemPrompt || "").trim()) this.strategy.systemPrompt = String(patch.systemPrompt);
    if (patch.titleTemplate !== undefined && String(patch.titleTemplate || "").trim()) this.strategy.titleTemplate = patch.titleTemplate;
    if (patch.introTemplate !== undefined && String(patch.introTemplate || "").trim()) this.strategy.introTemplate = patch.introTemplate;
  }

  ready() {
    return Boolean(this.apiKey && this.baseUrl && this.model);
  }

  /** 供应商描述（UI 展示用："硅基流动"/"本地服务/Ollama"/"自定义 OpenAI 兼容"） */
  describe() {
    return describeProvider(this.baseUrl);
  }

  /** 惰性构造 Provider：配置热更新后按最新 baseUrl/apiKey/model 重建 */
  buildProvider() {
    return createOpenAiCompatibleProvider({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      fetchImpl: this.fetchImpl,
    });
  }

  buildQuestionText(item, { titleTemplate, introTemplate } = {}) {
    const { buildChat } = require("./strategies/answer");
    const strategy = createAnswerStrategy({ ...this.strategy, titleTemplate, introTemplate });
    return buildChat(strategy, item).user.split("\n\n").slice(1).join("\n\n");
  }

  async generateAnswer(item, { titleTemplate, introTemplate, onLog } = {}) {
    if (!this.ready()) throw new Error("请先填写 AI API Key。");
    const strategy = createAnswerStrategy({
      ...this.strategy,
      titleTemplate: titleTemplate || this.strategy.titleTemplate,
      introTemplate: introTemplate || this.strategy.introTemplate,
    });
    const { system, user } = buildChat(strategy, item);
    const answer = await this.chat({ system, user, onLog });
    return cleanAnswer(answer);
  }

  async chat({ system, user, onLog }) {
    await this.semaphore.acquire();
    try {
      let lastError = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const provider = this.buildProvider();
          const { content, usage } = await provider.chat({
            system,
            user,
            temperature: this.temperature,
            maxTokens: this.maxTokens,
          });
          // 先记账再校验内容：空响应的 token 同样真实消耗（重试只发生在 HTTP 错误层，无双重计数）
          const entry = {
            model: this.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            at: nowText(),
          };
          this.usage.calls += 1;
          this.usage.promptTokens += entry.promptTokens;
          this.usage.completionTokens += entry.completionTokens;
          if (this.onUsage) this.onUsage(entry);
          if (!content.trim()) throw new Error("AI API 没有返回可用回答。");
          return content;
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
