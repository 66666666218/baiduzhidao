"use strict";

const { chromium } = require("playwright-core");
const zhidao = require("../pages/zhidao");
const { getWorkPage } = require("./crawl");

const http = require("../zhidao/http");
const PROGRESS_API = "/qa/api/activity/anniversary21/answer-progress";
// 活动页地址：这个接口属于活动页，Referer 必须是它。
// 以前这里写的是 batch-upload 页 —— 语义错配；UA 更是裸 `Mozilla/5.0`（强机器人特征）。
const ACT_PAGE = `${http.HOST}/hd/21th_activity/`;

/**
 * 纯协议取「当天答题通过数」。成功返回 {done,total}，拿不到返回 null。
 * 接口是活动页自己在用的那个，实测关掉浏览器后 fetch 依然 200 ——
 * 也就是说这个数字**本来就不需要开窗口**。
 */
async function fetchProgressByProtocol(cookie, { fetchImpl, timeoutMs = 12000, dispatcher } = {}) {
  // 走公共底座：统一 UA / 超时 / 退避重试（以前一次网络抖动就静默返回 null，
  // 调用方只能"回落到窗口"——为读一个数字白开一份 Chromium）。
  const r = await http.requestJson(PROGRESS_API, { cookie, referer: ACT_PAGE, dispatcher, timeoutMs, retries: 2, fetchImpl });
  if (!r.ok) return { ok: false, reason: r.reason };
  const json = r.json || {};
  if (Number(json.code) !== 200 || !json.data) return { ok: false, reason: `code=${json.code} ${json.msg || ""}` };
  const done = Number(json.data.valid_answer_count) || 0;
  // 当前所处档位的门槛就是"分母"；没有档位信息时退化成 0（调用方按 unknown 处理）
  const total = Number((json.data.next_tier && json.data.next_tier.threshold) || 0) || 0;
  return { ok: true, done, total, reason: "" };
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

  // 只在真要开窗口时才检查比特（真正的检查在下面的窗口分支里）
  const accounts = [];
  let browser = null;

  for (const envLabel of bitEnvs) {
    if (ctx.shouldStop()) break;
    try {
      log(`读取 ${envLabel} 的当天通过数...`);
      // ★ 纯协议优先：存过 Cookie 就直接问接口，不开窗口。
      const cred = typeof deps.credentialOf === "function" ? deps.credentialOf(envLabel) : null;
      // 只有「纯协议」模式才走这里。模式由用户在设置页选，软件不替他决定 ——
      // 要比特的指纹隔离，就得让任务开窗口（选 bit / headless）。
      const _mode = String((config && config.load && config.load().browserMode) || "protocol");
      if (_mode === "protocol" && cred && cred.bduss) {
        const cookie = `BDUSS=${cred.bduss}${cred.stoken ? "; STOKEN=" + cred.stoken : ""}`;
        const dispatcher = typeof deps.proxyOf === "function" ? deps.proxyOf(envLabel) : undefined;
        const got = await fetchProgressByProtocol(cookie, { dispatcher });
        if (got.ok) {
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
        log(`${envLabel} 纯协议取数失败（${got.reason}），回落到窗口`);
      }
      await browserPool.adapter.checkConnection();   // 走到这里才需要比特
      const handle = await browserPool.acquire(envLabel).catch((err) => {
        throw new Error(`${envLabel}：既没有已保存的 Cookie，比特窗口也打不开（${err.message}）。`
          + `请到「账号凭证」页点「登录并提取」存一份 Cookie。`);
      });
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
