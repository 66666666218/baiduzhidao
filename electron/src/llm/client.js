"use strict";

const { nowText } = require("../config");
const { createOpenAiCompatibleProvider, describeProvider } = require("./providers/openai-compatible");
const { createAnswerStrategy, buildChat, cleanAnswer, applyTemplate } = require("./strategies/answer");
// 429 有两种含义（速率限制 / 配额用尽），处理方式相反 —— 判据单开一个纯函数模块，
// 别混进重试逻辑里：这里扫文本读不出来，测试必须能真调它（见 round24 的 L5/L6）。
const { classifyRateLimit } = require("./rate-limit");

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR = /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|timeout|超时/i;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2000;

/**
 * 429（供应商限流）单独一套重试策略 —— 它是"慢一点"，**不是"这一题废了"**。
 *
 * 为什么值得单独写（第 24 轮）：并发数从 8 提到 64 之后，撞 429 会从"偶尔"
 * 变成"常态"（速率就那么多，并发高了必然限流）。如果还用普通策略
 * （3 次尝试、2s/4s 退避），大批题目会在第三次之后彻底失败，
 * 用户看到的现象是"**把并发调高了反而大面积失败**"，于是再也不敢调高 ——
 * 而这恰恰是他要的速度。
 *
 * 退避梯 2/4/8/15/30/45 秒，共 6 次：限流通常在几秒到一分钟内恢复，
 * 给足时间让它恢复，比早早就把题目判废更符合用户意图。
 * ⚠️ 重试期间**一直占着信号量名额**（release 在最外层 finally）——
 * 这是有意的：不占名额就等于"退避期间继续放新请求进去"，限流会永远不恢复。
 */
const RATE_LIMIT_STATUS = 429;
/**
 * 尝试次数 6 = 退避 5 档。⚠️ 梯子的长度必须正好 = 尝试次数 - 1：
 * 第 n 次失败后等第 n 档，第 6 次失败不再等（直接放弃），所以只会有 5 次等待。
 * （上一版给了 6 档，最后一档永远走不到 —— 守卫 `L4` 就是钉这条的。）
 */
