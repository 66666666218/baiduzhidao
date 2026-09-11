"use strict";

const fs = require("fs");
const path = require("path");
const { writeAtomic, nowText } = require("../config");

function questionKeys(item) {
  const url = String((item && item.questionUrl) || "").trim().toLowerCase();
  const title = String((item && item.title) || "").replace(/\s+/g, "").toLowerCase();
  const content = String((item && item.questionContent) || "").replace(/\s+/g, "").toLowerCase();
  return [url ? `url:${url}` : "", title ? `title:${title}` : "", content ? `content:${content}` : ""].filter(Boolean);
}

function recordKey(item) {
  const url = String((item && item.questionUrl) || "").trim();
  if (url) return `url:${url.toLowerCase()}`;
  const title = String((item && item.title) || "").replace(/\s+/g, "").toLowerCase();
  const content = String((item && item.questionContent) || "").replace(/\s+/g, "").toLowerCase();
  return `text:${title}:${content}`;
}

function normalizeQuestion(item) {
  const source = item || {};
  return {
    category: String(source.category || source["题库分类"] || "").trim(),
    title: String(source.title || source["标题"] || "").replace(/\r\n/g, "\n").trim(),
    questionContent: String(source.questionContent || source["问题内容"] || "").replace(/\r\n/g, "\n").trim(),
    answer: String(source.answer || "").replace(/\r\n/g, "\n"),
    questionUrl: String(source.questionUrl || source["题目地址"] || source["去答题链接"] || "").trim(),
    bitEnv: String(source.bitEnv || source["比特环境"] || "").trim(),
    status: String(source.status || "已爬取").trim(),
    createdAt: String(source.createdAt || nowText()).trim(),
    submittedAt: String(source.submittedAt || "").trim(),
    confirmed: Boolean(source.confirmed),
    quality: String(source.quality || "").trim(),
  };
}

/**
 * 单源 JSON 存储：内存 Map 索引 + 防抖原子写。
 * 文件只保留一份事实（bank/answers/progress/usedKeys），XLSX/TXT 仅在导出时生成。
 */
