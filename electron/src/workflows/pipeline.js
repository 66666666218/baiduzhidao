"use strict";

/**
 * Pipeline/Workflow 执行器（v2.1-③）。
 *
 * 把"爬题→规范化→去重→生成→质检→提交"这类多阶段流程抽象为阶段数组：
 *   stages: [{ name, async run({ input, previous, ctx }) }]
 *
 * 能力：
 * - 每阶段发 pipeline.stageStarted/Succeeded/Failed 事件（经 eventBus）
 * - 断点续跑：每阶段成功后调用 checkpoint.save({ completedStages, results })，
 *   再执行时 checkpoint.load() 返回的 completedStages 中的阶段被跳过
 * - 失败即停：阶段抛错 → 发 pipeline.stageFailed → 整体抛出（保留阶段名）
 * - 阶段返回值链式传递：下一阶段收到 { input, previous: 所有前序阶段结果 }
 */
class Pipeline {
  constructor({ name, stages, eventBus, checkpoint } = {}) {
    this.name = name || "pipeline";
    this.stages = stages || [];
    if (this.eventBus === undefined) this.eventBus = eventBus || null;
    this.checkpoint = checkpoint || null; // { load(): {completedStages}|null, save(data) }
  }

  emitEvent(event, payload) {
    if (this.eventBus) this.eventBus.emit(event, { pipeline: this.name, ...payload });
  }

  async run({ input, ctx } = {}) {
    const completed = new Set(this.loadCompletedStages());
    const previous = {};
    for (const stage of this.stages) {
      if (completed.has(stage.name)) {
        this.emitEvent("pipeline.stageSkipped", { stage: stage.name });
        continue;
      }
      const started = Date.now();
      this.emitEvent("pipeline.stageStarted", { stage: stage.name });
      try {
        previous[stage.name] = (await stage.run({ input, previous, ctx })) ?? null;
      } catch (error) {
        this.emitEvent("pipeline.stageFailed", { stage: stage.name, error: error.message });
        const wrapped = new Error(`[阶段失败:${stage.name}] ${error.message}`);
        wrapped.stage = stage.name;
        wrapped.cause = error;
        throw wrapped;
      }
      this.emitEvent("pipeline.stageSucceeded", { stage: stage.name, ms: Date.now() - started });
      this.saveCheckpoint(completed, stage.name);
    }
    return previous;
  }

  loadCompletedStages() {
    if (!this.checkpoint || typeof this.checkpoint.load !== "function") return [];
    const state = this.checkpoint.load();
    return state && Array.isArray(state.completedStages) ? state.completedStages : [];
  }

  saveCheckpoint(completed, justFinished) {
    completed.add(justFinished);
    if (this.checkpoint && typeof this.checkpoint.save === "function") {
      this.checkpoint.save({ workflow: this.name, completedStages: Array.from(completed) });
    }
  }
}

module.exports = { Pipeline };
