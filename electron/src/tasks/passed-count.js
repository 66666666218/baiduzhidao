"use strict";

const { chromium } = require("playwright-core");
const zhidao = require("../pages/zhidao");
const { getWorkPage } = require("./crawl");

const WB = "https://zhidao.baidu.com";
const PROGRESS_API = "/qa/api/activity/anniversary21/answer-progress";

/**
 * 纯协议取「当天答题通过数」。成功返回 {done,total}，拿不到返回 null。
 * 接口是活动页自己在用的那个，实测关掉浏览器后 fetch 依然 200 ——
 * 也就是说这个数字**本来就不需要开窗口**。
 */
async function fetchProgressByProtocol(cookie, { fetchImpl = fetch, timeoutMs = 12000, dispatcher } = {}) {
  try {
    const res = await fetchImpl(WB + PROGRESS_API, {
      headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0", Referer: `${WB}/b/batch/batch-upload`, "X-Requested-With": "XMLHttpRequest" },
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      dispatcher,
    });
    const text = await res.text();
    const json = JSON.parse(text);
    if (Number(json.code) !== 200 || !json.data) return null;
    const done = Number(json.data.valid_answer_count) || 0;
    // 当前所处档位的门槛就是"分母"；没有档位信息时退化成 0（调用方按 unknown 处理）
    const total = Number((json.data.next_tier && json.data.next_tier.threshold) || 0) || 0;
    return { done, total };
  } catch {
    return null;
  }
}

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
      // ★ 纯协议优先：存过 Cookie 就直接问接口，不开窗口。
      const cred = typeof deps.credentialOf === "function" ? deps.credentialOf(envLabel) : null;
      if (cred && cred.bduss) {
        const cookie = `BDUSS=${cred.bduss}${cred.stoken ? "; STOKEN=" + cred.stoken : ""}`;
        const dispatcher = typeof deps.proxyOf === "function" ? deps.proxyOf(envLabel) : undefined;
        const got = await fetchProgressByProtocol(cookie, { dispatcher });
        if (got) {
          const account = {
            bitEnv: envLabel,
            status: got.total > 0 ? (got.done >= got.total ? "completed" : "partial") : "partial",
            done: got.done,
            total: got.total,
            format: "quota",
            source: "protocol",
            raw: [],
          };
          accounts.push(account);
          log(`【纯协议】${envLabel}：${got.total > 0 ? `${got.done}/${got.total}` : `已通过 ${got.done} 条`}`);
          continue;
        }
        log(`${envLabel} 纯协议取数失败，回落到窗口`);
      }
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

module.exports = { runPassedCountTask, fetchProgressByProtocol };
