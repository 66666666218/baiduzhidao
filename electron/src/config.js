"use strict";

const fs = require("fs");
const path = require("path");

const CATEGORIES = ["情感类", "教育类", "综合类", "人物类"];
const ALL_CATEGORY = "三类一起";

const DEFAULTS = {
  apiUrl: "http://127.0.0.1:54345",
  bitEnvs: [],
  activityUrl: "",
  timeoutMs: 30000,
  verifyWaitSeconds: 10,
  delayMin: 8,
  delayMax: 20,
  closeAfter: true,
  maxQuestions: 20,
  maxQuestionsPerEnv: 5,
  startPage: 1,
  crawlStartPage: 1,
  crawlOutputDir: "",
  pageDelayMs: 800,
  randomCount: 20,
  randomOutputPath: "",
  lastPickFilePath: "",
  aiBaseUrl: "https://api.siliconflow.cn/v1/chat/completions",
  aiApiKey: "",
  aiModel: "deepseek-ai/DeepSeek-V3",
  aiConcurrency: 2,
  aiMaxTokens: 520,
  aiTemperature: 0.7,
  aiDailyTokenBudget: 0,
  systemPrompt: "",
  titleTemplate: "A列标题：{{标题}}",
  introTemplate: "B列问题内容/简介：{{问题内容}}",
  autoSubmit: false,
  submitLimit: 0,
  accountDailyLimit: 10,
  dailyAnswerLimit: 0,
};

const SYSTEM_PROMPT = `请生成百度知道优质回答，只输出自然连贯的回答正文。
内容要贴合题目所属分类的语境（情感、教育、综合、人物等各不一样）：先直接给出核心观点，再结合普通人的真实处境展开分析，然后给出能落地执行的建议，最后适度共情。
规则：
不要输出段落标题、编号、项目符号、总结标签或"作为AI"等字样；
语气像热心网友分享经验，温和、克制、自然，不要生硬说教；
不要编造具体亲身经历，不要做医疗、法律、金融等专业结论；
回答尽量简洁，通常控制在120到260字。`;

function normalizeCategories(value) {
  const explicitArray = Array.isArray(value);
  const source = Array.isArray(value) ? value : String(value || "").split(/[,\s，、]+/);
  const selected = source.map((item) => String(item || "").trim()).filter(Boolean);
  if (!selected.length) return explicitArray ? [] : CATEGORIES.slice();
  if (selected.includes(ALL_CATEGORY) || selected.includes("all")) return CATEGORIES.slice();
  const filtered = CATEGORIES.filter((category) => selected.includes(category));
  return filtered.length ? filtered : explicitArray ? [] : CATEGORIES.slice();
}

function normalizeCategory(value) {
  const text = String(value || "").trim();
  return CATEGORIES.find((category) => text.includes(category)) || "";
}

function normalizeBitEnvs(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/[,\s，、\n]+/);
  const seen = new Set();
  const result = [];
  for (const item of list) {
    // 已归一化的 { label } 会被原样喂回来（load→save 往返、任务 payload 复用设置），
    // 直接 String() 会得到 "[object Object]" 并把它当环境名存进设置——环境名就此丢失。
    const raw = item && typeof item === "object" ? item.label ?? item.name ?? "" : item;
    const label = String(raw || "").trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push({ label });
  }
  return result;
}

