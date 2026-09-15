"use strict";

/**
 * LLM Provider（v2.1-⑤）：OpenAI 兼容 /chat/completions 的最小供应商实现。
 *
 * 所有兼容供应商（硅基流动/DeepSeek/Kimi/通义/本地 Ollama 等）共用本实现，
 * 差异仅体现在 baseUrl/model/apiKey 三个配置项 —— 由 registry 提供预设。
 * LlmClient 通过 provider.chat() 发请求，业务层不接触 HTTP 细节。
 */

const DEFAULT_TIMEOUT_MS = 120000;

function createOpenAiCompatibleProvider({ baseUrl, apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error("当前环境无 fetch 实现");
  return {
    kind: "openai-compatible",
    baseUrl: String(baseUrl || "").trim(),
    apiKey: String(apiKey || "").trim(),
    model: String(model || "").trim(),
    async chat({ system, user, temperature, maxTokens, signal }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(this.baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature,
            max_tokens: maxTokens,
          }),
          signal: signal || controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const error = new Error(`AI API 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`);
          error.status = response.status;
          throw error;
        }
        const data = JSON.parse(text);
        const content = data?.choices?.[0]?.message?.content || "";
        return {
          content: String(content),
          usage: {
            promptTokens: data.usage?.prompt_tokens || 0,
            completionTokens: data.usage?.completion_tokens || 0,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 供应商预设：按 baseUrl 识别常见平台（换平台不改代码） */
const PRESETS = {
  "api.siliconflow.cn": { name: "硅基流动" },
  "api.deepseek.com": { name: "DeepSeek 官方" },
  "api.openai.com": { name: "OpenAI" },
  "dashscope.aliyuncs.com": { name: "通义千问" },
  "open.bigmodel.cn": { name: "智谱" },
  "localhost": { name: "本地服务/Ollama" },
  "127.0.0.1": { name: "本地服务/Ollama" },
};

function describeProvider(baseUrl) {
  const host = String(baseUrl || "").replace(/^https?:\/\//, "");
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (host.includes(key)) return preset.name;
  }
  return "自定义 OpenAI 兼容";
}

module.exports = { createOpenAiCompatibleProvider, describeProvider, PRESETS };
