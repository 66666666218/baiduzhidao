"use strict";

const { nowText } = require("../config");
const excel = require("../storage/excel");
const { buildQualityGate } = require("../quality/gate");

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
      const budget = Math.max(0, Number(ctx.payload.aiDailyTokenBudget) || 0);
      if (budget > 0 && !item.answer.trim()) {
        const usedToday = store.getUsageToday();
        if (usedToday >= budget) {
          budgetExhausted = true;
          log(`⛔ 已达到今日 AI token 预算上限（${usedToday}/${budget}），生成暂停。已处理 ${results.filter(Boolean).length}/${total} 行；可在设置中调高预算后明天继续。`);
          return;
        }
      }

      if (!item.answer.trim()) {
        const saved = store.findAnswer(item);
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
        llm.setConfig({ apiKey: live.aiApiKey, baseUrl: live.aiBaseUrl, model: live.aiModel });
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
          item.status = `生成失败：${String(error.message).slice(0, 80)}`;
          log(`生成失败并继续下一题：${item.status}`);
        }
      }

      item.status = item.answer.trim() ? (item.status === "已提交" ? "已提交" : "已生成回答") : (item.status || "待生成");
      item.createdAt = item.createdAt || nowText();
      if (item.answer.trim()) {
        const verdict = qualityGate.evaluate(item.answer, { title: item.title, questionContent: item.questionContent });
        item.quality = `${verdict.decision}(${verdict.score})${verdict.issues.length ? "：" + verdict.reviewReason : ""}`;
        if (verdict.decision === "REVIEW") log(`质检提醒：${item.title || item.questionUrl} → ${verdict.reviewReason}，建议人工复核。`);
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
    const completed = results.filter(Boolean);
    if (!completed.length) return;
    excel.writeWorkbookSafe(filePath, completed.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS,
      (message) => log(message));
  }

  await maybeWriteTable(true);

  const stopped = ctx.shouldStop() || budgetExhausted;
  ctx.report({ done: total, total, status: budgetExhausted ? "stopped" : stopped ? "stopped" : "done" });
  log(`${budgetExhausted ? "生成暂停（日预算用尽）" : stopped ? "生成已停止" : "生成完成"}：新回答 ${generated} 条，历史恢复 ${restored} 条，已有跳过 ${skippedExisting} 条，失败 ${failed} 条。`);
  if (filePath) log(`表格已更新：${filePath}`);
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

