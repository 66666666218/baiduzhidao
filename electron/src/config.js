"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeAccountTopics } = require("./domain/account-topic");
const { DEFAULT_TOPIC_RULES } = require("./domain/topic-rules");
const { DEFAULT_SEARCH_KEYWORDS } = require("./netdisk/search-crawler");

const CATEGORIES = ["情感类", "教育类", "综合类", "人物类"];
const ALL_CATEGORY = "三类一起";
/** 带链接答案的提交路由：strict=账号↔题材严格一对一；off=退回纯轮询（排查用） */
const LINK_ROUTING_MODES = ["strict", "off"];

const DEFAULTS = {
  apiUrl: "http://127.0.0.1:54345",
  bitEnvs: [],
  // 运行模式，三种，让用户自己选（不替他决定）：
  //   protocol —— 纯协议，不开任何浏览器；最快最省内存（上传一批 0 秒 vs 窗口 6 秒）。
  //               代价：所有账号共用本机 IP 与同一份网络指纹，建议配「账号代理」补 IP 隔离。
  //   bit      —— 走比特窗口，一环境一指纹，隔离最好；代价是内存（每个窗口几百 MB）。
  //   headless —— 用系统 Edge 跑无头，内存比比特小一个量级；但所有账号共用同一份 Edge 指纹。
  // 默认 protocol：既然整条链已经纯协议化了，默认就该用最省的；要隔离的用户会自己去选。
  browserMode: "protocol",
  // 每个账号的出口代理（文本，形如「账号=代理地址」一行一个）。
  // 纯协议模式下所有账号共享本机 IP —— 配了代理才是真正的 IP 隔离。
  // 留空全直连，行为与本功能引入前完全一致。
  accountProxies: "",
  // 账号并发数。**默认 1（串行）**：并发 = 同一时段多个账号做同样的事，
  // 正是平台风控最敏感的点。要调高的话，用户得自己保证隔离（每个账号开比特窗口，
  // 或每个账号挂一条代理）—— 界面上的提示就是这么写的。
  accountConcurrency: 1,
  // 网盘链的账号分工：转存与上传可以不是同一批号。
  // 现实里常见「A 的网盘还有空间但没有批量发布权益，B 有权益但网盘已经满了」——
  // 分开之后 A 负责把资源转进自己盘并建好永久分享，B 只管把问答表传上工作台
  //（分享链接是公开的，谁上传都行）。两边留空就回落到 bitEnvs。
  transferEnvs: [],
  uploadEnvs: [],
  activityUrl: "",
  timeoutMs: 30000,
  verifyWaitSeconds: 10,
  delayMin: 8,
  delayMax: 20,
  closeAfter: true,
  maxQuestions: 20,
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
  // 账号 ↔ 题材绑定：{ "环境A": "情感类" }，带链接的答案据此严格一对一投递
  accountTopics: {},
  linkRouting: "strict",
  // 提交时是否跳过「质检判为需复核」的答案。**默认 false**：不改变既有行为
  //（那些答案本来就是花钱生成的，直接丢掉会让用户以为软件少提交了）。
  // 但生成阶段判为 REVIEW 的结论会一路带到提交阶段，并在日志里报出条数 —— 用户知情后可以勾上。
  skipReviewAnswers: false,
  // 上传侧的关键词分类规则（「分类名=关键词1|关键词2」每行一条，顺序敏感）
  topicRules: DEFAULT_TOPIC_RULES,
  // 搜资源：各题材的搜索词（同格式）。没给资源表时按账号绑定的题材自动搜
  searchKeywords: DEFAULT_SEARCH_KEYWORDS,
  searchPages: 1,
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

/**
 * 账号题材绑定：只做通用归一化 + 一处便利补全。
 *
 * 刻意**不**把题材限制在 CATEGORIES 里：绑定表服务两条路径，题材命名空间不同——
 *   答题路径用「情感类/教育类/综合类/人物类」，上传路径用分类规则里的「游戏/影视/小说…」。
 * 早期版本在这里按 CATEGORIES 过滤，会把上传侧的题材全部当成"未知题材"丢光。
 * 题材是否真的存在，由各路径匹配不到时给用户报出来（见 account-topic / submit 的告警）。
 */
function normalizeAccountTopicsSetting(value) {
  const raw = normalizeAccountTopics(value);
  const result = {};
  for (const [account, topic] of Object.entries(raw)) {
    // 用户常写「情感」而不是「情感类」；只在这一种已知情形下补后缀，其余原样保留
    result[account] = normalizeCategory(topic) || normalizeCategory(`${topic}类`) || topic;
  }
  return result;
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
  const mode = String(next.browserMode || "").toLowerCase();
  next.browserMode = ["protocol", "bit", "headless"].includes(mode) ? mode : "protocol";
  next.accountProxies = String(next.accountProxies || "");
  next.accountConcurrency = clampInt(next.accountConcurrency, 1, 10, DEFAULTS.accountConcurrency);
  next.transferEnvs = normalizeBitEnvs(next.transferEnvs);
  next.uploadEnvs = normalizeBitEnvs(next.uploadEnvs);
  next.timeoutMs = clampInt(next.timeoutMs, 5000, 120000, DEFAULTS.timeoutMs);
  next.verifyWaitSeconds = clampInt(next.verifyWaitSeconds, 0, 120, DEFAULTS.verifyWaitSeconds);
  next.delayMin = clampInt(next.delayMin, 0, 600, DEFAULTS.delayMin);
  next.delayMax = clampInt(next.delayMax, next.delayMin, 3600, Math.max(next.delayMin, DEFAULTS.delayMax));
  // 下限必须是 0：「0 = 不限」是界面上写着的、也是 crawl.js 判定的口径（`maxQuestions > 0` 才算上限）。
  // 以前卡在 1，用户在「任务总量上限」里填 0 想要不限，实际变成"每个分类只爬 1 道题" ——
  // 而且**不报错、看不出来**，只有对着日志里那句"已达任务总量上限 1 道题"才发现。
  next.maxQuestions = clampInt(next.maxQuestions, 0, 100000, DEFAULTS.maxQuestions);
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
  next.accountTopics = normalizeAccountTopicsSetting(next.accountTopics);
  next.linkRouting = LINK_ROUTING_MODES.includes(next.linkRouting) ? next.linkRouting : DEFAULTS.linkRouting;
  next.skipReviewAnswers = next.skipReviewAnswers === true || next.skipReviewAnswers === "true";
  // 规则为空会让上传侧一行都分不出去，回退默认规则而不是静默全空
  if (!String(next.topicRules || "").trim()) next.topicRules = DEFAULT_TOPIC_RULES;
  if (!String(next.searchKeywords || "").trim()) next.searchKeywords = DEFAULT_SEARCH_KEYWORDS;
  next.searchPages = clampInt(next.searchPages, 1, 50, DEFAULTS.searchPages);
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
      // 文件**不存在**（首次运行 / 换了台新电脑）不算错误：静默用默认值就行。
      // 以前这里一律报「settings.json 解析失败，且无法留底坏文件」——
      // 新电脑第一次启动就会看到这句，让人以为装坏了（实测空目录下必现）。
      if (error && error.code === "ENOENT") {
        this.data = normalizeSettings({});
        return this.data;
      }
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
  LINK_ROUTING_MODES,
  normalizeCategories,
  normalizeCategory,
  normalizeAccountTopicsSetting,
  normalizeBitEnvs,
  normalizeSettings,
  writeAtomic,
  nowText,
};
