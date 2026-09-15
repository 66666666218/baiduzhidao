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
    this.anyListeners = new Set();     // "*" 订阅
    this.prefixListeners = new Map();  // "task.*" 前缀订阅
  }

  /** 订阅事件；"*" 接收全部；"task.*" 接收 task. 前缀全部 */
  on(event, handler) {
    if (event === "*") {
      this.anyListeners.add(handler);
      return () => this.anyListeners.delete(handler);
    }
    if (event.endsWith(".*")) {
      const prefix = event.slice(0, -2); // "task.*" → "task"
      if (!this.prefixListeners.has(prefix)) this.prefixListeners.set(prefix, new Set());
      this.prefixListeners.get(prefix).add(handler);
      return () => this.prefixListeners.get(prefix).delete(handler);
    }
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event).delete(handler);
  }

  emit(event, payload = {}) {
    const envelope = { event, at: new Date().toISOString(), ...payload };
    const dispatch = (handlers) => {
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(envelope);
        } catch {
          // 订阅方异常不阻断发布方
        }
      }
    };
    dispatch(this.listeners.get(event));
    const dot = event.indexOf(".");
    if (dot > 0) dispatch(this.prefixListeners.get(event.slice(0, dot)));
    dispatch(this.anyListeners);
    return envelope;
  }
}

module.exports = { EventBus };