class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.files = {
      bank: path.join(dataDir, "bank.json"),
      answers: path.join(dataDir, "answers.json"),
      progress: path.join(dataDir, "progress.json"),
      usage: path.join(dataDir, "usage.json"),
    };
    this.bank = null;           // 数组（保持插入顺序）
    this.bankIndex = new Map(); // key -> index in bank
    this.answers = null;
    this.answersByKey = new Map(); // key -> item（O(1) 定位，避免 unshift 全量重排）
    this.saveTimers = new Map();
  }

  // ---------- 题库 ----------

  loadBank() {
    if (this.bank) return this.bank;
    this.bank = this.readArray(this.files.bank).map(normalizeQuestion)
      .filter((item) => item.title || item.questionUrl);
    this.bankIndex = new Map();
    this.bank.forEach((item, index) => {
      for (const key of questionKeys(item)) {
        if (!this.bankIndex.has(key)) this.bankIndex.set(key, index);
      }
    });
    return this.bank;
  }

  /** 新增或补充元数据；返回 "added" | "updated" | "exists" */
  addBankQuestion(item) {
    const bank = this.loadBank();
    const normalized = normalizeQuestion(item);
    if (!normalized.title && !normalized.questionUrl) return "exists";
    const keys = questionKeys(normalized);
    const hitIndex = keys.map((key) => this.bankIndex.get(key)).find((index) => Number.isInteger(index));
    if (Number.isInteger(hitIndex)) {
      const existing = bank[hitIndex];
      let changed = false;
      for (const field of ["category", "title", "questionContent", "questionUrl"]) {
        if (!existing[field] && normalized[field]) {
          existing[field] = normalized[field];
          changed = true;
        }
      }
      if (changed) this.scheduleSave("bank");
      return changed ? "updated" : "exists";
    }
    bank.push(normalized);
    const newIndex = bank.length - 1;
    for (const key of keys) this.bankIndex.set(key, newIndex);
    this.scheduleSave("bank");
    return "added";
  }

  bankSize() {
    return this.loadBank().length;
  }

  /** 题库检索：关键字（标题/内容/链接）+ 分类 + 分页 */
  searchBank({ keyword = "", category = "", page = 1, pageSize = 50 } = {}) {
    const bank = this.loadBank();
    const kw = String(keyword || "").trim().toLowerCase();
    const cat = String(category || "").trim();
    const rows = bank.filter((item) => {
      if (cat && item.category !== cat) return false;
      if (!kw) return true;
      return (
        item.title.toLowerCase().includes(kw) ||
        item.questionContent.toLowerCase().includes(kw) ||
        item.questionUrl.toLowerCase().includes(kw)
      );
    });
    const total = rows.length;
    const start = (Math.max(1, page) - 1) * pageSize;
    return { rows: rows.slice(start, start + pageSize), total, page: Math.max(1, page), pageSize };
  }

  /** 答案检索：关键字（标题/内容/链接/回答）+ 分页 */
  searchAnswers({ keyword = "", page = 1, pageSize = 50 } = {}) {
    const answers = this.loadAnswers();
    const kw = String(keyword || "").trim().toLowerCase();
    const rows = answers.filter((item) => {
      if (!kw) return true;
      return (
        item.title.toLowerCase().includes(kw) ||
        item.questionContent.toLowerCase().includes(kw) ||
        item.questionUrl.toLowerCase().includes(kw) ||
        item.answer.toLowerCase().includes(kw)
      );
    });
    const total = rows.length;
    const start = (Math.max(1, page) - 1) * pageSize;
    return { rows: rows.slice(start, start + pageSize), total, page: Math.max(1, page), pageSize };
  }

  // ---------- 答案记录 ----------

  loadAnswers() {
    if (this.answers) return this.answers;
    this.answers = this.readArray(this.files.answers).map(normalizeQuestion)
      .filter((item) => item.title || item.questionUrl || item.answer);
    this.rebuildAnswerIndex();
    return this.answers;
  }

  upsertAnswer(item) {
    const answers = this.loadAnswers();
    const normalized = normalizeQuestion(item);
    if (!normalized.answer && !normalized.questionUrl && !normalized.title) return answers;
    const key = recordKey(normalized);
    const existing = this.answersByKey.get(key);
    if (existing) {
      // 就地合并：保持数组顺序，O(1) 定位
      Object.assign(existing, normalized, { createdAt: existing.createdAt || normalized.createdAt });
    } else {
      answers.unshift(normalized);
      this.answersByKey.set(key, normalized);
    }
    this.scheduleSave("answers");
    return answers;
  }

  findAnswer(item) {
    this.loadAnswers();
    return this.answersByKey.get(recordKey(item)) || null;
  }

  clearAnswers({ onlyUsed = false } = {}) {
    const answers = this.loadAnswers();
    const kept = onlyUsed
      ? answers.filter((item) => item.status !== "已提交")
      : [];
    const removed = answers.length - kept.length;
    this.answers = kept;
    this.rebuildAnswerIndex();
    this.scheduleSave("answers");
    return removed;
  }

  rebuildAnswerIndex() {
    this.answersByKey = new Map();
    for (const item of this.answers || []) {
      this.answersByKey.set(recordKey(item), item);
    }
  }

  // ---------- 已用题键（随机抽题去重） ----------

  loadUsedKeys() {
    const progress = this.loadProgress();
    return progress.usedKeys || [];
  }

  addUsedKeys(keys) {
    const progress = this.loadProgress();
    const set = new Set(progress.usedKeys || []);
    for (const key of keys || []) set.add(String(key));
    progress.usedKeys = Array.from(set);
    this.scheduleSave("progress");
    return progress.usedKeys;
  }

  resetUsedKeys() {
    const progress = this.loadProgress();
    progress.usedKeys = [];
    this.scheduleSave("progress");
  }

  // ---------- 每环境进度 ----------

  loadProgress() {
    if (this._progress) return this._progress;
    this._progress = this.readObject(this.files.progress);
    if (!this._progress || typeof this._progress !== "object") this._progress = {};
    if (!Array.isArray(this._progress.usedKeys)) this._progress.usedKeys = [];
    if (!this._progress.byEnv || typeof this._progress.byEnv !== "object") this._progress.byEnv = {};
    return this._progress;
  }

  getEnvProgress(envLabel) {
    const progress = this.loadProgress();
    if (!progress.byEnv[envLabel]) progress.byEnv[envLabel] = { lastPage: 1, usedKeys: [] };
    if (!Array.isArray(progress.byEnv[envLabel].usedKeys)) progress.byEnv[envLabel].usedKeys = [];
    return progress.byEnv[envLabel];
  }

  /** 记录该环境+分类爬到的页码（断点续爬用） */
  setEnvPage(envLabel, page) {
    const envProgress = this.getEnvProgress(envLabel);
    envProgress.lastPage = Math.max(1, Number(page) || 1);
    this.scheduleSave("progress");
  }

  rememberEnvQuestion(envLabel, key, meta = {}) {
    const envProgress = this.getEnvProgress(envLabel);
    if (meta.lastPage) envProgress.lastPage = meta.lastPage;
    const set = new Set([...(envProgress.usedKeys || []), ...(this.loadProgress().usedKeys || []), key]);
    envProgress.usedKeys = Array.from(set);
    this.loadProgress().usedKeys = Array.from(set);
    this.scheduleSave("progress");
  }

  // ---------- AI 用量 ----------

  addUsage(entry) {
    const usage = this.readObject(this.files.usage);
    usage.total = usage.total || { calls: 0, promptTokens: 0, completionTokens: 0 };
    usage.log = Array.isArray(usage.log) ? usage.log : [];
    usage.total.calls += 1;
    usage.total.promptTokens += entry.promptTokens || 0;
    usage.total.completionTokens += entry.completionTokens || 0;
    usage.log.unshift({ at: nowText(), model: entry.model, ...entry });
    if (usage.log.length > 500) usage.log.length = 500;
    writeAtomic(this.files.usage, usage);
    return usage.total;
  }

  getUsage() {
    const usage = this.readObject(this.files.usage);
    return usage.total || { calls: 0, promptTokens: 0, completionTokens: 0 };
  }

  /** 今日 token 用量（按本地日期前缀匹配 usage.log），供日预算上限判断 */
  getUsageToday() {
    const usage = this.readObject(this.files.usage);
    const log = Array.isArray(usage.log) ? usage.log : [];
    const todayPrefix = new Date().toLocaleDateString("zh-CN");
    return log.reduce((sum, entry) => {
      if (!entry || String(entry.at || "").startsWith(todayPrefix)) {
        return sum + Number(entry?.promptTokens || 0) + Number(entry?.completionTokens || 0);
      }
      return sum;
    }, 0);
  }

  // ---------- 底层 ----------

  readArray(filePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  readObject(filePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  scheduleSave(name, delayMs = 500) {
    if (this.saveTimers.has(name)) clearTimeout(this.saveTimers.get(name));
    const timer = setTimeout(() => {
      this.saveTimers.delete(name);
      this.flush(name);
    }, delayMs);
    this.saveTimers.set(name, timer);
  }

  flush(name) {
    if (name === "bank" && Array.isArray(this.bank)) writeAtomic(this.files.bank, this.bank);
    if (name === "answers" && Array.isArray(this.answers)) writeAtomic(this.files.answers, this.answers);
    if (name === "progress" && this._progress) writeAtomic(this.files.progress, this._progress);
  }

  flushAll() {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.flush("bank");
    this.flush("answers");
    this.flush("progress");
  }
}

module.exports = { Store, questionKeys, recordKey, normalizeQuestion };
