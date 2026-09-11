"use strict";

const { chromium } = require("playwright-core");
const zhidao = require("../pages/zhidao");
const { nowText } = require("../config");
const { getWorkPage } = require("./crawl");
const { allocateRowsToEnvs } = require("./manager");
const { describeError } = require("../errors");
const excel = require("../storage/excel");

/**
 * 自动提交任务：把已生成的答案按账号轮换逐条提交。
 * - 每账号每轮限额（accountDailyLimit）
 * - 打开题目链接 → 等就绪 → 填答案 → 点提交
 * - 单条失败记录并继续
 */
async function runSubmitTask(ctx, deps) {
  const { browserPool, store, config, log, copy } = deps;
  const filePath = String(ctx.payload.filePath || "").trim().replace(/^"|"$/g, "");
  let lastWriteAt = 0;
  const pendingWriteBack = new Map(); // url -> {submittedAt, confirmed}
  const forceResubmit = Boolean(ctx.payload.forceResubmit);
  const allRows = (Array.isArray(ctx.payload.results) ? ctx.payload.results : [])
    .filter((row) => row && row.questionUrl && String(row.answer || "").trim());
  if (!allRows.length) {
    const rawRows = Array.isArray(ctx.payload.results) ? ctx.payload.results : [];
    const withUrl = rawRows.filter((row) => row && row.questionUrl).length;
    const withAnswer = rawRows.filter((row) => row && String(row.answer || "").trim()).length;
    if (rawRows.length && withUrl && !withAnswer) {
      throw new Error("表格里有题目链接但没有回答内容：请先完成「生成答案」步骤，或确认表格包含「回答内容」列。");
    }
    if (rawRows.length && !withUrl) {
      throw new Error("表格里没有「题目地址」列或全为空：请使用「随机抽题」导出的表格。");
    }
    throw new Error("当前没有可提交的答案，请确保每条都有题目链接和回答内容。");
  }

  // 防重复：已提交的行默认跳过，避免重复回答浪费账号额度
  const skippedSubmitted = forceResubmit ? 0 : allRows.filter((row) => row.status === "已提交").length;
  const candidateRows = forceResubmit
    ? allRows
    : allRows.filter((row) => row.status !== "已提交");
  if (!forceResubmit && skippedSubmitted > 0) {
    log(`已跳过 ${skippedSubmitted} 条状态为“已提交”的答案（如需重交请勾选强制重交）。`);
  }
  if (!candidateRows.length) {
    log("所有答案均已提交，本次无需提交。");
    return { stopped: false, count: 0, failed: 0, total: 0, results: [] };
  }

  const bitEnvs = (ctx.payload.bitEnvs || []).map((env) => env.label || env);
  if (!bitEnvs.length) throw new Error("请先填写至少一个比特浏览器环境名称。");

  const submitLimit = Math.max(0, Number(ctx.payload.submitLimit) || 0);
  const dailyLimit = Math.max(0, Number(ctx.payload.dailyAnswerLimit) || 0);
  let rows = submitLimit > 0 ? candidateRows.slice(0, submitLimit) : candidateRows;
  if (dailyLimit > 0) {
    log(`本次总回答数量上限 ${dailyLimit} 条。`);
    rows = rows.slice(0, dailyLimit);
  }
  if (!rows.length) throw new Error("本次总回答数量为 0，不再继续。");

  const accountDailyLimit = Math.max(0, Number(ctx.payload.accountDailyLimit) || 0);
  const perEnvLimitRaw = bitEnvs.length > 1 ? Math.max(1, Number(ctx.payload.maxQuestionsPerEnv) || rows.length) : rows.length;

  // 提交前达标检测：活动页显示已全部解锁的账号跳过（v1 功能保留，默认开启，checkCompletedEnvs=false 关闭）
  let completedEnvs = new Set();
  if (ctx.payload.checkCompletedEnvs !== false) {
    try {
      const { runPassedCountTask } = require("./passed-count");
      const passed = await runPassedCountTask({ ...ctx, payload: { ...ctx.payload, bitEnvs: bitEnvs.map((label) => ({ label })) } }, deps);
      completedEnvs = new Set(
        passed.accounts.filter((account) => account.status === "completed").map((account) => account.bitEnv)
      );
      if (completedEnvs.size) log(`已达标账号（自动跳过）：${Array.from(completedEnvs).join("、")}`);
    } catch (error) {
      log(`账号达标检测失败（不影响提交）：${error.message}`);
    }
  }

  const activeEnvs = bitEnvs.filter((label) => !completedEnvs.has(label));
  if (!activeEnvs.length) {
    log("所有账号均已达标，本次无需提交。");
    return { stopped: false, count: 0, failed: 0, total: 0, results: [] };
  }
  const allocation = allocateRowsToEnvs(rows, activeEnvs, { perEnvLimit: perEnvLimitRaw, accountDailyLimit });
  const totalPlanned = allocation.reduce((sum, slot) => sum + slot.rows.length, 0);

  log(`准备自动提交 ${totalPlanned}/${allRows.length} 条答案。`);
  // 容量不足时显式告警，绝不静默丢弃
  if (totalPlanned < rows.length) {
    const dropped = rows.length - totalPlanned;
    log(`⚠️ 本轮账号容量（${activeEnvs.length} 个账号 × 每账号上限）只放行 ${totalPlanned} 条，剩余 ${dropped} 条本轮不提交。请提高「每账号单轮条数/每账号每日限额」或增加账号后再跑一次。`);
  }
  log(`提交逻辑：每账号提交 ${accountDailyLimit > 0 ? accountDailyLimit : "不限"} 条后轮换；打开题目链接、填入回答、点击提交。`);

  await browserPool.adapter.checkConnection();
  let successCount = 0;
  let failCount = 0;
  let processed = 0;
  const results = [];

  for (const slot of allocation) {
    if (ctx.shouldStop() || !slot.rows.length) continue;
    const envLabel = slot.envLabel;
    let browser = null;
    try {
      log(`打开比特环境：${envLabel}（本账号 ${slot.rows.length} 条）`);
      const handle = await browserPool.acquire(envLabel);
      browser = await chromium.connectOverCDP(handle.cdpUrl);
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = await getWorkPage(context);
      page.setDefaultTimeout(config.timeoutMs);
      page.setDefaultNavigationTimeout(config.timeoutMs);

      for (const item of slot.rows) {
        if (ctx.shouldStop()) break;
        processed += 1;
        ctx.report({ done: successCount + failCount, total: totalPlanned, status: "running" });
        log(`打开题目链接 ${processed}/${totalPlanned}：${item.title || item.questionUrl}`);
        try {
          await page.bringToFront().catch(() => {});
          await zhidao.openQuestionByUrl(page, item.questionUrl, { onLog: log });
          await zhidao.waitForBaiduReady(page, config.verifyWaitSeconds, { onLog: log });
          const pageTitle = await zhidao.readQuestionTitle(page).catch(() => "");
          if (pageTitle) log(`题目页标题：${pageTitle}`);
          const filled = await zhidao.fillAnswerDraft(page, item.answer, { onLog: log });
          if (!filled) {
            // 兜底：把答案放进剪贴板，用户可手动粘贴
            if (typeof copy === "function") await copy(item.answer).catch(() => {});
            throw new Error("答案填入失败（答案已复制到剪贴板，可手动粘贴）");
          }
          await zhidao.submitAnswer(page, { onLog: log });
          const confirmation = await zhidao.readSubmitConfirmation(page).catch(() => ({ confirmed: false, signal: "" }));
          if (confirmation.confirmed) {
            log(`已确认页面成功提示：「${confirmation.signal}」`);
          } else {
            log("⚠️ 未捕捉到页面成功提示（可能仍在提交、需审核，或页面改版），已按已提交记录，建议在账号页复核。");
          }

          successCount += 1;
          const submitted = {
            ...item,
            title: pageTitle || item.title,
            bitEnv: envLabel,
            status: "已提交",
            confirmed: confirmation.confirmed,
            submittedAt: nowText(),
          };
          store.upsertAnswer(submitted);
          results.push(submitted);
          if (deps.autosavePath) {
            try { excel.appendCsvRow(deps.autosavePath, excel.answerToRow(submitted), excel.ANSWER_HEADERS); } catch { /* 兜底通道失败不影响提交 */ }
          }
          ctx.emitItem(submitted);
          writeBackStatus(submitted);
          log(`提交成功：${submitted.title || submitted.questionUrl}`);
        } catch (error) {
          failCount += 1;
          const failedItem = { ...item, bitEnv: envLabel, status: `提交失败：${describeError(error)}` };
          results.push(failedItem);
          ctx.emitItem(failedItem);
          log(`提交失败：${item.title || item.questionUrl}；${describeError(error)}`);
        }
        ctx.report({ done: successCount + failCount, total: totalPlanned, status: "running" });
        if (processed < totalPlanned && !ctx.shouldStop()) {
          await ctx.delay(config.delayMin, config.delayMax, "下一条提交间隔");
        }
      }
    } catch (error) {
      log(`比特环境 ${envLabel} 自动提交失败：${describeError(error)}`);
    } finally {
      await browser?.close?.().catch(() => {});
      await browserPool.release(envLabel, { close: config.closeAfter });
    }
    // 账号轮换之间同样保持随机间隔，降低集中操作特征
    if (ctx.shouldStop() === false) {
      await ctx.delay(config.delayMin, config.delayMax, "账号切换间隔");
    }
  }

  writeBackStatus(null, true);

  const stopped = ctx.shouldStop();
  ctx.report({ done: successCount + failCount, total: totalPlanned, status: stopped ? "stopped" : "done" });
  log(`${stopped ? "已停止" : "自动提交完成"}：成功 ${successCount} 条，失败 ${failCount} 条。`);
  return { stopped, count: successCount, failed: failCount, total: totalPlanned, results };

  /** 把提交状态写回来源表格（累积所有已提交行 + 节流 + 结束强制），保证"跳过已提交"读到最新状态 */
  function writeBackStatus(submitted, force = false) {
    if (!filePath) return;
    if (submitted) {
      const url = String(submitted.questionUrl || "").toLowerCase();
      if (url) pendingWriteBack.set(url, { submittedAt: submitted.submittedAt || "", confirmed: Boolean(submitted.confirmed) });
    }
    const now = Date.now();
    if (!force && now - lastWriteAt < 5000) return;
    if (!pendingWriteBack.size) return;
    lastWriteAt = now;
    try {
      const rows = excel.readTableRows(filePath).map(excel.importRowToAnswer);
      for (const row of rows) {
        const update = pendingWriteBack.get(String(row.questionUrl || "").toLowerCase());
        if (update) {
          row.status = "已提交";
          row.submittedAt = update.submittedAt;
          row.confirmed = update.confirmed;
        }
      }
      excel.writeWorkbookSafe(filePath, rows.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS);
      pendingWriteBack.clear();
    } catch (error) {
      log(`写回表格状态失败（不影响提交记录）：${error.message}`);
    }
  }
}

module.exports = { runSubmitTask };
