"use strict";

const { chromium } = require("playwright-core");
const protocolSubmit = require("../zhidao/protocol-submit");
const zhidao = require("../pages/zhidao");
const { nowText } = require("../config");
const { getWorkPage } = require("./crawl");
const { buildAllocation } = require("../domain/account-topic");
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

  // 与 crawl.js 同样先校验形状：传成字符串时 .map 会抛 TypeError，任务只报"未知错误"
  const rawEnvs = Array.isArray(ctx.payload.bitEnvs) ? ctx.payload.bitEnvs : [];
  const bitEnvs = rawEnvs.map((env) => (env && typeof env === "object" ? env.label : env) || "").filter(Boolean);
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
  // 提交容量只由「每账号每日限额」（accountDailyLimit，风控语义）控制。
  // 不再挪用爬题参数 maxQuestionsPerEnv：它曾导致多账号时总量 = 账号数 × 5 的隐蔽截断
  //（单账号不限、多账号 5 条/号，行为不一致），用户设的「提交条数」形同虚设。
  const perEnvLimitRaw = rows.length;

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

  // AccountManager：集中校验账号可用性（封禁/额度），不可用的账号提前剔除
  const { AccountManager } = require("../browser/account-manager");
  const accountManager = deps.accountManager || new AccountManager({ store, dailyLimit: 0 });
  accountManager.register(activeEnvs);
  const usableEnvs = [];
  for (const label of activeEnvs) {
    try {
      accountManager.acquire(label);
      usableEnvs.push(label);
    } catch (error) {
      log(`账号 ${label} 不可用，跳过：${error.message}`);
    }
  }
  if (!usableEnvs.length) {
    log("没有可用账号（全部被额度/封禁拦截），本次不提交。");
    return { stopped: false, count: 0, failed: 0, total: 0, results: [] };
  }

  // 一个账号都拿不到凭据 / 窗口时，**先说这件事**。
  // 否则下一步会去检查表格，报出「表格里没有题目地址列」—— 用户会一直去改表格，
  // 而真正的原因是压根没有可用的账号。
  const hasAnyCred = usableEnvs.some((e) => typeof deps.credentialOf === "function" && deps.credentialOf(e));
  if (!hasAnyCred) {
    log("⚠️ 这些账号都没有已保存的 Cookie，将回落到比特窗口；若窗口也打不开就会失败。");
    log("   建议先到「账号凭证」页点「登录并提取」存一份 Cookie —— 之后全程不需要窗口。");
  }

  // 题材路由：带链接的答案严格一对一（账号只吃自己绑定的题材），纯文本答案宽松轮询。
  const topicMap = ctx.payload.accountTopics || {};
  const strictLinkRouting = String(ctx.payload.linkRouting || "strict") !== "off";
  const { slots: allocation, stats } = buildAllocation(rows, usableEnvs, topicMap, {
    perEnvLimit: perEnvLimitRaw,
    accountDailyLimit,
    strictLinkRouting,
  });
  const totalPlanned = stats.planned;

  log(`准备自动提交 ${totalPlanned}/${allRows.length} 条答案（带链接 ${stats.link} 条 / 纯文本 ${stats.plain} 条）。`);
  if (stats.link > 0) {
    log(strictLinkRouting
      ? `带链接答案走严格路由：账号 ↔ 题材一对一，未绑定题材的账号不会收到链接答案。`
      : `⚠️ 带链接答案路由已关闭（linkRouting=off），链接答案将按普通轮询分发。`);
  }
  // 两类未分配根因分开提示：题材没账号要去设置页，容量不够要去调额度，混在一起会把人引错方向
  if (stats.capacityDropped > 0) {
    log(`⚠️ 本轮账号容量（${usableEnvs.length} 个账号 × 每账号上限）只放行 ${totalPlanned} 条，剩余 ${stats.capacityDropped} 条本轮不提交。请提高「每账号每日限额」或增加账号后再跑一次。`);
  }
  const orphanEntries = Object.entries(stats.orphanByTopic);
  if (orphanEntries.length) {
    const detail = orphanEntries.map(([topic, count]) => `${topic} ${count} 条`).join("、");
    log(`⚠️ 有 ${orphanEntries.reduce((sum, [, count]) => sum + count, 0)} 条带链接答案找不到对应账号（${detail}）。请到「比特环境」页配置「账号题材绑定」，把每个账号绑定到一个题材。`);
  }
  log(`提交逻辑：每账号提交 ${accountDailyLimit > 0 ? accountDailyLimit : "不限"} 条后轮换；打开题目链接、填入回答、点击提交。`);

  // 只在真要开窗口时才检查比特（真正的检查在下面的窗口分支里）

  // 被动探针：记录"提交回答"真实发出的写请求，为提交纯协议化提供依据。
  // 过滤掉打点/统计类噪声，只留 zhidao 域的 POST/PUT，并把 postData 开头一并留下
  //（里面能看到接口路径和必填字段名）。零额外成本 —— 每次提交顺手留证据。
  const sniffSubmit = (page) => {
    page.on("request", (req) => {
      const url = req.url();
      if (!/zhidao[.]baidu[.]com/.test(url)) return;
      if (req.method() !== "POST" && req.method() !== "PUT") return;
      if (/[\/](log|report|abdr|track|stats|monitor)/i.test(url)) return;
      log(`【提交请求形态】${req.method()} ${url.split("?")[0]}`);
      const h = req.headers() || {};
      const keep = ["content-type", "referer", "origin", "x-requested-with", "tbs", "token"];
      log(`  headers: ${keep.map((k) => k + "=" + String(h[k] || "-").slice(0, 110)).join(" | ")}`);
      log(`  cookieLen: ${String(h.cookie || "").length}（只记长度）`);
      log(`  postData: ${String(req.postData() || "").slice(0, 500).replace(/[\r\n]+/g, " ")}`);
    });
  };
  let successCount = 0;
  let failCount = 0;
  let processed = 0;
  const results = [];
  const lastSuccessByEnv = {}; // envLabel -> 最近一次成功时的全局成功数（用于连续失败判定）

  for (const slot of allocation) {
    if (ctx.shouldStop() || !slot.rows.length) continue;
    const envLabel = slot.envLabel;
    let browser = null;
    try {
      // ★ 纯协议优先：该账号在「网盘管理」里存过 Cookie 就直接走 HTTP 提交，**不开窗口**。
      // 依据是实测：POST /msubmit/answer + `X-ik-token` 即可，不需要浏览器。
      // 没存过 Cookie 才回落到比特窗口（保留指纹隔离那条路）。
      const cred = typeof deps.credentialOf === "function" ? deps.credentialOf(envLabel) : null;
      // 只有「纯协议」模式才走这里。模式由用户在设置页选，软件不替他决定 ——
      // 要比特的指纹隔离，就得让任务开窗口（选 bit / headless）。
      const _mode = String((config && config.load && config.load().browserMode) || "protocol");
      if (_mode === "protocol" && cred && cred.bduss) {
        // 注意：只需 zhidao 域那一份。把全量跨域 Cookie 拼一起会因同名冲突冲掉登录态。
        const cookie = `BDUSS=${cred.bduss}${cred.stoken ? "; STOKEN=" + cred.stoken : ""}`;
        const dispatcher = typeof deps.proxyOf === "function" ? deps.proxyOf(envLabel) : undefined;
        const tk = await protocolSubmit.fetchSubmitToken(cookie, { dispatcher });
        if (tk.ok) {
          log(`【纯协议】${envLabel}（${tk.userName || "?"}）—— 不走窗口`);
          for (const item of slot.rows) {
            if (ctx.shouldStop()) break;
            await ctx.pausePoint?.("提交·条间检查点");
            processed += 1;
            ctx.report({ done: successCount + failCount, total: totalPlanned, status: "running" });
            const qid = protocolSubmit.qidOf(item.questionUrl) || String(item.qid || "");
            const r = await protocolSubmit.submitAnswer({ qid, content: item.answer, cookie, token: tk.token, dispatcher });
            if (r.ok) {
              successCount += 1;
              const submitted = { ...item, bitEnv: envLabel, status: "已提交", confirmed: true, aid: r.aid, submittedAt: nowText() };
              store.upsertAnswer(submitted);
              results.push(submitted);
              if (deps.autosavePath) {
                try { excel.appendCsvRow(deps.autosavePath, excel.answerToRow(submitted), excel.ANSWER_HEADERS); }
                catch (csvErr) { log(`⚠️ CSV 兜底写入失败（${csvErr.message}）—— 进程若异常退出，这条记录可能丢失。`); }
              }
              // **必须写回来源表格**：窗口路径一直有这一步，协议路径我漏了。
              // 少了它，表格里的状态永远停在"未提交"，下一轮「跳过已提交」读到旧状态
              // → **整表重复提交**。这是协议化时最容易漏掉的"收尾动作"。
              writeBackStatus(submitted);
              ctx.emitItem({ ...item, bitEnv: envLabel, status: "已提交" });
              log(`✅ ${processed}/${totalPlanned} 已提交：${item.title || qid}${r.aid ? "（aid=" + r.aid + "）" : ""}`);
            } else {
              failCount += 1;
              log(`✗ ${processed}/${totalPlanned} 提交失败：${item.title || qid} → ${r.reason}`);
            }
            await new Promise((res) => setTimeout(res, 800 + Math.random() * 700));
          }
          continue;
        }
        log(`纯协议不可用（${tk.reason}），本账号回落到窗口`);
      }
      await browserPool.adapter.checkConnection();   // 走到这里才需要比特
      log(`打开比特环境：${envLabel}（本账号 ${slot.rows.length} 条）`);
      const handle = await browserPool.acquire(envLabel);
      browser = await chromium.connectOverCDP(handle.cdpUrl);
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = await getWorkPage(context);
      sniffSubmit(page);
      page.setDefaultTimeout(config.timeoutMs);
      page.setDefaultNavigationTimeout(config.timeoutMs);

      for (const item of slot.rows) {
        if (ctx.shouldStop()) break;
        await ctx.pausePoint?.("提交·条间检查点");
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
          // 连续 3 次失败自动标记账号需人工检查（AccountManager 层拦截后续提交）
          if (deps.accountManager && failCount - lastSuccessByEnv[envLabel] >= 3 && lastSuccessByEnv[envLabel] !== undefined) {
            if (deps.accountManager) {
              deps.accountManager.markBlocked(envLabel, `连续 ${failCount - lastSuccessByEnv[envLabel]} 次提交失败`);
              if (deps.emitEvent) deps.emitEvent("account.blocked", { account: envLabel, reason: `连续 ${failCount - lastSuccessByEnv[envLabel]} 次提交失败` });
            }
            log(`⚠️ 账号 ${envLabel} 已连续多次失败，已标记需人工检查，本轮跳过该账号。`);
            break;
          }
        }
        lastSuccessByEnv[envLabel] = successCount;
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
      // 必须传日志回调：表格被 Excel 占用时 writeWorkbookSafe 会另存备份，
      // 不提示的话原表状态永远停在"已生成"，而下一轮去重读的正是原表 → 整表重复提交。
      excel.writeWorkbookSafe(filePath, rows.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS,
        (message) => log(message));
      pendingWriteBack.clear();
    } catch (error) {
      log(`写回表格状态失败（不影响提交记录）：${error.message}`);
    }
  }
}

module.exports = { runSubmitTask };