function normalizeSettings(payload) {
  const next = { ...DEFAULTS, ...(payload || {}) };
  next.bitEnvs = normalizeBitEnvs(next.bitEnvs);
  next.timeoutMs = clampInt(next.timeoutMs, 5000, 120000, DEFAULTS.timeoutMs);
  next.verifyWaitSeconds = clampInt(next.verifyWaitSeconds, 0, 120, DEFAULTS.verifyWaitSeconds);
  next.delayMin = clampInt(next.delayMin, 0, 600, DEFAULTS.delayMin);
  next.delayMax = clampInt(next.delayMax, next.delayMin, 3600, Math.max(next.delayMin, DEFAULTS.delayMax));
  next.maxQuestions = clampInt(next.maxQuestions, 1, 100000, DEFAULTS.maxQuestions);
  next.maxQuestionsPerEnv = clampInt(next.maxQuestionsPerEnv, 1, 10000, DEFAULTS.maxQuestionsPerEnv);
  next.startPage = clampInt(next.startPage, 1, 100000, DEFAULTS.startPage);
  next.crawlStartPage = clampInt(next.crawlStartPage, 1, 100000, DEFAULTS.crawlStartPage);
  next.randomCount = clampInt(next.randomCount, 1, 100000, DEFAULTS.randomCount);
  next.aiConcurrency = clampInt(next.aiConcurrency, 1, 8, DEFAULTS.aiConcurrency);
  next.aiMaxTokens = clampInt(next.aiMaxTokens, 50, 4000, DEFAULTS.aiMaxTokens);
  next.aiTemperature = clampFloat(next.aiTemperature, 0, 2, DEFAULTS.aiTemperature);
  next.aiDailyTokenBudget = clampInt(next.aiDailyTokenBudget, 0, 100000000, DEFAULTS.aiDailyTokenBudget);
  next.submitLimit = clampInt(next.submitLimit, 0, 100000, DEFAULTS.submitLimit);
  next.accountDailyLimit = clampInt(next.accountDailyLimit, 0, 1000, DEFAULTS.accountDailyLimit);
  next.dailyAnswerLimit = clampInt(next.dailyAnswerLimit, 0, 100000, DEFAULTS.dailyAnswerLimit);
  next.pageDelayMs = clampInt(next.pageDelayMs, 0, 60000, DEFAULTS.pageDelayMs);
  next.autoSubmit = Boolean(next.autoSubmit);
  next.closeAfter = Boolean(next.closeAfter);
  if (!String(next.systemPrompt || "").trim()) next.systemPrompt = SYSTEM_PROMPT;
  // 活动页地址：允许覆盖但必须是合法 http(s) URL，否则回退默认（防止用户填错导致任务必败）
  const activityUrl = String(next.activityUrl || "").trim();
  if (activityUrl && !/^https?:\/\//i.test(activityUrl)) next.activityUrl = "";
  return next;
}

function clampInt(value, min, max, fallback) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function clampFloat(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

class Config {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "settings.json");
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8") || "{}");
      this.data = normalizeSettings(raw && typeof raw === "object" ? raw : {});
    } catch (error) {
      // 静默回退默认值 = 下一次保存把默认值写回文件，API Key / 路径就此丢失。
      // 先把坏文件留底，再尝试抢救完整部分，最后才回退默认。
      const backup = `${this.filePath}.损坏备份_${new Date().toISOString().replace(/[:.]/g, "")}`;
      try {
        fs.copyFileSync(this.filePath, backup);
        console.error(`settings.json 解析失败（${error.message}），原文件已留底：${backup}`);
      } catch {
        console.error("settings.json 解析失败，且无法留底坏文件，本次回退默认值。");
      }
      let salvaged = null;
      try {
        const text = fs.readFileSync(backup, "utf8");
        const candidate = text.slice(0, text.lastIndexOf("}") + 1);
        salvaged = candidate ? JSON.parse(candidate) : null;
      } catch {
        salvaged = null;
      }
      this.data = normalizeSettings(salvaged && typeof salvaged === "object" ? salvaged : {});
    }
    return this.data;
  }

  save(patch) {
    const previous = this.load();
    const next = normalizeSettings({ ...previous, ...(patch || {}) });
    // 空值不覆盖已保存的非空路径类配置
    for (const key of ["randomOutputPath", "crawlOutputDir", "lastPickFilePath"]) {
      if (!String(next[key] || "").trim() && String(previous[key] || "").trim()) {
        next[key] = previous[key];
      }
    }
    writeAtomic(this.filePath, next);
    this.data = next;
    return next;
  }

  resolveActivityUrl(fallbackUrl) {
    const data = this.load();
    const configured = String(data.activityUrl || "").trim();
    if (configured) return configured;
    return String(fallbackUrl || "").trim() || require("./pages/selectors").activityUrl;
  }
}

let tmpSeq = 1;

function writeAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 临时名必须每次唯一：两个进程共用 "${filePath}.tmp" 会互相写进同一个句柄，
  // rename 后就可能出现"整份 JSON + 尾部残留字节"的损坏文件（今天 usage.json 坏了 3 次）。
  const tmpPath = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* 临时文件可能已被 rename 掉 */
    }
    throw error;
  }
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

module.exports = {
  Config,
  DEFAULTS,
  SYSTEM_PROMPT,
  CATEGORIES,
  ALL_CATEGORY,
  normalizeCategories,
  normalizeCategory,
  normalizeBitEnvs,
  normalizeSettings,
  writeAtomic,
  nowText,
};
