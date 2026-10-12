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
const { roundRobinAssign, capacityOf } = require("../domain/account-topic");

/**
 * 停止宽限期：点了「停止」之后，给任务这么多秒自己收尾（走到下一个 shouldStop 检查点
 * 并 report 终态）。超过还没退出，就**强制释放任务锁**。
 *
 * 为什么必须有这一条（2026-10-13 用户实测反馈「点了一键全自动之后容易卡住，点了取消，
 * 想进行里面的操作也会卡」）：
 *   停止只是把 `ticket.stopped` 置 true —— 它是**协作式**的，任务必须自己走到检查点才
 *   看得到。而任务里存在不可中断的 await（浏览器 API、30 秒硬等、网络读流），期间
 *   `this.current` 一直非空，`assertIdle()` 就会把之后**每一个**任务都拒掉，
 *   界面按钮也因为没有终态进度而永久灰着 —— 表现就是"整个软件卡住了"，只能重启进程。
 *   宁可放锁让新任务和正在退出的旧任务短暂重叠（旧任务下一检查点就会自己退出），
 *   也不能永久锁死。
 */
const STOP_GRACE_MS = 20 * 1000;

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

  emitEvent(event, payload, ticket) {
    const owner = ticket || this.current;
    if (this.eventBus) this.eventBus.emit(event, { taskName: owner ? owner.name : undefined, ...payload });
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
    const ticket = { name, machine, stopped: false, paused: false, livePayload: { ...(payload || {}) },
      // 回调挂在票据上：强制释放时任务已经不在 this.current 里了，
      // 只有票据能拿到"怎么通知界面/日志"。
      onProgress: onProgress || null, onLog: onLog || null,
      stopRequestedAt: 0, forceReleased: false, releaseTimer: null };
    this.current = ticket;
    this.emitEvent("task.started", { taskId: machine.taskId }, ticket);
    machine.start();

    // ⚠️ 从这里往下**一律用 ticket，不再用 this.current**。
    // 原因：强制释放会把 this.current 置空（否则任务锁永久不释放），而旧任务还在跑。
    // 若 ctx.shouldStop() 读的是 this.current，释放后它返回 false ——
    // 旧任务会以为"停止请求被撤销了"，继续跑下去，正好和强制释放的目的相反。
    const self = this;
    /** 最近一次上报的进度；暂停/恢复时要复用 done/total 改写状态，不然界面进度条会跳空 */
    let lastProgress = null;
    const ctx = {
      payload: ticket.livePayload,
      shouldStop: () => Boolean(ticket.stopped),
      shouldPause: () => Boolean(ticket.paused),
      /** 暂停检查点：已请求暂停时挂起，直到 resume/cancel/stop */
      async pausePoint(label = "") {
        if (!ticket.paused) return;
        // 并发>1 时多个 worker 会同时走到这里：状态机只允许 RUNNING→PAUSED，
        // 第二个 worker 再 pause 就是非法迁移并抛错，会把整个任务 Promise.all 打崩。
        if (machine.state === STATES.RUNNING) {
          machine.pause(label || "checkpoint");
          self.emitEvent("task.paused", { taskId: machine.taskId, label: label || "checkpoint" }, ticket);
          onLog?.("任务已暂停（检查点：" + (label || "checkpoint") + "）。");
          // 进度条也要显式变成"已暂停"：任务挂在 pausePoint 里不再 report，
          // 界面会一直停在"进行中"，用户分不清是卡住还是在等恢复。
          if (lastProgress) onProgress?.({ ...lastProgress, status: "paused" });
        }
        while (ticket.paused && !ticket.stopped) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!ticket.stopped && machine.state === STATES.PAUSED && machine.can(STATES.RUNNING)) {
          machine.resume();
          self.emitEvent("task.resumed", { taskId: machine.taskId }, ticket);
          onLog?.("任务已恢复。");
          if (lastProgress) onProgress?.({ ...lastProgress, status: "running" });
        }
      },
      livePayload: () => ({ ...ticket.livePayload }),
      updateLiveSettings: (patch) => {
        if (ticket.stopped) return;
        ticket.livePayload = { ...ticket.livePayload, ...(patch || {}) };
      },
      delay: randomDelayFactory(() => ticket.stopped),
      report: (progress) => {
        lastProgress = progress || null;
        onProgress?.(progress);
      },
      emitItem: (item) => onItem?.(item),
    };

    try {
      const result = await run(ctx);
      // 判定用 ticket.stopped 而不是 this.current.stopped：被强制释放的任务收尾时
      // this.current 已经是别的任务（或 null），用 this.current 会把"用户手动停掉的"
      // 记成"成功完成"，历史列表里就再也看不出它是被停的。
      if (ticket.stopped) {
        machine.cancel("user_stop");
        this.emitEvent("task.cancelled", { taskId: machine.taskId }, ticket);
      } else {
        machine.succeed();
        this.emitEvent("task.succeeded", { taskId: machine.taskId }, ticket);
      }
      this.archive(ticket);
      return result;
    } catch (error) {
      if (!machine.isTerminal) {
        // 任务在暂停中失败时 PAUSED→FAILED 是非法迁移，直接 fail 会在 catch 里再抛一次，盖掉真正的错误。
        // 走 cancel 兜底，但**必须把真实错误带上**：以前只写 `failed_while_paused`，
        // 读状态机记录的人只看到"它在暂停时失败了"，完全不知道失败原因是什么。
        if (machine.can(STATES.FAILED)) machine.fail(error.message);
        else machine.cancel(`failed_while_${machine.state.toLowerCase()}（${error.message}）`);
        // 状态机记录里也给一份，免得消费方只看 failReason 时又是空的
        machine.failReason = error.message;
        this.emitEvent("task.failed", { taskId: machine.taskId, error: error.message }, ticket);
      }
      this.archive(ticket);
      throw error;
    } finally {
      // 只清自己那把锁：强制释放后用户可能已经起了新任务，无条件置 null 会把新任务的锁擦掉，
      // 于是新任务还没跑完就"没人占着"了 —— 互斥形同虚设。
      if (this.current === ticket) this.current = null;
      if (ticket.releaseTimer) { clearTimeout(ticket.releaseTimer); ticket.releaseTimer = null; }
    }
  }

  shouldStopCurrent() {
    return Boolean(this.current && this.current.stopped);
  }

  /**
   * 请求停止。协作式：任务在下一个检查点自行退出；超过宽限期没退出则强制放锁。
   * @returns {{ok:true, accepted:boolean, taskName?:string, graceMs:number}}
   *   accepted=false 表示此刻没有任务在跑（一键全自动在阶段之间点时就是这种情况）。
   */
  stop({ graceMs = STOP_GRACE_MS } = {}) {
    const ticket = this.current;
    if (!ticket) return { ok: true, accepted: false, graceMs };
    ticket.stopped = true;
    ticket.paused = false; // 停止优先于暂停
    ticket.stopRequestedAt = Date.now();
    if (!ticket.releaseTimer) {
      ticket.releaseTimer = setTimeout(() => this.forceRelease(ticket), graceMs);
      // 别让这个定时器拖住进程退出（打包版关窗时不需要等它）
      if (typeof ticket.releaseTimer.unref === "function") ticket.releaseTimer.unref();
    }
    return { ok: true, accepted: true, taskName: ticket.name, graceMs };
  }

  /**
   * 强制释放任务锁：任务卡在不可中断的 await 上（浏览器 API / 长硬等 / 读流）时，
   * 光置旗标是放不开的 —— 不释放的话 assertIdle() 会永久拒绝之后所有任务。
   *
   * 释放后旧任务仍持有 ticket，它的 ctx.shouldStop() 依旧为 true，
   * 所以旧任务走到下一个检查点就会自己退出，与新任务的重叠窗口很短。
   */
  forceRelease(ticket, reason = "停止后超过宽限期仍未退出") {
    if (!ticket || this.current !== ticket) return false;
    ticket.forceReleased = true;
    ticket.releaseTimer = null;
    this.current = null;
    // 必须补一条终态进度：界面靠它把动作按钮解锁。少了这一下，
    // 用户看到的就是"点了停止，之后什么按钮都点不动"。
    ticket.onProgress?.({ done: 0, total: 0, status: "stopped" });
    ticket.onLog?.(`⚠️ 任务「${ticket.name}」${reason}，已强制释放任务锁 —— 之后可以正常操作了。`
      + "（它在后台退出后不会再影响界面；若它其实还在跑，请重启软件彻底清掉。）");
    this.emitEvent("task.force-released", { taskId: ticket.machine.taskId, reason }, ticket);
    return true;
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

  /** 归档用显式 ticket：被强制释放的任务收尾时 this.current 已经不是它了 */
  archive(ticket) {
    const owner = ticket || this.current;
    if (!owner) return;
    this.history.push(owner.machine.snapshot());
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

/**
 * 账号轮换分配：把 rows 按每账号限额切片（纯函数可测）。
 *
 * 轮询实现已收敛到 domain/account-topic.js 的 roundRobinAssign——提交任务现在走
 * buildAllocation（带题材路由），这里只保留无题材场景的薄适配，避免两份轮询逻辑各自演进。
 */
function allocateRowsToEnvs(rows, envLabels, { perEnvLimit, accountDailyLimit } = {}) {
  const allocation = (Array.isArray(envLabels) ? envLabels : []).map((label) => ({ envLabel: label, rows: [] }));
  if (!allocation.length) return allocation;
  roundRobinAssign(Array.isArray(rows) ? rows : [], allocation, capacityOf({ perEnvLimit, accountDailyLimit }));
  return allocation;
}

module.exports = { TaskManager, allocateRowsToEnvs, randomDelayFactory, STOP_GRACE_MS };
