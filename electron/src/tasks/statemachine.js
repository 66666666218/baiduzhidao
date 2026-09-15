"use strict";

/**
 * 统一任务状态机。
 *
 * 状态：
 *   PENDING → RUNNING → SUCCESS
 *                    → FAILED
 *                    → CANCELLED
 *   RUNNING ⇄ PAUSED（协作式暂停：任务在检查点自行挂起）
 *
 * 所有迁移经 transition() 校验，非法迁移抛错；每次迁移发出事件。
 * TaskManager v2 持有状态机实例；现有任务通过 ctx 继续工作，无需感知。
 */

const STATES = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

// 合法迁移表
const TRANSITIONS = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["PAUSED", "SUCCESS", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"], // RUNNING 表示 RESUMING 后回到运行
  SUCCESS: [],
  FAILED: [], // 重试通过新建任务实例表达（重试策略在 TaskManager 层）
  CANCELLED: [],
};

class TaskStateMachine {
  constructor({ taskId, emit } = {}) {
    this.taskId = taskId || `task_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
    this.emit = emit || (() => {});
    this.state = STATES.PENDING;
    this.history = [{ state: this.state, at: new Date().toISOString() }];
    this.startedAt = null;
    this.finishedAt = null;
    this.failReason = null;
  }

  get isTerminal() {
    return [STATES.SUCCESS, STATES.FAILED, STATES.CANCELLED].includes(this.state);
  }

  get isRunning() {
    return this.state === STATES.RUNNING;
  }

  can(to) {
    return (TRANSITIONS[this.state] || []).includes(to);
  }

  transition(to, meta = {}) {
    if (!STATES[to]) throw new Error(`未知任务状态：${to}`);
    if (!this.can(to)) {
      throw new Error(`非法任务状态迁移：${this.state} → ${to}`);
    }
    const from = this.state;
    this.state = to;
    const at = new Date().toISOString();
    this.history.push({ state: to, at, ...(meta.reason ? { reason: meta.reason } : {}) });
    if (to === STATES.RUNNING && !this.startedAt) this.startedAt = at;
    if (this.isTerminal) this.finishedAt = at;
    if (to === STATES.FAILED) this.failReason = meta.reason || meta.error || null;
    this.emit("task.stateChanged", { taskId: this.taskId, from, to, ...meta });
    return this;
  }

  start() {
    return this.transition(STATES.RUNNING);
  }

  pause(reason) {
    return this.transition(STATES.PAUSED, { reason });
  }

  resume() {
    return this.transition(STATES.RUNNING, { reason: "resumed" });
  }

  succeed(detail) {
    return this.transition(STATES.SUCCESS, { detail });
  }

  fail(reason) {
    return this.transition(STATES.FAILED, { reason });
  }

  cancel(reason) {
    return this.transition(STATES.CANCELLED, { reason });
  }

  snapshot() {
    return {
      taskId: this.taskId,
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      failReason: this.failReason,
      history: this.history.slice(),
    };
  }
}

module.exports = { TaskStateMachine, STATES, TRANSITIONS };
