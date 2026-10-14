"use strict";

const { nowText, AI_CONCURRENCY_MAX } = require("../config");
const excel = require("../storage/excel");
const { buildQualityGate } = require("../quality/gate");
// 节奏（每条多少秒 / 还剩多久）的口径全仓只有一处（netdisk/transfer-progress.js），生成阶段直接复用，
// 不在本地另写一份 pace / formatDuration / 收尾文案 —— 两个"还剩多久"互相不一致比没有更糟。
//（这行的字面量口径也要避开那个词：扫文本守卫按"全仓只许一处"判，注释里写一遍也算一处。）
const { progressLine, measurePace, shouldReportPace, generatePaceTail } = require("../netdisk/transfer-progress");

/** 质检重复度比对窗口大小（条） */
const DUPLICATE_WINDOW = 300;
/**
 * 单条回答的 token 成本**保守估计**，只用于"预算闸要不要放行"，
 * 第一次拿到实测值后会被顶上去（取历史最大值，始终偏保守）。
 */
const ESTIMATED_TOKENS_PER_ANSWER = 1200;

/**
 * AI 生成任务：对给定题目行批量生成回答。
 * - 有答案的行自动跳过（也尝试从历史记录恢复）
 * - 并发受 LlmClient 信号量控制；**worker 池按启动时的并发数起**
 * - 热配置：Key / 模型 / 模板运行中改立即生效；**并发数调小立即生效，调大要等下一轮**
 *   （worker 数是固定的，调大时信号量里没有"正在排队的 worker"可放行。
 *    这里以前写着"运行中修改 AI 设置立即生效"—— 半句真话，2026-10-14 改准。）
 * - 按行去重，避免重复生成
 * - ★ 提供 filePath 时把答案写回表格（周期性+结束时），保证"抽题→生成→提交"表格链路可用
 * - 节奏播报（每 10 条一次「进度/秒条/还剩多久」）复用 netdisk/transfer-progress 的口径，
 *   不在本地另算一份 —— 见那个文件头。
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
  //
  // ⚠️ 方向别搞反：`loadAnswers()` 是**新在前**（store 用 unshift 插入），
  // 所以"最近 N 条"= 取前 N 条。以前这里写的是 `.slice(-DUPLICATE_WINDOW)` —— 取到的
  // 是**最旧**的 N 条，与上面这句注释正好相反。后果：库里累积几千条之后，昨天刚生成的那批
  // 同模板答案根本不在比对窗口里，"跨轮次雷同"这条质检形同虚设。
  const storedAnswers = (store.loadAnswers ? store.loadAnswers() : []).map((item) => item.answer).filter(Boolean);
  const duplicateWindow = (Array.isArray(deps.existingAnswers) ? deps.existingAnswers : [])
    .concat(storedAnswers.slice(0, DUPLICATE_WINDOW))
    .slice(0, DUPLICATE_WINDOW);

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
  let autosaveWarned = false;
  let lastWriteTarget = "";   // 最近一次真正写成功的路径（可能是备份文件）
  let wroteToBackup = false;  // 是否至少有一次没能写进原表
  let budgetExhausted = false;
  // 预算闸用的"在途"记账：inFlight = 已发出、还没回来的生成请求数；
  // estPerAnswer = 单条回答的 token 成本估计，先用一个**保守的**常量，第一次实测到真实值后顶上去。
  // 宁可高估：高估只会让我们早一点停手，低估则是真金白银的超支。
  const budgetState = { inFlight: 0, estPerAnswer: ESTIMATED_TOKENS_PER_ANSWER };
  // 节奏播报的起点：只用于算"实测每条多少秒、这批还要多久"，不参与任何业务判断。
  const generateStartedAt = Date.now();
const total = slots.length;
  log(`开始批量生成回答：共 ${total} 行（去重后 ${byKey.size} 题${duplicateCount ? `，重复行 ${duplicateCount}` : ""}），`
    + `并发 ${llm.semaphore.limit}（设置页「AI 生成答案」里可调 1~${AI_CONCURRENCY_MAX}；供应商限流返 429 会自动退避重试，不烧号）。`);
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

      const saved = store.findAnswer(item);
      // 历史恢复必须排在预算闸**之前**：这一步一分钱不花（答案就在库里）。
      // 以前闸门写在前面，于是预算用尽时连"本来零成本、库里已有答案"的题也一起被放弃 ——
      // 花钱买来的答案反而因为"今天不花钱了"而用不上。
      if (!item.answer.trim() && saved && saved.answer.trim()) {
        item.answer = saved.answer;
        restored += 1;
        log(`恢复历史答案 ${done}/${total}：${label}`);
      }

      // 日预算闸：今日 token 用量达到上限则暂停本轮生成。
      // 必须读 livePayload()：用户在任务运行中把预算调高，走的正是这条判断。
      const budget = Math.max(0, Number(ctx.livePayload().aiDailyTokenBudget) || 0);
      if (budget > 0 && !item.answer.trim()) {
        // 把"已经放出去、还没回来"的请求也算进当日用量。一次生成要几十秒，
        // 只读已落盘的用量会让 N 个 worker 在闸门处读到同一个（还不包含彼此的）数字而全部放行，
        // 当日用量因此可能冲到并发数倍 —— 对"花钱上限"这个承诺是实质违约。
        const spentToday = store.getUsageToday();
        const usedToday = spentToday + budgetState.inFlight * budgetState.estPerAnswer;
        if (usedToday >= budget) {
          budgetExhausted = true;
          log(`⛔ 已达到今日 AI token 预算上限（已落盘 ${spentToday}/${budget}，另有 ${budgetState.inFlight} 条在途），生成暂停。`
            + `已处理 ${results.filter(Boolean).length}/${total} 行；可在设置中调高预算后明天继续。`);
          return;
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
        // 在途登记 + 实测成本回填：见 budgetState 的注释。
        // 记账必须放在 try/finally 里 —— 中途抛错不回退 inFlight 的话，
        // 后面的题会被一个永远不减少的"在途数"挡住，表现为"预算明明还有却一直说用完了"。
        const spentBefore = store.getUsageToday();
        budgetState.inFlight += 1;
        try {
          item.answer = await llm.generateAnswer(item, {
            titleTemplate: live.titleTemplate,
            introTemplate: live.introTemplate,
            onLog: log,
          });
          generated += 1;
          const spent = store.getUsageToday() - spentBefore;
          if (spent > 0) budgetState.estPerAnswer = Math.max(budgetState.estPerAnswer, spent);
        } catch (error) {
          failed += 1;
          if (!firstError) firstError = String(error.message || error);
          item.status = `生成失败：${String(error.message).slice(0, 80)}`;
          log(`生成失败并继续下一题：${item.status}`);
        } finally {
          budgetState.inFlight -= 1;
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
        // CSV 自动保存兜底（防表格被占用/进程崩溃丢记录）。
        // 失败**必须说一句**：这条 CSV 的全部意义就是"表格写不进去时还能找回记录"，
        // 静默 catch 等于用户以为有保险、其实没有（submit.js 那边一直是会告警的）。
        // 只提醒一次，免得几百条各刷一行。
        if (deps.autosavePath) {
          try {
            excel.appendCsvRow(deps.autosavePath, excel.answerToRow(item), excel.ANSWER_HEADERS);
          } catch (csvErr) {
            if (!autosaveWarned) {
              autosaveWarned = true;
              log(`⚠️ CSV 兜底写入失败（${csvErr.message}）—— 进程若异常退出，本轮记录可能丢失。`);
            }
          }
        }
      }

      // 回填：该 key 的所有行（含重复行）都拿到同一答案
      for (const other of slots) {
        if (other.key === key) results[other.index] = { ...item };
      }
      ctx.emitItem(item);
      ctx.report({ done: results.filter(Boolean).length, total, status: "running" });
      // 节奏播报：每 10 条（样本 ≥2）报一次「进度 / 秒条 / 还剩多久」。
      // 口径复用 transfer-progress 的 shouldReportPace + progressLine + measurePace
      // —— 每条耗时与 ETA 全仓只许那一处有，本地再算一份就会出现两个互相不一致的"还剩多久"。
      // 存在的理由：用户盯着 20 条一点点蹦，最想问的就是"还要多久"；以前这一段一个数字都不给。
      const finished = results.filter(Boolean).length;
      if (shouldReportPace({ done: finished })) {
        const pace = measurePace({ done: finished, elapsedMs: Date.now() - generateStartedAt });
        const paceLine = progressLine({ done: finished, total, perItemMs: pace });
        if (paceLine) log(paceLine);
      }
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
    // writeWorkbookSafe 在**原表被 Excel 占用**时不抛错，而是把内容写进
    // 「xxx_备份_<时间戳>.xlsx」并把那个路径返回。必须接住这个返回值 ——
    // 以前无视它、收尾还无条件打印"表格已更新：<原表>"，于是日志里既有"已另存备份"
    // 又有"表格已更新"（自相矛盾），用户以为好了，实际原表一字未改；
    // 紧接着的提交阶段读原表会说"表格里有题目链接但没有回答内容"，让人以为生成没干活。
    const writtenTo = excel.writeWorkbookSafe(filePath, allRows, "随机抽题", excel.ANSWER_HEADERS,
      (message) => log(message));
    lastWriteTarget = writtenTo;
    if (writtenTo !== filePath) wroteToBackup = true;
  }

  await maybeWriteTable(true);

  const stopped = ctx.shouldStop() || budgetExhausted;
  ctx.report({ done: total, total, status: budgetExhausted ? "stopped" : stopped ? "stopped" : "done" });
  // 收尾带上实测节奏：用户问"生成怎么这么慢"时，这一行就是答案
  //（并发几条、平均每条几秒、这批一共跑了多久、撞了几次供应商限流）。
  // 文案（含每条耗时口径）由 transfer-progress 出，这里不自己拼；
  // 没有样本时它返回空串，不会显示"每条 0 秒"。
  const finishedAll = results.filter(Boolean).length;
  const elapsedAll = Date.now() - generateStartedAt;
  const paceAll = measurePace({ done: finishedAll, elapsedMs: elapsedAll });
  // 撞限流的次数由 LlmClient 自己记（每撞一次 429 加一）。这个数字是用户调并发数的唯一依据：
  // 撞了几十次 = 调过头了，一次没撞 = 还能再加。放在收尾行里，不用他翻日志数。
  const rateLimited = Number(llm.usage && llm.usage.rateLimited) || 0;
  const paceTail = generatePaceTail({
    concurrency: llm.semaphore.limit, perItemMs: paceAll, elapsedMs: elapsedAll, rateLimited,
  });
  log(`${budgetExhausted ? "生成暂停（日预算用尽）" : stopped ? "生成已停止" : "生成完成"}：新回答 ${generated} 条，`
    + `历史恢复 ${restored} 条，已有跳过 ${skippedExisting} 条，失败 ${failed} 条${paceTail}。`);
  if (filePath) {
    if (wroteToBackup && lastWriteTarget !== filePath) {
      log(`⚠️ 表格没能写回原文件（写进了备份：${lastWriteTarget}）。原表里这些行**仍然没有回答内容** —— `
        + "请关掉 Excel/WPS 后重跑一次生成，否则下一步「自动提交」读原表会报「表格里有题目链接但没有回答内容」。");
    } else {
      log(`表格已更新：${filePath}`);
    }
  }
  // 全军覆没要报失败：Key 失效、baseUrl 填错这类问题会让每一题都抛错，
  // 而任务仍以"生成完成"收尾，界面上看不出任何异常（失败数只躺在日志里）。
  if (failed > 0 && !generated && !restored && !skippedExisting) {
    throw new Error(`本批 ${total} 题全部生成失败：${firstError}`);
  }
  return { stopped, count: generated, failed, restored, total, results: results.filter(Boolean) };
}

module.exports = { runGenerateTask };

/** 追加一条到 CSV 自动保存文件（autosavePath 为空时跳过） */
/** 删掉了 appendAutosave 包装：它唯一的用途是把异常吞掉（已改成在调用处告警）。 */

