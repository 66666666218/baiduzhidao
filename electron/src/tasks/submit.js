"use strict";

const { chromium } = require("playwright-core");
const protocolSubmit = require("../zhidao/protocol-submit");
const zhidao = require("../pages/zhidao");
const { nowText } = require("../config");
const { credentialHint } = require("../netdisk/manager");
const { getWorkPage } = require("./crawl");
const { buildAllocation, runWithConcurrency, accountConcurrencyOf } = require("../domain/account-topic");
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
  // 写回表格 = "读整个 xlsx → 改状态列 → 写回去"。开了账号并发后，两个 worker 可能
  // **同时**通过那个 5 秒节流（判断与写入之间夹着 await），一起改同一个文件 → 表格损坏。
  // 用一条 Promise 链把落盘串起来：同一时刻只有一个写回在跑。
  let writeBackChain = Promise.resolve();
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

  // 质检结论：生成阶段判完会把它写进表格的「质检」列（`READY(分)` / `REVIEW(分)：原因`）。
  // 这件事的意义在于——**无人值守时没人会去看生成阶段的日志**，而一键全自动跑完就直接进提交了。
  // 以前这里连读都不读（importRowToAnswer 根本没解析「质检」列），判为需复核的答案被当正常答案投出去，
  // 用户完全不知道。现在：条数和原因一定报出来；勾了「跳过质检为需复核的答案」才真的不提交。
  // 用 startsWith 而不是正则：契约⑥ 的静态守卫会把 `/^REVIEW/i` 里的 `i.test(` 当成
  // "调用了一个叫 i 的函数"而误报（它不解析正则字面量）。这里本来也不需要正则。
  const isReview = (row) => String(row.quality || "").trim().toUpperCase().startsWith("REVIEW");
  const skipReview = Boolean(config && typeof config.load === "function" && config.load().skipReviewAnswers);
  const reviewRows = candidateRows.filter(isReview);
  if (reviewRows.length) {
    const brief = (row) => {
      const reason = String(row.quality || "").replace(/^REVIEW\(\d+\)\s*[：:]?\s*/, "").trim();
      return `${String(row.title || row.questionUrl || "").slice(0, 24)}${reason ? `（${reason.slice(0, 40)}）` : ""}`;
    };
    const shown = reviewRows.slice(0, 3).map(brief).join("；");
    const more = reviewRows.length > 3 ? ` …共 ${reviewRows.length} 条` : "";
    if (skipReview) {
      log(`已按设置跳过 ${reviewRows.length} 条「质检判为需复核」的答案：${shown}${more}`);
    } else {
      log(`⚠️ 本次待提交的答案里有 ${reviewRows.length} 条被质检判为「需复核」：${shown}${more}`);
      log("   它们仍会照常提交（质检只是提醒）。想跳过这些答案，请在设置页勾选「跳过质检为需复核的答案」。");
    }
  }
  const submittableRows = skipReview ? candidateRows.filter((row) => !isReview(row)) : candidateRows;
  if (!submittableRows.length) {
    log("待提交的答案全部被质检判为需复核，已按设置跳过，本次无需提交。");
    return { stopped: false, count: 0, failed: 0, total: 0, results: [] };
  }

  // 与 crawl.js 同样先校验形状：传成字符串时 .map 会抛 TypeError，任务只报"未知错误"
  const rawEnvs = Array.isArray(ctx.payload.bitEnvs) ? ctx.payload.bitEnvs : [];
  const bitEnvs = rawEnvs.map((env) => (env && typeof env === "object" ? env.label : env) || "").filter(Boolean);
  if (!bitEnvs.length) throw new Error("请先填写至少一个比特浏览器环境名称。");

  const submitLimit = Math.max(0, Number(ctx.payload.submitLimit) || 0);
  const dailyLimit = Math.max(0, Number(ctx.payload.dailyAnswerLimit) || 0);
  let rows = submitLimit > 0 ? submittableRows.slice(0, submitLimit) : submittableRows;
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
  // 每个账号"一条都没处理"就失败的记录（见下面的收尾判据）。
  // 必须用**本账号自己的**尝试计数，不能用全局 processed —— 并发 >1 时别的账号会把它推着走。
  const slotErrors = [];
  // 每账号的连续失败计数。**必须是 per-env**：
  // 以前用的是 `failCount - lastSuccessByEnv[envLabel]` —— 两边都是**全局**计数，
  // 于是账号 A 的失败会算进账号 B 的"连续失败"，把好账号误熔断。
  // 而且旧判据要求 `lastSuccessByEnv[envLabel] !== undefined`（得先成功过一次），
  // 导致**首次就连败的账号永远不熔断** —— 正好漏掉了最该拦的那种。
  const failStreakByEnv = {};   // envLabel -> 连续失败次数
  const FAIL_STREAK_LIMIT = 3;  // 连续失败到这个数就标记账号需人工检查

  /**
   * 一条提交失败后的**统一**处理：计数、上报、连续失败熔断。
   *
   * 为什么必须抽出来共用：这段逻辑以前只写在**窗口分支**里，而软件的默认模式是**纯协议** ——
   * 于是"连续 3 次失败自动标记账号需人工检查"这条安全网，在最常用的那条路径上**根本不存在**：
   * Cookie 失效的账号会被一路刷完整个任务列表，每条都失败，跑完也不留任何标记。
   * （同一个功能在两份分支里各写一半，是这个仓库反复出问题的一类原因。）
   *
   * @returns {boolean} true = 该账号已被熔断，调用方应停止处理它剩余的条目
   */
  function noteSubmitFailure(item, envLabel, reason) {
    failCount += 1;
    const failedItem = { ...item, bitEnv: envLabel, status: `提交失败：${reason}` };
    results.push(failedItem);
    ctx.emitItem(failedItem);
    log(`✗ ${processed}/${totalPlanned} 提交失败：${item.title || item.questionUrl} → ${reason}`);

    failStreakByEnv[envLabel] = (failStreakByEnv[envLabel] || 0) + 1;
    if (failStreakByEnv[envLabel] < FAIL_STREAK_LIMIT) return false;

    const why = `连续 ${failStreakByEnv[envLabel]} 次提交失败`;
    accountManager.markBlocked(envLabel, why);
    if (deps.emitEvent) deps.emitEvent("account.blocked", { account: envLabel, reason: why });
    log(`⚠️ 账号 ${envLabel} 已${why}，已标记为需人工检查：本次运行与同一进程内的后续运行都会跳过它`
      + `（重启软件可清除标记）。先到「账号凭证」页确认它的 Cookie 是否还有效。`);
    return true;
  }

  // ★ 账号并发：多个账号同时跑。默认 1（顺序执行），用户可在设置页调高。
  // 开并发前的两个前提已经在本文件里收拢了：写回表格加锁（writeBackStatus 队列）、
  // 各计数都是单线程内同步自增 —— 否则并发会直接把表格写坏。
  const concurrency = accountConcurrencyOf(config);
  if (concurrency > 1) {
    log(`⚠️ 账号并发已开启：同时跑 ${concurrency} 个账号。`);
    log("   请确认：① 每个账号有不同的出口 IP（在「账号凭证」页填「账号代理」）；同一个 IP 并发多个号，风控概率显著上升。");
    log("   ② 若用比特模式，需要把这些账号的比特窗口都留着并保证内存够；纯协议模式不占窗口。");
    log("   ③ 稳妥做法是先跑 2 个账号看一天，没问题再加。");
  }
  await runWithConcurrency(allocation, concurrency, async (slot) => {
    if (ctx.shouldStop() || !slot.rows.length) return;
    const envLabel = slot.envLabel;
    let browser = null;
    let slotAttempted = 0;   // 本账号尝试过的条数（用于判断"是不是根本没起来"）
    try {
      // ★ 纯协议优先：该账号在「账号凭证」里存过 Cookie 就直接走 HTTP 提交，**不开窗口**。
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
            slotAttempted += 1;
            ctx.report({ done: successCount + failCount, total: totalPlanned, status: "running" });
            const qid = protocolSubmit.qidOf(item.questionUrl) || String(item.qid || "");
            const r = await protocolSubmit.submitAnswer({ qid, content: item.answer, cookie, token: tk.token, dispatcher });
            if (r.ok) {
              successCount += 1;
              // 成功一条就清掉**这个账号自己**的连败计数（与窗口分支同一语义）。
              // 少了这一行，计数会在默认的协议分支里一路累加 —— 于是"连续 3 次失败"变成
              // "累计 3 次失败"：一个大部分都成功、只是偶尔失败的账号也会被熔断。
              failStreakByEnv[envLabel] = 0;
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
              if (noteSubmitFailure(item, envLabel, r.reason)) break;
            }
            await new Promise((res) => setTimeout(res, 800 + Math.random() * 700));
          }
          return;
        }
        log(`纯协议不可用（${tk.reason}），本账号回落到窗口`);
        log(`   ${credentialHint(deps.dataDir, envLabel)}`);
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
        slotAttempted += 1;
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
          // 成功一条就清掉**这个账号自己**的连败计数。
          // ⚠️ 这一行原来写在 try/catch 的**外面** —— 于是失败路径走完 catch 也会执行到它，
          // 连败计数永远回到 0，"连续 3 次失败熔断"数学上不可能触发（这是第二处：
          // 第一处是默认的协议分支里压根没写熔断）。必须放在成功路径里。
          failStreakByEnv[envLabel] = 0;
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
          // 与纯协议分支共用同一份失败处理（计数器、上报、熔断）——
          // 以前两边各写一半，默认的协议分支里连熔断都没有。
          if (noteSubmitFailure(item, envLabel, describeError(error))) break;
        }
        ctx.report({ done: successCount + failCount, total: totalPlanned, status: "running" });
        if (processed < totalPlanned && !ctx.shouldStop()) {
          await ctx.delay(config.delayMin, config.delayMax, "下一条提交间隔");
        }
      }
    } catch (error) {
      // 这个账号**一条都没处理**就挂了（最常见的：模式是纯协议但没存 Cookie，回落到比特
      // 又打不开窗口）。记下来，最后判断"是不是所有账号都没起来" —— 以前这里只 log 一句，
      // 任务以"提交成功 0 条"收尾，编排层据此把这一阶段记成**成功**。
      if (!slotAttempted) slotErrors.push({ env: envLabel, reason: describeError(error) });
      log(`比特环境 ${envLabel} 自动提交失败：${describeError(error)}`);
    } finally {
      await browser?.close?.().catch(() => {});
      await browserPool.release(envLabel, { close: config.closeAfter });
    }
    // 账号轮换之间同样保持随机间隔，降低集中操作特征
    if (ctx.shouldStop() === false) {
      await ctx.delay(config.delayMin, config.delayMax, "账号切换间隔");
    }
  });

  await writeBackStatus(null, true);   // 等队列排空，确保最后一次落盘真的写完

  const stopped = ctx.shouldStop();

  // 一个账号都没能开始提交 → 抛出去，别报"提交成功 0 条"。
  // 新电脑上最常见的一幕：模式是纯协议但没存过 Cookie，回落到比特又打不开窗口。
  // 以前这种情况任务会"正常完成"，编排层把它记成**阶段成功**，用户只看到一句"成功 0 条"。
  if (!stopped && slotErrors.length && !successCount && !failCount) {
    throw new Error(
      `所有账号都没能开始提交（${slotErrors.map((e) => `${e.env}：${e.reason}`).join("；")}）。`
      + "请到「账号凭证」页点「登录并提取」给这些账号存一份 Cookie —— 存过之后提交全程不需要开窗口。"
    );
  }

  ctx.report({ done: successCount + failCount, total: totalPlanned, status: stopped ? "stopped" : "done" });
  log(`${stopped ? "已停止" : "自动提交完成"}：成功 ${successCount} 条，失败 ${failCount} 条。`);
  return { stopped, count: successCount, failed: failCount, total: totalPlanned, results };

  /** 把提交状态写回来源表格（累积所有已提交行 + 节流 + 结束强制），保证"跳过已提交"读到最新状态 */
  function writeBackStatus(submitted, force = false) {
    if (!filePath) return writeBackChain;
    // 先同步登记这一条（登记不涉及 IO，天然并发安全），再排队真正落盘
    if (submitted) {
      const url = String(submitted.questionUrl || "").toLowerCase();
      if (url) pendingWriteBack.set(url, { submittedAt: submitted.submittedAt || "", confirmed: Boolean(submitted.confirmed) });
    }
    writeBackChain = writeBackChain.then(() => writeBackStatusNow(force)).catch(() => {});
    return writeBackChain;
  }

  /** 真正落盘的那一半（5 秒节流 + 读写 xlsx）。只应由 writeBackStatus 排队串行调用。 */
  function writeBackStatusNow(force = false) {
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
      // writeWorkbookSafe 在**原表被 Excel 占用**时不会抛错，而是把内容写进
      // 「xxx_备份_<时间戳>.xlsx」并把**那个路径**返回。以前这里完全忽略返回值，
      // 紧接着无条件 clear() —— 等于"写没写进原表"根本没判断，却把状态当成已落盘丢掉了。
      // 后果：原表状态一直停在「已生成回答」，下一轮对同一张表再跑提交时去重读的正是原表
      //（candidateRows 只看表格 status 列）→ 已提交的题被整表重复提交。
      // 所以：只有**确实写进了原表**才清空；写进备份的留着，等下一轮（或用户关掉 Excel 后）
      // 再试，并把这件事说成一句能照做的话。
      const writtenTo = excel.writeWorkbookSafe(filePath, rows.map(excel.answerToRow), "随机抽题", excel.ANSWER_HEADERS,
        (message) => log(message));
      if (writtenTo === filePath) {
        pendingWriteBack.clear();
      } else {
        log(`⚠️ 状态没能写回原表（写进了备份：${writtenTo}）。原表里这些行仍会显示「未提交」，`
          + `**请关掉 Excel/WPS 后重跑一次提交**，否则下一轮会把它们当没提交过而重复提交。`);
      }
    } catch (error) {
      log(`写回表格状态失败（不影响提交记录）：${error.message}`);
    }
  }
}

module.exports = { runSubmitTask };
