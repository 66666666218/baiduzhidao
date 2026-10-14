"use strict";

/**
 * 「一键全自动跑着的时候，别的任务不许开工」这条规则**唯一的一份实现**。
 *
 * ── 为什么单独成模块，而不是直接写在 app-context.js 的 startTask 里 ──
 * app-context.js 第一行就 require("electron")，测试里根本加载不起来。规则写在那边，
 * 单测就只剩"扫源码文本"这一条退路，而**扫文本读不出逻辑**（见下面的血泪）。
 * 这条规则虽然只有几行，却有一个非对称性：一旦判错方向，后果是整条一键全自动当场报废，
 * 所以它必须能被真单测直接打。
 *
 * ── 血泪（2.0.44 → 2.0.45）：这个我自己造的回归 ──
 * 第 16 轮我在 startTask 开头加了这把锁，本意是补上这个缺口：
 * 一键全自动**不在** TaskManager 里跑（它只是编排，按阶段逐个调 startTask），
 * 于是"阶段之间"（尤其抽题那一步，它压根不是任务）`tasks.current` 是空的，
 * 用户此刻手点「爬题」会被放行 —— 两条链同时跑，抢同一批比特窗口和同一份台账。
 *
 * 但我忘了一件事：**一键全自动自己正是通过 startTask 逐个启动阶段的**。
 * 于是它自己把第一个阶段（「确认批量发布权益」）挡在了门外，那个阶段瞬间失败，
 * 整链按"后续阶段不再执行"中止。用户看到的日志是：
 *
 *     ⚠️ 确认批量发布权益 失败，后续阶段不再执行：一键全自动正在运行中，请先点「停止当前任务」或等它结束。
 *     ══════ 一键全自动结束：0/2 个阶段成功，1 个阶段被跳过：按题材上传（在「确认批量发布权益」中断） ══════
 *
 * 也就是"点了一键全自动，什么都没跑，还报了一句莫名其妙的一键全自动正在运行中"。
 *
 * ── 结论（这三条就是下面函数的全部内容，别再加第四条） ──
 *   ① 编排没在跑          → 放行（谁都能开）
 *   ② 是编排自己发起的     → 放行（否则整条链会在第一个阶段把自己掐死）
 *   ③ 编排已经点过停止     → 放行（它不会再拉起任何新阶段了，锁的意义已经消失；
 *                             此刻还在收尾的那个阶段由 TaskManager 自己的锁兜着，
 *                             而点过停止后 TaskManager 会走"宽限期到了就强制放锁"那条路 ——
 *                             那正是"点了停止之后还能继续操作"的保证，不能再被这里挡回去）
 *   ④ 其余（编排在跑、没停、又是外面手动点的） → 拒绝
 */

/**
 * 一键全自动运行期间，这次 startTask 是否该被拒绝？
 *
 * @param {object} input
 * @param {boolean} input.pipelineRunning 编排是否在跑（autoPipeline.isRunning()）
 * @param {boolean} input.pipelineAborted 编排是否已收到停止请求（autoPipeline.isAborted()）
 * @param {boolean} input.fromPipeline 这次调用是不是编排自己发起的
 * @returns {boolean} true = 拒绝这次 startTask
 */
function pipelineBlocksTask({ pipelineRunning, pipelineAborted, fromPipeline } = {}) {
  if (!pipelineRunning) return false;
  if (fromPipeline) return false;
  // ⚠️ 这一条是"点了取消之后其他操作也卡"的复现路径：编排收到停止请求后，
  // 若它当前那个阶段恰好卡在不可中断的 await 上（浏览器 API / 长硬等），
  // 编排的 run() 就一直不返回、isRunning() 永远为 true。
  // 只看 isRunning() 的话，用户点完取消，界面解锁了、任务锁也放掉了，
  // 却**一按任何按钮就被这里拒掉** —— 和没修之前一模一样。
  if (pipelineAborted) return false;
  return true;
}

/** 被拒时给用户看的那句话 —— 界面、日志、测试引的都是这一份文案 */
function pipelineBlockedMessage() {
  return "一键全自动正在运行中（它自己会按顺序跑各个阶段）。"
    + "要手动跑别的任务，请先点「停止当前任务」，或等它结束。";
}

/**
 * 把一个「原样 startTask」包成「带编排身份标记的 startTask」。
 *
 * app-context.js 注入给编排的就是它。这样做的**结构性好处**：
 * auto-pipeline.js 里拿到的 `startTask` 永远是这个带标记的版本，它内部**任何**阶段
 * （包括将来新加的）都只能调注入进来的这一个函数 —— 所以不存在"新写一个阶段忘了带标记"，
 * 也就不会再有第二次"编排把自己锁在门外"。
 *
 * @param {Function} startTask 主进程的真 startTask(name, payload, runner, options)
 * @returns {Function} 只接收前三个参数的编排专用版
 */
function pipelineStartTask(startTask) {
  return function startTaskFromPipeline(name, payload, runner) {
    return startTask(name, payload, runner, { fromPipeline: true });
  };
}

module.exports = { pipelineBlocksTask, pipelineBlockedMessage, pipelineStartTask };
