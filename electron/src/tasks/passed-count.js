"use strict";

const { chromium } = require("playwright-core");
const zhidao = require("../pages/zhidao");
const { getWorkPage } = require("./crawl");

/**
 * 读取每个账号在活动页的“当天答题通过数”。
 * 逐个打开环境，滚动到账号进度区并解析 "x/y" 文本。
 */
async function runPassedCountTask(ctx, deps) {
  ctx.report({ done: 0, total: 1, status: "running" });
  const { browserPool, config, log } = deps;
  const rawEnvs = Array.isArray(ctx.payload.bitEnvs) ? ctx.payload.bitEnvs : [];
  const bitEnvs = rawEnvs.map((env) => (env && typeof env === "object" ? env.label : env) || "").filter(Boolean);
  if (!bitEnvs.length) throw new Error("请先填写至少一个比特浏览器环境名称。");

  await browserPool.adapter.checkConnection();
  const accounts = [];
  let browser = null;

  for (const envLabel of bitEnvs) {
    if (ctx.shouldStop()) break;
    try {
      log(`读取 ${envLabel} 的当天通过数...`);
      const handle = await browserPool.acquire(envLabel);
      browser = await chromium.connectOverCDP(handle.cdpUrl);
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = await getWorkPage(context);
      page.setDefaultTimeout(config.timeoutMs);

      await zhidao.safeGoto(page, config.resolveActivityUrl());
      await zhidao.waitForBaiduReady(page, config.verifyWaitSeconds, { onLog: log });
      const rows = await zhidao.readDailyPassed(page);
      // 配额型（x/y）优先；"已答N"格式无上限，不可判 completed
      const quotaRows = rows.filter((row) => (row.total || 0) > 0);
      const answeredOnly = rows.find((row) => row.format === "answered-only");
      const best = quotaRows.sort((a, b) => b.total - a.total)[0] || null;
      const account = {
        bitEnv: envLabel,
        status: best ? (best.done >= best.total ? "completed" : "partial") : answeredOnly ? "partial" : "unknown",
        done: best ? best.done : answeredOnly ? answeredOnly.done : 0,
        total: best ? best.total : 0,
        format: best ? "quota" : answeredOnly ? "answered-only" : "none",
        raw: rows.slice(0, 5),
      };
      accounts.push(account);
      log(`${envLabel}：${account.status === "completed" ? "已全部解锁" : best ? `${best.done}/${best.total}` : "未识别到进度文本"}`);
    } catch (error) {
      accounts.push({ bitEnv: envLabel, status: "error", error: error.message });
      log(`读取 ${envLabel} 失败：${error.message}`);
    } finally {
      await browser?.close?.().catch(() => {});
      browser = null;
      await browserPool.release(envLabel, { close: config.closeAfter });
    }
  }

  ctx.report({ done: 1, total: 1, status: "done" });
  return { stopped: ctx.shouldStop(), accounts };
}

module.exports = { runPassedCountTask };
