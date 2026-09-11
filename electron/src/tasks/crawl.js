"use strict";

const path = require("path");
const { chromium } = require("playwright-core");
const { SEL } = require("../pages/selectors");
const zhidao = require("../pages/zhidao");
const { nowText } = require("../config");
const excel = require("../storage/excel");
const { describeError } = require("../errors");

/**
 * 爬题任务：进入答题区 → 锁定分类 → 逐页逐题打开 → 记录标题+链接入库。
 * 只保存标题与链接，不生成回答。
 */
async function runCrawlTask(ctx, deps) {
  const { browserPool, store, config, log } = deps;
  const payload = ctx.payload;
  const bitEnvs = (payload.bitEnvs || []).map((env) => env.label || env);
  if (!bitEnvs.length) throw new Error("请先填写至少一个比特浏览器环境名称。");

  const category = payload.category || SEL.category.labels[0];
  const startPage = Math.max(1, Number(payload.crawlStartPage) || 1);
  const seenKeys = new Set();
  let doneCount = 0;
  let duplicateSkipped = 0;

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
  await adapter.checkConnection();

  for (const envLabel of bitEnvs) {
    if (ctx.shouldStop()) break;
    let browser = null;
    try {
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
      while (!ctx.shouldStop()) {
        await zhidao.enterAnswerZone(page, { onLog: log });
        await zhidao.ensureListPage(page, currentPage, { onLog: log });

        let newCount = 0;
        while (!ctx.shouldStop()) {
          const opened = await zhidao.openNextQuestion(page, seenKeys, { onLog: log });
          if (!opened) break;
          const questionPage = opened.questionPage;
          questionPage.setDefaultTimeout(config.timeoutMs);
          questionPage.setDefaultNavigationTimeout(config.timeoutMs);
          await zhidao.waitForBaiduReady(questionPage, config.verifyWaitSeconds, { onLog: log });
          const pageTitle = await zhidao.readQuestionTitle(questionPage).catch(() => "");
          const title = zhidao.normalizeTitle(pageTitle || opened.listTitle);
          const questionUrl = questionPage.url();

          // 脏数据防护：弹窗被拦时会停留在活动页，此时标题/链接都不是题目，跳过不入库
          const isActivityUrl = /\/hd\/|activity/i.test(questionUrl);
          if (!title || isActivityUrl || !zhidao.titlesMatch(opened.listTitle, title)) {
            duplicateSkipped += 1;
            log(`跳过无效题目页（${!title ? "无标题" : isActivityUrl ? "仍在活动页，弹窗可能被拦截" : "标题不匹配"}）：${opened.listTitle}`);
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

        // 记录断点：本页已处理完
        store.setEnvPage(`${envLabel}:${category}`, currentPage);

        ctx.report({ done: doneCount, total: totalPages ? Math.max(doneCount, (totalPages - startPage + 1) * 6) : 0, status: "running" });
        log(`第 ${currentPage} 页新增 ${newCount} 条，本次累计 ${doneCount} 条。`);
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

  store.flushAll();

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
      await activityPage.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(async () => {
        await zhidao.safeGoto(activityPage, activityPage.url());
      });
      await activityPage.waitForTimeout(1500).catch(() => {});
    }
  } catch {
    // 页面状态异常不中断任务
  }
  return activityPage;
}

module.exports = { runCrawlTask, getWorkPage, keepQuestionOpen };
