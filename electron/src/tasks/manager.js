"use strict";

/**
 * TaskManager：v2 修复旧版 P4 —— 进度/停止/热配置/随机延迟只在引擎实现一次。
 * 同一时刻仅允许一个任务运行。
 */
class TaskManager {
  constructor() {
    this.current = null; // { name, stopped, livePayload, onLiveLog }
  }

  isRunning() {
    return Boolean(this.current && !this.current.stopped);
  }

  assertIdle() {
    if (this.isRunning()) throw new Error("已有任务正在运行，请先停止或等待完成。");
  }

  /**
   * 运行一个任务。run 函数收到 ctx：
   *   { payload, shouldStop(), livePayload(), delay(min,max,label), report(progress) }
   */
  async start(name, payload, run, { onLog, onProgress, onItem } = {}) {
    this.assertIdle();
    this.current = { name, stopped: false, livePayload: { ...(payload || {}) } };
    const ctx = {
      payload: this.current.livePayload,
      shouldStop: () => Boolean(this.current && this.current.stopped),
      livePayload: () => (this.current ? { ...this.current.livePayload } : { ...(payload || {}) }),
      updateLiveSettings: (patch) => {
        if (!this.current || this.current.stopped) return;
        this.current.livePayload = { ...this.current.livePayload, ...(patch || {}) };
      },
      delay: randomDelayFactory(() => this.shouldStopCurrent()),
      report: (progress) => onProgress?.(progress),
      emitItem: (item) => onItem?.(item),
    };
    try {
      return await run(ctx);
    } finally {
      this.current = null;
    }
  }

  shouldStopCurrent() {
    return Boolean(this.current && this.current.stopped);
  }

  stop() {
    if (this.current) this.current.stopped = true;
    return { ok: true };
  }
}

function randomDelayFactory(shouldStop) {
  return async function delay(minSeconds, maxSeconds) {
    const min = Math.max(0, Number(minSeconds) || 0);
    const max = Math.max(min, Number(maxSeconds) || min);
    const seconds = min + Math.random() * (max - min);
    const ms = Math.round(seconds * 1000);
    if (ms <= 0) return;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (shouldStop()) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  };
}

/** 账号轮换分配：把 rows 按每账号限额切片（供提交任务复用，纯函数可测）。 */
function allocateRowsToEnvs(rows, envLabels, { perEnvLimit, accountDailyLimit } = {}) {
  const allocation = envLabels.map((label) => ({ envLabel: label, rows: [] }));
  if (!allocation.length) return allocation;
  const limitOf = (index) => {
    const limits = [perEnvLimit, accountDailyLimit].filter((value) => Number(value) > 0);
    return limits.length ? Math.min(...limits) : Infinity;
  };
  let cursor = 0;
  let roundMoved = true;
  while (cursor < rows.length && roundMoved) {
    roundMoved = false;
    for (const slot of allocation) {
      if (cursor >= rows.length) break;
      if (slot.rows.length >= limitOf(0)) continue;
      slot.rows.push(rows[cursor]);
      cursor += 1;
      roundMoved = true;
    }
  }
  return allocation;
}

module.exports = { TaskManager, allocateRowsToEnvs, randomDelayFactory };
