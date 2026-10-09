"use strict";

const path = require("path");
const { chromium } = require("playwright-core");
const { SEL } = require("../pages/selectors");
const zhidao = require("../pages/zhidao");
const { nowText } = require("../config");
const excel = require("../storage/excel");
const { describeError } = require("../errors");
const protocolCrawl = require("../zhidao/protocol-crawl");

/**
 * 爬题任务：进入答题区 → 锁定分类 → 逐页逐题打开 → 记录标题+链接入库。
 * 只保存标题与链接，不生成回答。
 */
async function runCrawlTask(ctx, deps) {
  const { browserPool, store, config, log } = deps;
  const payload = ctx.payload;
  // 环境名允许传字符串或 {label}，但非数组/空对象要挡掉：
  // 之前 payload.bitEnvs 是字符串时 .map 直接 TypeError，任务以"【未知】"失败且看不出原因。
  const bitEnvs = (Array.isArray(payload.bitEnvs) ? payload.bitEnvs : [])
    .map((env) => (env && env.label) || env)
    .filter((env) => typeof env === "string" && env.trim())
    .map((env) => env.trim());
  if (!bitEnvs.length) throw new Error("请先填写至少一个比特浏览器环境名称。");

  const category = payload.category || SEL.category.labels[0];
  const startPage = Math.max(1, Number(payload.crawlStartPage) || 1);
  // 「任务总量上限」：本次最多新增多少道题。0 = 不限。
  // 注意口径是**每个分类各算一次**——一键全自动会逐分类各跑一次爬题，
  // 所以四个分类都跑时，总上限 = 4 × 这个值。
  const maxQuestions = Math.max(0, Number(payload.maxQuestions) || 0);
  const seenKeys = new Set();
  let doneCount = 0;
  let duplicateSkipped = 0;
  if (maxQuestions > 0) log(`本次最多新增 ${maxQuestions} 道题（「任务总量上限」）。`);

  // 预载题库去重：同分类已入库的题不再重复打开
  const bank = store.loadBank();
  for (const item of bank) {
    if (item.category && item.category !== category) continue;
    if (item.title) seenKeys.add(zhidao.listKey(item.title));
  }
  if (seenKeys.size) log(`题库已有“${category}”相关题目 ${seenKeys.size} 条，将自动跳过。`);

  const crawlOutputDir = String(payload.crawlOutputDir || "").trim().replace(/^"|"$/g, "");
  log(`准备爬取“${category}”全部题目（起始页 ${startPage}），只保存标题和链接。`);
  const adapter = browserPool.adapter;
  // 只在**真要开窗口**时才检查比特客户端是否在线（真正的检查挪到下面窗口分支里）。
  // 以前这句无条件执行，于是"纯协议模式"仍然隐含"比特客户端必须开着"——
  // 用户按界面说的把比特关掉，第一步就失败，而错误只说"请先打开比特浏览器"。

  // **爬题故意不加账号并发**（其他任务都有）：题目列表接口返回的是"这个分类下的题"，
  // 与用哪个账号问无关 —— N 个账号并发爬只会拿到 N 份一样的列表，全部撞去重，
  // 反而徒增请求量。多账号在这里的正确用法是**兜底**：第一个账号拿不到就换下一个。
  for (const envLabel of bitEnvs) {
    if (ctx.shouldStop()) break;
    let browser = null;
    try {
      // ★ 纯协议优先：存过 Cookie 的账号直接拉题目列表接口，**不开窗口**。
      // 接口是活动页自己的 XHR（见 protocol-crawl.js 的注释）。
      const cred = typeof deps.credentialOf === "function" ? deps.credentialOf(envLabel) : null;
      // 只有「纯协议」模式才走这里。模式由用户在设置页选，软件不替他决定 ——
      // 要比特的指纹隔离，就得让任务开窗口（选 bit / headless）。
      const _mode = String((config && config.load && config.load().browserMode) || "protocol");
      if (_mode === "protocol" && cred && cred.bduss) {
        const cookie = `BDUSS=${cred.bduss}${cred.stoken ? "; STOKEN=" + cred.stoken : ""}`;
        const dispatcher = typeof deps.proxyOf === "function" ? deps.proxyOf(envLabel) : undefined;
        const PAGE_SIZE = 20;
        let added = 0;
        let base = (startPage - 1) * PAGE_SIZE;
        let empty = 0;
        log(`【纯协议】${envLabel} 爬取「${category}」（不走窗口）`);
        while (!ctx.shouldStop()) {
          const got = await protocolCrawl.fetchQuestionPage({ cookie, category, base, rn: PAGE_SIZE, dispatcher });
          if (!got.ok) { log(`纯协议爬题失败：${got.reason}`); break; }
          if (!got.rows.length) { empty += 1; if (empty >= 2) break; base += PAGE_SIZE; continue; }
          empty = 0;
          let fresh = 0;
          for (const row of got.rows) {
            if (ctx.shouldStop()) break;
            if (maxQuestions > 0 && added >= maxQuestions) break;
            const key = zhidao.listKey(row.title);
            if (!key || seenKeys.has(key)) { duplicateSkipped += 1; continue; }
            seenKeys.add(key);
            store.addBankQuestion({
              category,
              title: row.title,
              questionContent: row.questionContent,
              questionUrl: row.questionUrl,
              bitEnv: envLabel,
              status: "已采集",
              createdAt: nowText(),
            });
            added += 1;
            fresh += 1;
            doneCount += 1;
            ctx.emitItem({ title: row.title, status: "已采集", bitEnv: envLabel });
            ctx.report({ done: doneCount, total: maxQuestions || 0, status: "running" });
          }
          log(`第 ${Math.floor(base / PAGE_SIZE) + 1} 页新增 ${fresh} 条，本次累计 ${added} 条。`);
          if (maxQuestions > 0 && added >= maxQuestions) break;
          if (fresh === 0) { empty += 1; if (empty >= 2) break; }
          base += PAGE_SIZE;
          await new Promise((res) => setTimeout(res, 800));
        }
        log(`${envLabel} 纯协议爬题完成：新增 ${added} 条（重复跳过 ${duplicateSkipped} 条）。`);
        // 记断点。注意真实 API 是 setEnvPage —— 我之前写的是 setEnvProgress（不存在），
        // 加了可选链所以没报错，但进度一直没写进去，等于断点续爬形同虚设。
        store.setEnvPage(`${envLabel}:${category}`, Math.floor(base / PAGE_SIZE) + 1);
        continue;
      }
      await adapter.checkConnection();   // 走到这里才需要比特
      log(`打开比特环境：${envLabel}`);
      const handle = await browserPool.acquire(envLabel);
      browser = await chromium.connectOverCDP(handle.cdpUrl);
      const context = browser.contexts()[0] || (await browser.newContext());
      let page = await getWorkPage(context);
      page.setDefaultTimeout(config.timeoutMs);
      page.setDefaultNavigationTimeout(config.timeoutMs);

      await zhidao.safeGoto(page, config.resolveActivityUrl());
      await zhidao.waitForBaiduReady(page, config.verifyWaitSeconds, { onLog: log });
      await zhidao.enterAnswerZone(page, { onLog: log });
      await zhidao.selectCategory(page, category, { onLog: log });

      // 断点续爬：勾选 resume 时从该环境上次完成的页继续（忽略起始页输入）
      const envProgress = store.getEnvProgress(`${envLabel}:${category}`);
      let currentPage = payload.resume
        ? Math.max(1, Number(envProgress.lastPage) || 1)
        : startPage;
      if (payload.resume && envProgress.lastPage > 1) {
        log(`续爬：从上次完成的第 ${currentPage} 页继续（重复题会自动跳过）。`);
      }
      let totalPages = await zhidao.getTotalListPages(page);
      // 连续多少页一条新题都没有就收工：分页按钮可见≠还能翻页（真实站点常用 class 而不是
      // disabled 表示末页），此时 clickNextPage 会一直返回 true，while 就成了不终止的死循环。
      // 取 10 而不是 3：整页题都答过在续爬时是正常现象，阈值太紧会把没爬完的页提前砍掉。
      const EMPTY_PAGE_LIMIT = 10;
      let emptyStreak = 0;
      while (!ctx.shouldStop()) {
        // 自愈：被甩到登录/验证页时回到活动页（连续快速导航偶发触发风控软校验）
        if (/passport\.baidu\.com|wappass/i.test(page.url())) {
          log("检测到登录重定向，回到活动页继续。");
          await zhidao.safeGoto(page, config.resolveActivityUrl());
          await zhidao.waitForBaiduReady(page, config.verifyWaitSeconds, { onLog: log });
        }
        await zhidao.enterAnswerZone(page, { onLog: log });
        const onRightPage = await zhidao.ensureListPage(page, currentPage, { onLog: log });

        let newCount = 0;
        while (!ctx.shouldStop()) {
          // 总量上限：按「本次新增题数」计（doneCount 只在新题入库时 +1）。
          // 以前这个设置在界面上有、代码里从没读过，于是爬题会一路爬到活动页最后一页
          // （实测 3760 页 ≈ 47 小时），用户设的「任务总量上限」形同虚设。
          if (maxQuestions > 0 && doneCount >= maxQuestions) break;
          await ctx.pausePoint?.("爬题·题间检查点");
          // 自愈：同页跳转返回后 SPA 状态可能丢失（答题区折叠/分类重置）
          // 优先轻量恢复（点击答题区标签），失败再整页重载
          if (!(await page.locator(SEL.zone.cards).first().isVisible({ timeout: 2000 }).catch(() => false))) {
            log("题卡不可见（同页跳转后状态丢失），恢复答题区状态...");
            let restored = true;
            try {
              await zhidao.enterAnswerZone(page, { onLog: log });
              await zhidao.selectCategory(page, category, { onLog: log });
              await zhidao.ensureListPage(page, currentPage, { onLog: log });
            } catch (lightError) {
              restored = false;
              log(`轻量恢复失败（${lightError.message.slice(0, 40)}），整页重载兜底...`);
            }
            if (!restored || !(await page.locator(SEL.zone.cards).first().isVisible({ timeout: 2000 }).catch(() => false))) {
              await zhidao.safeGoto(page, config.resolveActivityUrl());
              await zhidao.waitForBaiduReady(page, config.verifyWaitSeconds, { onLog: log });
              await zhidao.enterAnswerZone(page, { onLog: log });
              await zhidao.selectCategory(page, category, { onLog: log });
              await zhidao.ensureListPage(page, currentPage, { onLog: log });
            }
          }
          const opened = await zhidao.openNextQuestion(page, seenKeys, { onLog: log });
          if (!opened) break;
          // 打开的同时立刻占位，中间不夹任何 await：openNextQuestion 靠 seenKeys 挑卡，
          // 而它内部有 await；若等到读完标题才 add，另一个 worker 会在这段时间里重复点开同一张卡。
          // 这里先用列表标题占位（确定值），拿到真实标题后再补一份（题目页标题与列表标题
          // 未必逐字相同，两个都记才拦得住同一题被两条路径各抓一次）。
          if (opened.listTitle) seenKeys.add(zhidao.listKey(opened.listTitle));
          const questionPage = opened.questionPage;
          questionPage.setDefaultTimeout(config.timeoutMs);
          questionPage.setDefaultNavigationTimeout(config.timeoutMs);
          await zhidao.waitForBaiduReady(questionPage, config.verifyWaitSeconds, { onLog: log });
          const pageTitle = await zhidao.readQuestionTitle(questionPage).catch(() => "");
          const title = zhidao.normalizeTitle(pageTitle || opened.listTitle);
          const questionUrl = questionPage.url();

          // 脏数据防护：只看 pathname（真实题目 URL 带 ?activity=21th 参数，按整个 URL 判断会误杀）
          // 有效题目页 = zhidao.baidu.com/question/ 路径；活动页 = /hd/ 路径
          let isActivityUrl = false;
          try {
            const parsed = new URL(questionUrl);
            isActivityUrl = !/\/question\//.test(parsed.pathname) || /\/hd\//.test(parsed.pathname);
          } catch {
            isActivityUrl = true;
          }
          if (!title || isActivityUrl || !zhidao.titlesMatch(opened.listTitle, title)) {
            duplicateSkipped += 1;
            log(`跳过无效题目页（${!title ? "无标题" : isActivityUrl ? "仍在活动页，弹窗可能被拦截" : "标题不匹配"}）：${opened.listTitle}`);
            // 跳过也必须给这张卡占位：openNextQuestion 每次都从第 0 张卡重扫，只认 seenKeys，
            // 不占位就会把同一张坏卡无限点开→返回→再点开，整轮爬题原地打转。
            if (opened.listTitle) seenKeys.add(zhidao.listKey(opened.listTitle));
            page = await keepQuestionOpen(questionPage, page);
            continue;
          }

          seenKeys.add(zhidao.listKey(title));
          const item = {
            category,
            title,
            questionUrl,
            bitEnv: envLabel,
            status: "已爬取",
            createdAt: nowText(),
          };
          const bankResult = store.addBankQuestion(item);
          if (bankResult === "added") {
            doneCount += 1;
            newCount += 1;
            ctx.emitItem(item);
            log(`已获取题目地址：${title}`);
          }
          page = await keepQuestionOpen(questionPage, page);
        }

        // 免打开兜底：本页没有可点击的"去答题"时，直接从题卡 DOM 提取标题+链接
        const fallbackCards = await zhidao.collectQuestionCards(page);
        let fallbackCount = 0;
        for (const card of fallbackCards) {
          const title = zhidao.normalizeTitle(card.title);
          if (!title || seenKeys.has(zhidao.listKey(title)) || !card.questionUrl) continue;
          // 免打开通道是从题卡 DOM 里"猜"链接，比逐个打开更不可信：
          // 只要不是百度知道/本机模拟站的题目详情页地址就不入库，否则脏链接会一路带到提交阶段。
          if (!zhidao.isSafeQuestionUrl(card.questionUrl) || !/\/question\//i.test(card.questionUrl)) {
            log(`跳过可疑题链：${title} → ${card.questionUrl}`);
            continue;
          }
          seenKeys.add(zhidao.listKey(title));
          const item = {
            category,
            title,
            questionUrl: card.questionUrl,
            bitEnv: envLabel,
            status: "已爬取(免打开)",
            createdAt: nowText(),
          };
          if (store.addBankQuestion(item) === "added") {
            doneCount += 1;
            newCount += 1;
            fallbackCount += 1;
            ctx.emitItem(item);
          }
        }
        if (fallbackCount) log(`本页通过题卡直提取补收 ${fallbackCount} 条（未逐个打开）。`);

        // 记录断点：只有确认停在了预期的那一页才算处理完，否则断点会跳过没爬的页
        if (onRightPage) store.setEnvPage(`${envLabel}:${category}`, currentPage);
        else log(`第 ${currentPage} 页未确认到位，断点保持不变，本页结果仍入库。`);

        ctx.report({ done: doneCount, total: totalPages ? Math.max(doneCount, (totalPages - startPage + 1) * 6) : 0, status: "running" });
        log(`第 ${currentPage} 页新增 ${newCount} 条，本次累计 ${doneCount} 条。`);
        // 页码没切过去是最强的"到底了"信号，一次就抵五页空转
        if (maxQuestions > 0 && doneCount >= maxQuestions) {
          log(`已达「任务总量上限」${maxQuestions} 道题，停止爬取。`);
          break;
        }
        emptyStreak = newCount ? 0 : emptyStreak + (onRightPage ? 1 : 5);
        if (emptyStreak >= EMPTY_PAGE_LIMIT) {
          log(`连续 ${emptyStreak} 页没有新增题目，判定列表已到底或不再变化，停止翻页。`);
          break;
        }
        if (totalPages && currentPage >= totalPages) {
          log("已到最后一页，爬取结束。");
          break;
        }
        if (!(await zhidao.clickNextPage(page))) {
          log("没有识别到下一页按钮，爬取结束。");
          break;
        }
        currentPage += 1;
        const pageDelay = Math.max(0, Number(payload.pageDelayMs != null ? payload.pageDelayMs : config.pageDelayMs) || 0);
        if (pageDelay) await page.waitForTimeout(pageDelay).catch(() => {});
      }
      break; // 单个环境即可完成全量爬取
    } catch (error) {
      log(`比特环境 ${envLabel} 爬取失败：${describeError(error)}`);
    } finally {
      await browser?.close?.().catch(() => {});
      await browserPool.release(envLabel, { close: config.closeAfter });
    }
  }

  const writeFailed = store.flushAll();
  if (writeFailed.length) log(`⚠️ 题库没能落盘：${writeFailed.map((f) => `${f.name}（${f.error}）`).join("、")} —— 本轮爬到的题可能没保存。`);

  // 可选：把题库导出到自定义文件夹（UI 的"爬取结果文件夹"）
  if (crawlOutputDir) {
    try {
      const bankAll = store.loadBank();
      const xlsxPath = excel.uniqueFilePath(path.join(crawlOutputDir, `题库_${category}_${stamp()}.xlsx`));
      excel.writeWorkbookSafe(xlsxPath, bankAll.map(excel.bankToRow), "完整题库", excel.BANK_HEADERS, log);
      log(`题库已导出到：${xlsxPath}`);
    } catch (error) {
      log(`导出爬取结果失败：${error.message}`);
    }
  }

  const stopped = ctx.shouldStop();
  ctx.report({ done: doneCount, total: doneCount, status: stopped ? "stopped" : "done" });
  log(`${stopped ? "已停止" : "爬取完成"}：新增 ${doneCount} 道题${duplicateSkipped ? `，跳过无效/重复页面 ${duplicateSkipped} 次` : ""}。`);
  return { stopped, count: doneCount };
}

function stamp() {
  return nowText().replace(/[/: ]/g, "-").slice(0, 16);
}

async function getWorkPage(context) {
  const pages = context.pages();
  const ready = pages.find((page) => !page.url().startsWith("devtools"));
  return ready || (await context.newPage());
}

/** 处理完题目页后回到活动页；若题目是弹窗则关闭弹窗。 */
async function keepQuestionOpen(questionPage, activityPage) {
  try {
    if (questionPage !== activityPage) {
      await questionPage.close().catch(() => {});
      await activityPage.bringToFront().catch(() => {});
    } else {
      // goBack 的 load 事件在部分页面不触发（超时但导航已完成），按 URL 轮询确认返回
      await activityPage.goBack({ timeout: 4000 }).catch(() => {});
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && /\/question\//.test(activityPage.url())) {
        await activityPage.waitForTimeout(300).catch(() => {});
      }
      await activityPage.waitForTimeout(1200).catch(() => {});
    }
  } catch {
    // 页面状态异常不中断任务
  }
  return activityPage;
}

module.exports = { runCrawlTask, getWorkPage, keepQuestionOpen };
