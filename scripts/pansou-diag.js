"use strict";

/**
 * pansou 单关键词诊断：截图 + 页面文本摘要，定位批量采集 0 条问题。
 * 用法：node scripts/pansou-diag.js [关键词=电子课本]
 */

const path = require("path");
const fs = require("fs");
const { launchHeadlessEdge } = require("../electron/src/edge-launcher");
const { chromium } = require("playwright-core");

const keyword = process.argv[2] || "电子课本";
const cacheDir = path.resolve(__dirname, "..", "运行缓存");

(async () => {
  const edge = await launchHeadlessEdge({});
  const browser = await chromium.connectOverCDP(edge.cdpUrl);
  const page = await browser.contexts()[0].newPage();

  console.log("[1] 打开 pansou.app");
  const resp = await page.goto("https://pansou.app", { waitUntil: "networkidle", timeout: 30000 }).catch((e) => `GOTO_FAIL:${e.message.slice(0, 60)}`);
  console.log("  goto 返回:", typeof resp === "string" ? resp : resp && resp.status());
  await page.waitForTimeout(2500);
  console.log("  URL:", page.url());
  console.log("  标题:", await page.title().catch(() => "?"));

  console.log("[2] 填入关键词并搜索");
  const inputCount = await page.locator("input:not([type=hidden]):not([type=checkbox])").count();
  console.log("  可见输入框数量:", inputCount);
  if (!inputCount) {
    await page.screenshot({ path: path.join(cacheDir, "pansou-diag.png") });
    console.log("  ⚠️ 没有输入框！已截图 pansou-diag.png");
    const text = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "");
    console.log("  页面文本前400字:", text.replace(/\n/g, " | "));
    edge.close();
    process.exit(2);
  }
  await page.locator("input:not([type=hidden]):not([type=checkbox])").first().fill(keyword);
  await page.keyboard.press("Enter");

  console.log("[3] 每 5 秒快照一次（共 30s）");
  for (let i = 1; i <= 6; i += 1) {
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const links = (text.match(/pan\.baidu\.com\/s\//g) || []).length;
    const searching = text.includes("搜索中") || text.includes("持续搜索");
    console.log(`  t+${i * 5}s: 百度链接 ${links} 个 | 搜索中=${searching} | 文本长度=${text.length}`);
    if (i === 3) await page.screenshot({ path: path.join(cacheDir, "pansou-diag.png") });
  }
  const finalText = await page.evaluate(() => document.body.innerText).catch(() => "");
  console.log("[4] 页面文本前600字:");
  console.log(finalText.slice(0, 600).replace(/\n/g, " | "));
  await page.screenshot({ path: path.join(cacheDir, "pansou-diag-final.png"), fullPage: false });

  edge.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 160)); process.exit(1); });
