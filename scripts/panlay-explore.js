"use strict";

/**
 * panlay.com 结构探测：连接持久会话浏览器，抓取工具页/搜索工具的
 * 页面清单、链接、表单结构，存 运行缓存/panlay-explore.json + 截图。
 * 用法：node scripts/panlay-explore.js
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");
const { launchHeadedEdge, portFile } = require("../electron/src/headed-edge-launcher");

const cacheDir = path.resolve(__dirname, "..", "运行缓存");

(async () => {
  const { cdpUrl } = await launchHeadedEdge({ onLog: (m) => console.log(m) });
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];

  let page = context.pages().find((p) => p.url().includes("panlay.com"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://panlay.com", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  }

  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (text.includes("欢迎登录")) {
    console.log("❌ 未登录（页面出现「欢迎登录」）。请先运行 node scripts/panlay-login.js 完成登录。");
    process.exit(2);
  }

  // 抓主导航与工具入口链接
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => ({ text: (a.innerText || "").trim().slice(0, 30), href: a.href }))
      .filter((l) => l.href && (l.href.includes("panlay") || l.href.startsWith("/")))
  );

  console.log(`当前页面: ${page.url()}`);
  console.log(`链接 ${links.length} 个:`);
  for (const l of links.slice(0, 40)) console.log(`  [${l.text}] ${l.href}`);

  // 工具卡片（含点击事件而非 <a> 的元素也一并抓 innerText）
  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[class*=card], [class*=tool], [class*=item]"))
      .map((el) => (el.innerText || "").trim().slice(0, 80))
      .filter((t) => t && t.length > 4)
  );
  const uniqCards = [...new Set(cards)].slice(0, 30);
  console.log(`\n疑似工具卡片 ${uniqCards.length} 个:`);
  for (const c of uniqCards) console.log(`  · ${c.replace(/\n/g, " | ")}`);

  await page.screenshot({ path: path.join(cacheDir, "panlay-explore.png"), fullPage: false });

  fs.writeFileSync(path.join(cacheDir, "panlay-explore.json"), JSON.stringify({
    url: page.url(), links, cards: uniqCards, savedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  console.log(`\n已保存 panlay-explore.json / panlay-explore.png（端口文件 ${portFile}）`);
})().catch((e) => { console.error("失败:", (e.message || "").slice(0, 160)); process.exit(1); });
