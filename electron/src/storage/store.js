"use strict";

const fs = require("fs");
const path = require("path");
const { writeAtomic, nowText } = require("../config");

/** 占用文件心跳超过这个时长即认为持有者已死（崩溃/强杀残留），不再拦后来者 */
const LOCK_STALE_MS = 90 * 1000;

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0); // 只查存在性，不发信号
    return true;
  } catch (error) {
    return error.code === "EPERM"; // 进程在，只是没权限查
  }
}

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
  if (title || content) return `text:${title}:${content}`;
  // 无链接、无标题、无正文时只剩答案能区分记录；用固定 "text::" 会让这类记录互相覆盖，静默吞掉答案
  const answer = String((item && item.answer) || "").replace(/\s+/g, "").toLowerCase();
  return answer ? `answer:${answer.slice(0, 160)}` : "text::";
}

/**
 * 归一化"日"键。nowText() 用的是 toLocaleString('zh-CN')，不同 Node/ICU 版本会给出
 * "2026/9/20" 或 "2026-9-20"；记账与查账只要格式不一致，日预算就会读到 0 而形同虚设。
 */
function dayKeyOf(value) {
  const datePart = String(value || "").trim().split(/[ T]/)[0];
  const parts = datePart.split(/[-/.]/);
  if (parts.length !== 3) return datePart;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((n) => !Number.isFinite(n))) return datePart;
  return numbers.join("/");
}

function dayStamp(key) {
  const [y, m, d] = String(dayKeyOf(key)).split("/").map(Number);
  return Date.UTC(y || 1970, (m || 1) - 1, d || 1);
}

/**
 * 抢救"前半段是完整 JSON、尾部多出杂字节"的受损文件（实测来自并发写同一个 .tmp 名）。
 * 返回 { value, bytes, dropped }；无法安全抢救时 value 为 undefined。
 */
