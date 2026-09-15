"use strict";

/**
 * 审计日志（v2.1-⑦）：自动化系统的可追溯性。
 *
 * 订阅事件总线，把关键动作以 JSONL 追加到 dataDir/audit/audit-YYYY-MM-DD.jsonl：
 *   { at, event, actor, ...payload }
 * 记录：谁(operator=local)、什么时候、对什么(题目/账号/任务)、执行了什么、结果。
 * 写入失败静默（审计不可阻断业务），按天分文件便于归档。
 */

const fs = require("fs");
const path = require("path");

class AuditLogger {
  constructor({ auditDir, operator = "local_user", eventBus } = {}) {
    this.auditDir = auditDir;
    this.operator = operator;
    this.writeQueue = [];
    this.flushing = false;
    if (eventBus) this.attach(eventBus);
    try {
      fs.mkdirSync(auditDir, { recursive: true });
    } catch {
      /* 目录创建失败时写入会再失败并静默 */
    }
  }

  /** 需要审计的事件集合（按域） */
  static AUDITED_EVENTS = [
    "task.started",
    "task.paused",
    "task.resumed",
    "task.succeeded",
    "task.failed",
    "task.cancelled",
    "answer.generated",
    "answer.qualityChecked",
    "submission.started",
    "submission.succeeded",
    "submission.failed",
    "account.blocked",
  ];

  attach(eventBus) {
    for (const event of AuditLogger.AUDITED_EVENTS) {
      eventBus.on(event, (envelope) => this.record(event, envelope));
    }
    return this;
  }

  /** 记录一条审计（事件总线回调或直接调用） */
  record(event, { actor, at, ...payload } = {}) {
    const entry = {
      at: at || new Date().toISOString(),
      event,
      actor: actor || this.operator,
      ...payload,
    };
    this.writeQueue.push(JSON.stringify(entry));
    this.flushAsync();
  }

  /** 异步批量落盘（同一 event-loop 内的多条合并为一次 append） */
  flushAsync() {
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const batch = this.writeQueue.splice(0);
      if (!batch.length || !this.auditDir) return;
      try {
        const day = new Date().toISOString().slice(0, 10);
        fs.appendFileSync(path.join(this.auditDir, `audit-${day}.jsonl`), batch.join("\n") + "\n", "utf8");
      } catch {
        // 审计写盘失败不阻断业务（如目录被删），丢弃本批
      }
    });
  }

  /** 同步冲刷（退出前调用） */
  flushSync() {
    const batch = this.writeQueue.splice(0);
    if (!batch.length || !this.auditDir) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      fs.mkdirSync(this.auditDir, { recursive: true });
      fs.appendFileSync(path.join(this.auditDir, `audit-${day}.jsonl`), batch.join("\n") + "\n", "utf8");
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { AuditLogger };
