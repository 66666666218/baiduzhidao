"use strict";

/**
 * AccountManager（v2.1-④）：账号策略集中管理。
 *
 * 职责：
 * - 维护账号档案（名称/状态/每日限额/今日已用/最近使用/健康度）
 * - 任务通过 acquire(envLabel) 请求账号，而不是自行轮换/判断额度
 * - release(envLabel) 归还并累计今日用量
 * - 额度耗尽/不健康 → acquire 抛出明确错误（或 markBlocked 由外部触发）
 *
 * 数据来源：设置里的比特环境名列表 + 存储层 answers 记录推导今日用量。
 */

const { nowText } = require("../config");

/**
 * 从 `2026/10/9 14:38:25`（nowText 的中文格式，月日**不补零**）里取"年月日"。
 * 正则故意用 [0-9] 而不是 \d —— 省得反斜杠在层层转义里丢掉。取不到返回空串。
 */
function dayKey(text) {
  const m = String(text || "").match(/([0-9]{4})[^0-9]+([0-9]{1,2})[^0-9]+([0-9]{1,2})/);
  return m ? `${m[1]}-${Number(m[2])}-${Number(m[3])}` : "";
}

class AccountManager {
  constructor({ store, dailyLimit = 0 } = {}) {
    this.store = store; // 电子主进程的 Store（读 answers 推今日用量）
    this.dailyLimit = Math.max(0, Number(dailyLimit) || 0);
    this.accounts = new Map(); // label -> { name, blocked, blockedReason, lastUsedAt, usedTodayOffset }
  }

  setDailyLimit(limit) {
    this.dailyLimit = Math.max(0, Number(limit) || 0);
  }

  /** 注册/刷新账号档案（设置保存时调用） */
  register(labels) {
    const list = Array.isArray(labels) ? labels : [labels];
    for (const raw of list) {
      const name = String(raw || "").trim();
      if (!name) continue;
      if (!this.accounts.has(name)) {
        this.accounts.set(name, {
          name,
          blocked: false,
          blockedReason: "",
          lastUsedAt: "",
          usedTodayOffset: 0, // 本进程内额外计数（answers 之外的行为，如失败试水）
        });
      }
    }
    return this.list();
  }

  list() {
    return Array.from(this.accounts.values()).map((account) => ({
      ...account,
      usedToday: this.usedToday(account.name),
      remaining: this.dailyLimit > 0 ? Math.max(0, this.dailyLimit - this.usedToday(account.name)) : null,
      dailyLimit: this.dailyLimit,
    }));
  }

  /**
   * 今日已用：只数**今天**提交的，加进程内偏移。
   *
   * 以前这里把 status==="已提交" 的记录**全部历史都算进来**（注释自己写着"简化口径"），
   * 于是历史越多这个数越大：从旧机器/旧版本带过来的 answers.json 一载入，每个账号都成了
   * "今日额度已用完（3000/10）"——明明今天一条都没发。换新电脑、迁移数据时必踩。
   * 没有时间戳的老记录一律不计（宁可少算，不可多算）。
   */
  usedToday(envLabel) {
    let count = 0;
    const offset = this.accounts.get(envLabel);
    const today = dayKey(nowText());
    for (const item of this.store.loadAnswers()) {
      if (item.status !== "已提交" || item.bitEnv !== envLabel) continue;
      if (dayKey(item.submittedAt) !== today) continue;
      count += 1;
    }
    return count + (offset ? offset.usedTodayOffset : 0);
  }

  /** 请求账号：额度/封禁校验，通过则登记使用 */
  acquire(envLabel) {
    const name = String(envLabel || "").trim();
    if (!name) throw new Error("账号名为空");
    if (!this.accounts.has(name)) this.register([name]);
    const account = this.accounts.get(name);
    if (account.blocked) {
      const error = new Error(`账号 ${name} 已被标记不可用：${account.blockedReason || "未知原因"}`);
      error.code = "ACCOUNT_BLOCKED";
      throw error;
    }
    const used = this.usedToday(name);
    if (this.dailyLimit > 0 && used >= this.dailyLimit) {
      const error = new Error(`账号 ${name} 今日额度已用完（${used}/${this.dailyLimit}）`);
      error.code = "ACCOUNT_QUOTA_EXCEEDED";
      throw error;
    }
    account.lastUsedAt = nowText();
    return { name, usedToday: used, dailyLimit: this.dailyLimit };
  }

  /** 归还并累计今日用量 */
  release(envLabel, { count = 1, succeeded = true } = {}) {
    const account = this.accounts.get(envLabel);
    if (account && succeeded) account.usedTodayOffset += Math.max(0, Number(count) || 0);
  }

  /** 标记账号不可用（如连续验证码/明确封禁提示） */
  markBlocked(envLabel, reason) {
    if (!this.accounts.has(envLabel)) this.register([envLabel]);
    const account = this.accounts.get(envLabel);
    account.blocked = true;
    account.blockedReason = String(reason || "未知原因");
    return account;
  }

  unblock(envLabel) {
    const account = this.accounts.get(envLabel);
    if (account) {
      account.blocked = false;
      account.blockedReason = "";
    }
    return account || null;
  }
}

module.exports = { AccountManager };