const RATE_LIMIT_MAX_ATTEMPTS = 6;
const RATE_LIMIT_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];

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
    // 等待者不自增：名额一律由 admit() 同步交接。两边都计一次会让并发数悄悄翻倍，
    // 都不计（setConcurrency 直接 shift）则等于放开闸。
    await new Promise((resolve) => this.queue.push(resolve));
  }

  /** 按当前上限放行排队者；计数与交接同步完成，调用方不要再改 running */
  admit() {
    while (this.running < this.limit && this.queue.length) {
      const waiter = this.queue.shift();
      this.running += 1;
      waiter();
    }
  }

  release() {
    this.running -= 1;
    // 运行中调低上限后，running 可能暂时高于 limit：admit() 里的比较会把排队者继续挡住
    this.admit();
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
    // 退避等待也做成可注入的（与 fetchImpl 同一套路）：429 的退避梯最长 45 秒，
    // 不注入的话单测要么等几十秒、要么只能在测试里重抄一份梯子数字
    // —— 而"实现改了、测试照旧绿"正是这个项目反复吃亏的那一类。
    this.sleepImpl = typeof options.sleepImpl === "function"
      ? options.sleepImpl
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this.onUsage = typeof options.onUsage === "function" ? options.onUsage : null;
    this.semaphore = new Semaphore(options.concurrency || 1);
    // rateLimited = 撞 429 的次数（调并发数的依据）；quotaExhausted = 其中属于"配额用尽"的
    // （这种重试没用，必须早停）。quotaResetText 是供应商原文里的重置时刻，直接播报不重新推算。
    this.usage = {
      calls: 0, promptTokens: 0, completionTokens: 0, rateLimited: 0, quotaExhausted: false, quotaResetText: "",
    };
    // 配额用尽只喊一次：64 条并发会同时撞到，刷屏反而看不清重点
    this.quotaNoticeShown = false;
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
    if (patch.concurrency !== undefined) this.setConcurrency(patch.concurrency);
    if (patch.maxTokens !== undefined) this.maxTokens = Number(patch.maxTokens) || 520;
    if (patch.temperature !== undefined) this.temperature = Number.isFinite(Number(patch.temperature)) ? Number(patch.temperature) : 0.7;
    if (patch.systemPrompt !== undefined && String(patch.systemPrompt || "").trim()) this.strategy.systemPrompt = String(patch.systemPrompt);
    if (patch.titleTemplate !== undefined && String(patch.titleTemplate || "").trim()) this.strategy.titleTemplate = patch.titleTemplate;
    if (patch.introTemplate !== undefined && String(patch.introTemplate || "").trim()) this.strategy.introTemplate = patch.introTemplate;
  }

  ready() {
    return Boolean(this.apiKey && this.baseUrl && this.model);
  }

  /**
   * 并发热更新：始终复用同一个信号量。
   * 换实例会让旧实例队列里排队的 worker 永远等不到 resolve（任务卡死），
   * 而 release 打到新实例上又把 running 减成负数，并发闸就此失效。
   */
  setConcurrency(value) {
    const limit = Math.max(1, Number(value) || 1);
    const semaphore = this.semaphore;
    if (!semaphore || limit === semaphore.limit) return limit;
    semaphore.limit = limit;
    // 调高上限后把排队的 worker 放出来；计数由 admit() 负责，这里不能自己 shift
    semaphore.admit();
    return limit;
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
      // 先按普通错误的次数跑；真撞到 429 之后才在 catch 里把上限放宽到 6 次。
      // ⚠️ 循环边界**必须是这个变量**而不是常量 MAX_ATTEMPTS ——
      // 第一版就是改了 retryable 里的上限、忘了改这里的边界，结果 429 仍然只试 3 次，
      // 而单测因为"没断言实际次数"照样全绿（守卫 `L3` 就是钉这条的）。
      let maxAttempts = MAX_ATTEMPTS;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
          // 记账失败不能连累已经拿到手的答案：addUsage 会同步写盘，Windows 上偶发 EBUSY，
          // 若让它抛出来会被下面的 catch 当成"AI 请求失败"，整条回答被丢弃并重试烧一遍 token。
          if (this.onUsage) {
            try {
              this.onUsage(entry);
            } catch (usageError) {
              if (onLog) onLog(`token 记账失败（不影响本条回答）：${usageError.message}`);
            }
          }
          if (!content.trim()) throw new Error("AI API 没有返回可用回答。");
          return content;
        } catch (error) {
          lastError = normalizeError(error);
          const rateLimited = lastError.status === RATE_LIMIT_STATUS;
          if (rateLimited) {
            this.usage.rateLimited += 1;
            const verdict = classifyRateLimit(lastError.message);
            if (verdict.quotaExhausted) {
              // ⚠️ 这是「配额用尽」，不是「慢一点」—— 供应商自己说了要几小时后才重置，
              // 而我们整套退避梯加起来才约 60 秒，**等不到**。这时候重试不但救不回这一题，
              // 还会把后面所有题目一条条送进同一个 429（64 并发下 = 384 次注定失败的请求），
              // 并且把额度窗口拖得更久。所以：立刻停手，把"几点恢复"和"怎么立刻继续"说清楚。
              this.usage.quotaExhausted = true;
              if (verdict.resetText) this.usage.quotaResetText = verdict.resetText;
              if (onLog && !this.quotaNoticeShown) {
                this.quotaNoticeShown = true;
                onLog(quotaExhaustedLine(verdict.resetText));
              }
              break;
            }
            // 撞到 429 才放宽：把循环上限顶到 RATE_LIMIT_MAX_ATTEMPTS。
            maxAttempts = RATE_LIMIT_MAX_ATTEMPTS;
          }
          const retryable = attempt < maxAttempts
            && ((lastError.status && RETRYABLE_STATUS.has(lastError.status)) || RETRYABLE_ERROR.test(lastError.message));
          if (!retryable) break;
          // 429 用更长的退避梯，并且**加最多 1 秒抖动**：不加抖动的话，
          // 同批次几十个请求会在同一秒一起重试，制造出下一波同步的 429
          // —— 齐步走退避比不退避更糟。
          const waitMs = rateLimited
            ? RATE_LIMIT_DELAYS_MS[Math.min(attempt - 1, RATE_LIMIT_DELAYS_MS.length - 1)] + Math.floor(Math.random() * 1000)
            : BASE_DELAY_MS * attempt;
          if (onLog) {
            onLog(rateLimited
              ? `⏳ 供应商限流（HTTP 429），${Math.round(waitMs / 1000)} 秒后重试 ${attempt + 1}/${maxAttempts}`
                + "（这是速率限制，不是 Key 失效；把「并发数」调低一点会更快）"
              : `AI 请求失败，${waitMs / 1000} 秒后重试 ${attempt + 1}/${maxAttempts}：${lastError.message}`);
          }
          await this.sleepImpl(waitMs);
        }
      }
      throw lastError || new Error("AI 请求失败。");
    } finally {
      this.semaphore.release();
    }
  }
}

/**
 * 配额用尽时给用户的那一行。
 *
 * 两个信息缺一不可：①**几点恢复**（供应商原文里的重置时刻，直接抄过来，不重新推算）；
 * ②**怎么立刻继续**（换模型 / 换 Key —— 这也是供应商自己在那条报错里给的出口）。
 * 只说"失败了"会让人反复点重试，而重试在这里**永远**没用。
 *
 * @param {string} resetText 「2026-10-15 15:35:22 UTC+8」这种原样时刻，可能为空
 * @returns {string}
 */
function quotaExhaustedLine(resetText) {
  const when = resetText ? `${resetText} 之后才会恢复，` : "要等配额重置后才会恢复，";
  return `🛑 供应商配额已用尽（HTTP 429）：${when}现在重试没有意义，已停止本批生成。`
    + "想立刻继续：在设置页「AI 生成答案」里换一个模型（或换一个 API Key）。";
}

function normalizeError(error) {
  if (error && error.name === "AbortError") {
    const timeout = new Error("AI 请求超时，请稍后重试。");
    timeout.status = 408;
    return timeout;
  }
  return error instanceof Error ? error : new Error(String(error || "AI 请求失败。"));
}

module.exports = {
  LlmClient,
  Semaphore,
  applyTemplate,
  cleanAnswer,
  // 导出 429 的策略常量：测试要拿它算"两次 429 之后第三次该等多久"，
  // 在测试里重抄一份数字就会出现"实现改了、测试照旧绿"的假象。
  RATE_LIMIT_STATUS,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_DELAYS_MS,
};
