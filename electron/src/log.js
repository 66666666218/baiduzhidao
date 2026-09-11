"use strict";

const fs = require("fs");
const path = require("path");

/** 账号打码：保留前 1 位与后 1 位，中间以 * 代替 */
function maskEnv(label) {
  const text = String(label || "").trim();
  if (!text) return "";
  if (text.length <= 2) return `${text[0]}*`;
  if (text.length <= 6) return `${text.slice(0, 1)}*${text.slice(-1)}`;
  return `${text.slice(0, 2)}**${text.slice(-2)}`;
}

class Logger {
  constructor(logDir) {
    this.logDir = logDir || "";
    this.listeners = new Set();
    this.filePath = "";
    this.maskEnabled = true;
    this.envLabels = [];   // 已知账号名；开启打码时日志文本中的账号名自动替换为打码形式
    this.buffer = [];
    if (logDir) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        this.cleanupOldLogs(logDir, 30);
        this.filePath = path.join(logDir, `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)}.log`);
      } catch {
        this.filePath = "";
      }
    }
  }

  /** 注册已知账号名（设置保存时调用），供自动打码 */
  setEnvLabels(labels) {
    this.envLabels = (Array.isArray(labels) ? labels : [])
      .map((label) => String(label || "").trim())
      .filter(Boolean);
  }

  /** 清理超过保留天数的旧日志，防止无限累积 */
  cleanupOldLogs(logDir, keepDays = 30) {
    const deadline = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir)) {
      if (!/^run-.*\.log$/.test(name)) continue;
      const fullPath = path.join(logDir, name);
      try {
        if (fs.statSync(fullPath).mtimeMs < deadline) fs.unlinkSync(fullPath);
      } catch {
        // 单个文件清理失败不影响启动
      }
    }
  }

  onLog(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMask(enabled) {
    this.maskEnabled = Boolean(enabled);
  }

  log(message, { env } = {}) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let text = String(message ?? "");
    if (this.maskEnabled && this.envLabels.length) {
      for (const label of this.envLabels) {
        if (text.includes(label)) text = text.split(label).join(maskEnv(label));
      }
    }
    if (env) text = `[${maskEnv(env)}] ${text}`;
    const line = `[${time}] ${text}`;
    this.buffer.push(line);
    if (this.buffer.length > 2000) this.buffer.splice(0, 500);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
      } catch {
        // 日志落盘失败不阻塞主流程
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(text);
      } catch {
        // 渲染端异常不影响任务
      }
    }
    return line;
  }

  recentLines() {
    return this.buffer.slice();
  }
}

module.exports = { Logger, maskEnv };
