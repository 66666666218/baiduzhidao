"use strict";

/**
 * TaskManager v2.1：统一任务状态机（v2.1-①）。
 *
 * - 每个任务实例挂 TaskStateMachine（PENDING→RUNNING→SUCCESS/FAILED/CANCELLED）
 * - 协作式暂停/恢复：任务通过 ctx.pausePoint() 在检查点挂起
 * - 全生命周期发布事件（task.started/paused/resumed/succeeded/failed/cancelled）
 * - 内存保留最近 50 条任务快照（供 UI/审计）
 *
 * 兼容性：start(name, payload, run, hooks) 签名、ctx 契约（payload/shouldStop/
 * livePayload/updateLiveSettings/delay/report/emitItem）与 v1 完全一致；
 * 新增 ctx.shouldPause()/pausePoint() 供任务接入暂停检查点。
 */

const { TaskStateMachine, STATES } = require("./statemachine");

class TaskManager {
  constructor({ eventBus } = {}) {
    this.eventBus = eventBus || null;
    this.current = null; // { name, machine, stopped, paused, livePayload }
    this.history = [];
  }

  isRunning() {
    return Boolean(this.current && this.current.machine && this.current.machine.isRunning);
  }

  /** 任务存在且未到终态（含暂停中） */
  isActive() {
    return Boolean(this.current);
  }

  currentState() {
    return this.current ? this.current.machine.snapshot() : null;
  }

  historyList() {
    return this.history.slice(-50);
  }

  assertIdle() {
    if (this.isActive()) throw new Error("已有任务正在运行，请先停止或等待完成。");
  }

  emitEvent(event, payload) {
    if (this.eventBus) this.eventBus.emit(event, { taskName: this.current ? this.current.name : undefined, ...payload });
  }

  /**
   * 运行一个任务。run 函数收到 ctx：
   *   { payload, shouldStop(), shouldPause(), pausePoint(label), livePayload(),
   *     updateLiveSettings(patch), delay(min,max), report(progress), emitItem(item) }
   */
  async start(name, payload, run, { onLog, onProgress, onItem } = {}) {
    if (this.isActive()) {
      throw new Error("已有任务正在运行，请先停止或等待完成。");
    }
    const machine = new TaskStateMachine({
      taskId: `${name}_${Date.now()}`,
      emit: (event, meta) => this.emitEvent(event, { taskId: machine.taskId, ...meta }),
    });
    this.current = { name, machine, stopped: false, paused: false, livePayload: { ...(payload || {}) } };
    this.emitEvent("task.started", { taskId: machine.taskId });
    machine.start();

    const self = this;
    const ctx = {
      payload: this.current.livePayload,
      shouldStop: () => Boolean(self.current && self.current.stopped),
      shouldPause: () => Boolean(self.current && self.current.paused),
      /** 暂停检查点：已请求暂停时挂起，直到 resume/cancel/stop */
      async pausePoint(label = "") {
        if (!self.current || !self.current.paused) return;
        machine.pause(label || "checkpoint");
        self.emitEvent("task.paused", { taskId: machine.taskId, label: label || "checkpoint" });
        onLog?.("任务已暂停（检查点：" + (label || "checkpoint") + "）。");
        while (self.current && self.current.paused && !self.current.stopped) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (self.current && !self.current.stopped && machine.state === STATES.PAUSED) {
          machine.resume();
          self.emitEvent("task.resumed", { taskId: machine.taskId });
          onLog?.("任务已恢复。");
        }
      },
      livePayload: () => (self.current ? { ...self.current.livePayload } : { ...(payload || {}) }),
      updateLiveSettings: (patch) => {
        if (!self.current || self.current.stopped) return;
        self.current.livePayload = { ...self.current.livePayload, ...(patch || {}) };
      },
      delay: randomDelayFactory(() => self.shouldStopCurrent()),
      report: (progress) => onProgress?.(progress),
      emitItem: (item) => onItem?.(item),
    };

    try {
      const result = await run(ctx);
      if (this.current && this.current.stopped) {
        machine.cancel("user_stop");
        this.emitEvent("task.cancelled", { taskId: machine.taskId });
      } else {
        machine.succeed();
        this.emitEvent("task.succeeded", { taskId: machine.taskId });
      }
      this.archive();
      return result;
    } catch (error) {
      if (!machine.isTerminal) {
        machine.fail(error.message);
        this.emitEvent("task.failed", { taskId: machine.taskId, error: error.message });
      }
      this.archive();
      throw error;
    } finally {
      this.current = null;
    }
  }

  shouldStopCurrent() {
    return Boolean(this.current && this.current.stopped);
  }

  stop() {
    if (this.current) {
      this.current.stopped = true;
      this.current.paused = false; // 停止优先于暂停
    }
    return { ok: true };
  }

  /** 请求暂停：任务在下一个检查点挂起 */
  pause() {
    if (this.current) this.current.paused = true;
    return { ok: true, accepted: Boolean(this.current) };
  }

  /** 恢复暂停中的任务 */
  resume() {
    if (this.current) this.current.paused = false;
    return { ok: true, resumed: Boolean(this.current) };
  }

  /** 运行中热更新任务配置（settings:save 时调用；修复 v1 缺失该方法导致的保存报错） */
  updateLiveSettings(patch) {
    if (this.current && !this.current.stopped && patch && typeof patch === "object") {
      this.current.livePayload = { ...this.current.livePayload, ...patch };
    }
  }

  archive() {
    if (!this.current) return;
    this.history.push(this.current.machine.snapshot());
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
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
