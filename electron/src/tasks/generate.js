"use strict";

const { nowText } = require("../config");
const excel = require("../storage/excel");
const { buildQualityGate } = require("../quality/gate");

/** 质检重复度比对窗口大小（条） */
const DUPLICATE_WINDOW = 300;

/**
 * AI 生成任务：对给定题目行批量生成回答。
 * - 有答案的行自动跳过（也尝试从历史记录恢复）
 * - 并发受 LlmClient 信号量控制
 * - 热配置：运行中修改 AI 设置立即生效
 * - 按行去重，避免重复生成
 * - ★ 提供 filePath 时把答案写回表格（周期性+结束时），保证"抽题→生成→提交"表格链路可用
 */
async function runGenerateTask(ctx, deps) {
  const { store, llm, log } = deps;
  const autosavePath = deps.autosavePath || "";
  const rows = Array.isArray(ctx.payload.results) ? ctx.payload.results : [];
  if (!rows.length) throw new Error("当前没有可生成的题目，请先抽题或选择表格。");

  const qualityGate = deps.qualityGate || buildQualityGate({});
  const filePath = String(ctx.payload.filePath || "").trim().replace(/^"|"$/g, "");
  const { titleTemplate, introTemplate } = ctx.payload;

  // 重复度比对窗口：质检门的 duplicate 项需要既有回答，不传就恒为 0（等于形同虚设）。
  // 只取最近 N 条而不是全库：全库比对是 O(库容量×答案长度) 每条目，两万条时整轮会慢到不可用；
  // 而"批量生成雷同模板话"恰好发生在相邻的几十上百条之间。
  const duplicateWindow = (Array.isArray(deps.existingAnswers) ? deps.existingAnswers : [])
    .concat((store.loadAnswers ? store.loadAnswers() : []).map((item) => item.answer).filter(Boolean))
    .slice(-DUPLICATE_WINDOW);

  // 去重：同 URL/标题只生成一次；uniqueWork 是首次出现的行，完成后回填所有重复行
  const byKey = new Map();
  const slots = rows.map((row, index) => {
    const item = {
      ...row,
      title: String(row.title || "").trim(),
      questionContent: String(row.questionContent || "").replace(/\r\n/g, "\n").trim(),
      questionUrl: String(row.questionUrl || "").trim(),
      answer: String(row.answer || "").replace(/\r\n/g, "\n"),
    };
    const key = item.questionUrl
      ? `url:${item.questionUrl.toLowerCase()}`
      : `title:${item.title.replace(/\s+/g, "").toLowerCase()}`;
    const slot = { item, key, index };
    if (!byKey.has(key)) byKey.set(key, slot);
    return slot;
  });
  const uniqueWork = Array.from(byKey.values());
  const duplicateCount = slots.length - uniqueWork.length;

  let done = 0;
  let generated = 0;
  let failed = 0;
  let firstError = "";
  let restored = 0;
  let skippedExisting = 0;
  let lastWriteAt = 0;
  let budgetExhausted = false;
const total = slots.length;
  log(`开始批量生成回答：共 ${total} 行（去重后 ${byKey.size} 题${duplicateCount ? `，重复行 ${duplicateCount}` : ""}），并发 ${llm.semaphore.limit}。`);
  if (filePath) log(`生成结果将写回表格：${filePath}`);

  const results = new Array(total).fill(null);
  const workers = Array.from({ length: Math.min(llm.semaphore.limit, uniqueWork.length) }, () => worker());
  await Promise.all(workers);

  async function worker() {
    while (true) {
      if (ctx.shouldStop() || budgetExhausted) return;
      await ctx.pausePoint?.("生成·题间检查点");
      const slot = uniqueWork[done];
      if (!slot) return;
      done += 1;
      const { item, key, index } = slot;
      if (results[index]) continue;
      const label = item.title || item.questionContent.slice(0, 30) || item.questionUrl;

      // 日预算闸：今日 token 用量达到上限则暂停本轮生成（已有答案的行仍会跳过统计）
      // 必须读 livePayload()：用户在任务运行中把预算调高，走的正是这条判断。
      const budget = Math.max(0, Number(ctx.livePayload().aiDailyTokenBudget) || 0);
      if (budget > 0 && !item.answer.trim()) {
        const usedToday = store.getUsageToday();
        if (usedToday >= budget) {
          budgetExhausted = true;
          log(`⛔ 已达到今日 AI token 预算上限（${usedToday}/${budget}），生成暂停。已处理 ${results.filter(Boolean).length}/${total} 行；可在设置中调高预算后明天继续。`);
          return;
        }
      }

      const saved = store.findAnswer(item);
      if (!item.answer.trim()) {
        if (saved && saved.answer.trim()) {
          item.answer = saved.answer;
          restored += 1;
          log(`恢复历史答案 ${done}/${total}：${label}`);
        }
      }

      if (item.answer.trim()) {
        skippedExisting += 1;
        log(`跳过已有答案 ${done}/${total}：${label}`);
      } else {
        const live = ctx.livePayload();
        // AI Key / baseUrl / model 只从 settings 走（settings:save 已热更新到 llm 实例）。
        // 这里曾用任务 payload 覆盖它们，等于任何能发起 task:generate 的地方都能把
        // Bearer Key 和题目内容 POST 到自定义地址；表格链路里就带着这段 payload。
        log(`生成回答 ${done}/${total}：${label}`);
        try {
          item.answer = await llm.generateAnswer(item, {
            titleTemplate: live.titleTemplate,
            introTemplate: live.introTemplate,
            onLog: log,
          });
          generated += 1;
        } catch (error) {
          failed += 1;
          if (!firstError) firstError = String(error.message || error);
          item.status = `生成失败：${String(error.message).slice(0, 80)}`;
          log(`生成失败并继续下一题：${item.status}`);
        }
      }

      // 库里已标"已提交"就不要降级：表格行通常不带提交状态，失败分支也会写 status，
      // 覆写成"已生成回答/生成失败"会让这题重新落进未提交池，造成重复提交。
      const alreadySubmitted = item.status === "已提交" || /已提交/.test(String((saved || {}).status || ""));
      item.status = item.answer.trim()
        ? (alreadySubmitted ? "已提交" : "已生成回答")
        : (alreadySubmitted ? "已提交" : (item.status || "待生成"));
      item.createdAt = item.createdAt || nowText();
      if (item.answer.trim()) {
        const verdict = qualityGate.evaluate(item.answer, {
          title: item.title,
          questionContent: item.questionContent,
          // 去掉这题自己的历史答案：否则历史恢复/表内已有答案的行会和自己比出 1.0，
          // 稳定误判成"与既有回答高度重复"。
          existingAnswers: saved && saved.answer ? duplicateWindow.filter((text) => text !== saved.answer) : duplicateWindow,
        });
        item.quality = `${verdict.decision}(${verdict.score})${verdict.issues.length ? "：" + verdict.reviewReason : ""}`;
        if (deps.emitEvent) {
          deps.emitEvent("answer.qualityChecked", {
            question: item.title || item.questionUrl,
            decision: verdict.decision,
            score: verdict.score,
          });
        }
        if (verdict.decision === "REVIEW") log(`质检提醒：${item.title || item.questionUrl} → ${verdict.reviewReason}，建议人工复核。`);
        duplicateWindow.push(item.answer);
        if (duplicateWindow.length > DUPLICATE_WINDOW) duplicateWindow.splice(0, duplicateWindow.length - DUPLICATE_WINDOW);
        store.upsertAnswer(item);
        // CSV 自动保存兜底（防表格被占用/进程崩溃丢记录）
        appendAutosave(deps.autosavePath, item);
      }

      // 回填：该 key 的所有行（含重复行）都拿到同一答案
      for (const other of slots) {
        if (other.key === key) results[other.index] = { ...item };
      }
      ctx.emitItem(item);
      ctx.report({ done: results.filter(Boolean).length, total, status: "running" });
      if (filePath) await maybeWriteTable(false);
      if (ctx.shouldStop()) return;
    }
  }

  async function maybeWriteTable(force) {
    if (!filePath) return;
    const now = Date.now();
    if (!force && now - lastWriteAt < 5000) return;
    lastWriteAt = now;
    // 未处理的行也要原样写回：以前只写 results 里已完成的行，
    // 中途停止或日预算用尽时，剩余题目会被整表覆写抹掉（100 行跑 30 行就只剩 30 行）。
    const touched = results.filter(Boolean);
    if (!touched.length) return;
    const allRows = slots.map((slot, index) => excel.answerToRow(results[index] || slot.item));
    excel.writeWorkbookSafe(filePath, allRows, "随机抽题", excel.ANSWER_HEADERS,
      (message) => log(message));
  }

  await maybeWriteTable(true);

  const stopped = ctx.shouldStop() || budgetExhausted;
  ctx.report({ done: total, total, status: budgetExhausted ? "stopped" : stopped ? "stopped" : "done" });
  log(`${budgetExhausted ? "生成暂停（日预算用尽）" : stopped ? "生成已停止" : "生成完成"}：新回答 ${generated} 条，历史恢复 ${restored} 条，已有跳过 ${skippedExisting} 条，失败 ${failed} 条。`);
  if (filePath) log(`表格已更新：${filePath}`);
  // 全军覆没要报失败：Key 失效、baseUrl 填错这类问题会让每一题都抛错，
  // 而任务仍以"生成完成"收尾，界面上看不出任何异常（失败数只躺在日志里）。
  if (failed > 0 && !generated && !restored && !skippedExisting) {
    throw new Error(`本批 ${total} 题全部生成失败：${firstError}`);
  }
  return { stopped, count: generated, failed, restored, total, results: results.filter(Boolean) };
}

module.exports = { runGenerateTask };

/** 追加一条到 CSV 自动保存文件（autosavePath 为空时跳过） */
function appendAutosave(autosavePath, item) {
  if (!autosavePath) return;
  try {
    excel.appendCsvRow(autosavePath, excel.answerToRow(item), excel.ANSWER_HEADERS);
  } catch {
    // 兜底通道失败不影响主流程
  }
}