function salvageJson(text) {
  const empty = { value: undefined, bytes: 0, dropped: 0 };
  const source = String(text || "");
  const first = source.slice(source.search(/[[{]/), source.length);
  if (!first || (first[0] !== "{" && first[0] !== "[")) return empty;
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = source.indexOf(first[0]); i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return empty;
  const head = source.slice(source.indexOf(first[0]), end + 1);
  try {
    const value = JSON.parse(head);
    if (value === null || typeof value !== "object") return empty;
    return { value, bytes: head.length, dropped: source.length - head.length };
  } catch {
    return empty;
  }
}

function pruneByDay(byDay, keepDays = 64) {
  const keys = Object.keys(byDay || {});
  if (keys.length <= keepDays) return;
  for (const key of keys.sort((a, b) => dayStamp(a) - dayStamp(b)).slice(0, keys.length - keepDays)) delete byDay[key];
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
  constructor(dataDir, { owner = "gui", readonly = false } = {}) {
    this.dataDir = dataDir;
    this.owner = String(owner);
    /** 只读消费者（展示站）：既不写锁也不抢锁，避免把脚本互斥判断带偏 */
    this.readonly = Boolean(readonly);
    /** 检测到另一个仍然存活的写入者时记录其信息；不抛错，由调用方决定警告还是中止 */
    this.foreignWriter = null;
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
    this.claimLock();
    // 锁必须跟着写入者一起续期：只有 GUI 开心跳的话，跑几十分钟的命令行任务会在 90 秒后
    // 被自己的锁判成"已死"，第二个写入者随即放行——整份内存缓存互相覆写，正是这把锁要防的事。
    if (!this.readonly) this.startLockHeartbeat();
  }

  // ---------- 跨进程写入者检测 ----------
  //
  // GUI 有单实例锁，但 scripts/ 下的命令行工具各自 new Store(同一数据目录)：
  // 每个 Store 都把整份 bank/answers 数组缓存在内存里并整数组覆写（见 flush），
  // 所以"GUI 开着 + 脚本在跑"= 后写者静默覆盖先写者，题库/记录直接少一批。
  // 这里用一把带心跳的占用文件把冲突显式化：持有者每 30 秒续期，
  // 超过 90 秒没续期就当作进程已死（崩溃残留），不会把用户锁在自己的工具外面。

  lockFile() {
    return path.join(this.dataDir, ".store.lock");
  }

  claimLock() {
    if (this.readonly) return false;
    const existing = this.readLock();
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)
      && Date.now() - Number(existing.at || 0) < LOCK_STALE_MS) {
      this.foreignWriter = { ...existing, idleMs: Date.now() - Number(existing.at || 0) };
      return false;
    }
    this.foreignWriter = null;
    this.writeLock();
    return true;
  }

  readLock() {
    try {
      if (!fs.existsSync(this.lockFile())) return null;
      const raw = JSON.parse(fs.readFileSync(this.lockFile(), "utf8"));
      return raw && typeof raw === "object" && Number(raw.pid) ? raw : null;
    } catch {
      return null; // 锁文件本身坏了就当作没有，不能因此让程序起不来
    }
  }

  writeLock() {
    try {
      writeAtomic(this.lockFile(), { pid: process.pid, owner: this.owner, at: Date.now() });
    } catch {
      // 写不了锁就不拦人，正常流程优先
    }
  }

  /** 重新检查是否有别的有效写入者（任务启动前调用，覆盖"GUI 开着时脚本才起来"的窗口） */
  detectForeignWriter() {
    const existing = this.readLock();
    if (!existing || existing.pid === process.pid) return null;
    if (!isPidAlive(existing.pid) || Date.now() - Number(existing.at || 0) >= LOCK_STALE_MS) return null;
    this.foreignWriter = { ...existing, idleMs: Date.now() - Number(existing.at || 0) };
    return this.foreignWriter;
  }

  /** 命令行工具专用：检测到 GUI（或另一个脚本）正在写同一份数据时直接中止，避免互相覆盖 */
  assertExclusive(who = "命令行工具") {
    const foreign = this.detectForeignWriter();
    if (!foreign) return this.claimLock();
    throw new Error(
      `${who} 不能启动：数据目录正被另一个程序写入（${foreign.owner} 进程 ${foreign.pid}，` +
      `${Math.round(foreign.idleMs / 1000)} 秒前还在活动）。` +
      `两边各持一份内存缓存并整份覆写 JSON，同时跑会互相吞数据。请先关闭主程序（或另一个脚本）再运行。` +
      `数据目录：${this.dataDir}`
    );
  }

  /** 持有者心跳续期（GUI 用；unref 保证不会因这把锁而不退出） */
  startLockHeartbeat(intervalMs = 30000) {
    this.stopLockHeartbeat();
    this._lockTimer = setInterval(() => this.writeLock(), intervalMs);
    if (this._lockTimer.unref) this._lockTimer.unref();
    return this._lockTimer;
  }

  stopLockHeartbeat() {
    if (this._lockTimer) {
      clearInterval(this._lockTimer);
      this._lockTimer = null;
    }
  }

  /** 退出时释放；只删自己那把锁，避免误删后来者的 */
  releaseLock() {
    this.stopLockHeartbeat();
    try {
      const existing = this.readLock();
      if (existing && existing.pid === process.pid) fs.rmSync(this.lockFile(), { force: true });
    } catch {
      // 删不掉也会被心跳判据当作过期忽略
    }
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
      // 就地合并：保持数组顺序，O(1) 定位。
      // 只覆盖调用方真正给了值的字段——normalizeQuestion 会把缺省字段填成 ""/"已爬取"/false，
      // 无差别 assign 会让一次字段不全的二次 upsert（重跑迁移、对已提交题再生成）
      // 把既有 answer / status:"已提交" / submittedAt / confirmed 抹回初始态，去重就此失效。
      const provided = new Set(Object.keys(item || {}));
      const patch = {};
      for (const [field, value] of Object.entries(normalized)) {
        if (provided.has(field)) patch[field] = value;
      }
      Object.assign(existing, patch, { createdAt: existing.createdAt || normalized.createdAt });
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
    this._usageCache = null; // 使缓存失效
    const usage = this.readObject(this.files.usage);
    usage.total = usage.total || { calls: 0, promptTokens: 0, completionTokens: 0 };
    usage.log = Array.isArray(usage.log) ? usage.log : [];
    usage.byDay = usage.byDay && typeof usage.byDay === "object" ? usage.byDay : {};
    const at = String(entry.at || nowText());
    const dayKey = dayKeyOf(at);
    // 日志只保留最近 500 条，日累计必须独立记账，否则量到几千次调用后就把当天用量截断丢掉。
    // 新建当天键时用日志中同日的既有条目做种子，升级当天不至于从 0 开始。
    if (!usage.byDay[dayKey]) {
      const seed = { calls: 0, promptTokens: 0, completionTokens: 0 };
      for (const e of usage.log) {
        if (dayKeyOf(e?.at) !== dayKey) continue;
        seed.calls += 1;
        seed.promptTokens += Number(e?.promptTokens || 0);
        seed.completionTokens += Number(e?.completionTokens || 0);
      }
      usage.byDay[dayKey] = seed;
    }
    const day = usage.byDay[dayKey];
    day.calls += 1;
    day.promptTokens += entry.promptTokens || 0;
    day.completionTokens += entry.completionTokens || 0;
    usage.total.calls += 1;
    usage.total.promptTokens += entry.promptTokens || 0;
    usage.total.completionTokens += entry.completionTokens || 0;
    usage.log.unshift({ at, model: entry.model, ...entry });
    if (usage.log.length > 500) usage.log.length = 500;
    pruneByDay(usage.byDay);
    writeAtomic(this.files.usage, usage);
    return usage.total;
  }

  getUsage() {
    const usage = this.readObject(this.files.usage);
    return usage.total || { calls: 0, promptTokens: 0, completionTokens: 0 };
  }

  /** 今日 token 用量（按天独立累计，缺失时回退到日志扫描），供日预算上限判断 */
  getUsageToday() {
    // 性能优化：缓存 1 秒内有效（避免万行循环逐行 readFileSync）
    if (this._usageCache && Date.now() - this._usageCache.at < 1000 && this._usageCache.dirty !== true) {
      return this._usageCache.value;
    }
    const usage = this.readObject(this.files.usage);
    const todayKey = dayKeyOf(nowText());
    const byDay = usage.byDay && typeof usage.byDay === "object" ? usage.byDay : {};
    // 历史文件里可能同时存在 "2026/9/20" 和 "2026-9-20" 两种键，归一化后合并统计
    let total = 0;
    let hasDay = false;
    for (const [key, day] of Object.entries(byDay)) {
      if (dayKeyOf(key) !== todayKey) continue;
      hasDay = true;
      total += Number(day?.promptTokens || 0) + Number(day?.completionTokens || 0);
    }
    if (hasDay) {
      this._usageCache = { value: total, at: Date.now() };
      return total;
    }
    const log = Array.isArray(usage.log) ? usage.log : [];
    const result = log.reduce((sum, entry) => {
      if (dayKeyOf(entry?.at) === todayKey) {
        return sum + Number(entry?.promptTokens || 0) + Number(entry?.completionTokens || 0);
      }
      return sum;
    }, 0);
    this._usageCache = { value: result, at: Date.now() };
    return result;
  }

  // ---------- 底层 ----------

  /** 读 JSON；解析失败时先尝试抢救"完整文档 + 尾部杂字节"的形态，再改名备份并返回可挽救的最大结构 */
  readJsonSafe(filePath, fallback) {
    let text = "";
    try {
      if (!fs.existsSync(filePath)) return fallback;
      text = fs.readFileSync(filePath, "utf8") || "";
      if (!text.trim()) return fallback;
      return JSON.parse(text);
    } catch (error) {
      const salvaged = salvageJson(text);
      try {
        const backupPath = `${filePath}.损坏备份_${Date.now()}`;
        fs.renameSync(filePath, backupPath);
        console.error(`[store] ${filePath} 解析失败已备份为 ${backupPath}：${error.message}`);
      } catch {
        // 备份失败也不阻塞启动
      }
      if (salvaged.value !== undefined) {
        // 并发写同名 .tmp 会留下"整份 JSON + 尾部杂字节"。这里必须把抢救结果回写自愈：
        // 只改名备份会让文件"消失"，下一次读又走空结构，累计器就会从 0 重长（实测 19494 → 573）。
        try {
          writeAtomic(filePath, salvaged.value);
          console.error(`[store] ${filePath} 已抢救并回写 ${salvaged.bytes} 字节（丢弃 ${salvaged.dropped} 字节尾部杂数据）`);
        } catch (writeError) {
          console.error(`[store] ${filePath} 抢救结果回写失败：${writeError.message}`);
        }
        return salvaged.value;
      }
      return fallback;
    }
  }

  readArray(filePath) {
    const raw = this.readJsonSafe(filePath, []);
    return Array.isArray(raw) ? raw : [];
  }

  readObject(filePath) {
    const raw = this.readJsonSafe(filePath, {});
    return raw && typeof raw === "object" ? raw : {};
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

module.exports = { Store, questionKeys, recordKey, normalizeQuestion, pruneByDay, salvageJson, dayKeyOf };
