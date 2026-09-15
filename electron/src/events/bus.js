"use strict";

/**
 * 轻量事件总线：任务状态机 / 流水线 / 质检 / 提交统一发布事件，
 * Logger、UI、统计、审计日志作为订阅方。零依赖、同步派发。
 *
 * 事件命名约定：域.动作（如 task.started、question.discovered、answer.generated、
 * answer.qualityChecked、submission.succeeded、account.blocked）。
 */
class EventBus {
  constructor() {
    this.listeners = new Map(); // event -> Set<fn>
    this.anyListeners = new Set();
  }

  /** 订阅具体事件；event 为 "*" 时接收全部事件 */
  on(event, handler) {
    if (event === "*") {
      this.anyListeners.add(handler);
      return () => this.anyListeners.delete(handler);
    }
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event).delete(handler);
  }

  emit(event, payload = {}) {
    const envelope = { event, at: new Date().toISOString(), ...payload };
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(envelope);
        } catch {
          // 订阅方异常不阻断发布方
        }
      }
    }
    for (const handler of this.anyListeners) {
      try {
        handler(envelope);
      } catch {
        // 同上
      }
    }
    return envelope;
  }
}

module.exports = { EventBus };
