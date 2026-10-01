"use strict";

/**
 * 一次性探测脚本：百度知道答主主页（usercenter）的数据接口与 DOM 结构。
 * 用途：为 zhidao-home.js 主页爬取器选型（走接口还是走 DOM）。
 * 用法：node scripts/probe-usercenter.js <usercenter完整URL> [等待秒数]
 */

const path = require("path");
const { chromium } = require("playwright-core");
const { launchHeadlessEdge } = require("../electron/src/edge-launcher");

async function main() {
  const target = process.argv[2] || "https://zhidao.baidu.com/usercenter?uid=2e374069236f25705e79900e&role=ugc";
  const waitSec = Number(process.argv[3] || 10);

  const edge = await launchHeadlessEdge({ onLog: (m) => console.log("[edge]", m) });
  const browser = await chromium.connectOverCDP(edge.cdpUrl);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();

    const apiCalls = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (!/zhidao\.baidu\.com|bdimg\.com/.test(url)) return;
      // 只记录数据型请求（非静态资源）
      if (/\.(js|css|png|jpg|gif|woff|svg|ico)(\?|$)/.test(url)) return;
      const entry = { url, status: res.status(), type: res.request().resourceType() };
      if (/json|text/.test(res.headers()["content-type"] || "")) {
        try {
          const body = await res.text();
          entry.sample = body.slice(0, 500);
        } catch { /* body 不可读 */ }
      }
      apiCalls.push(entry);
    });

    console.log("打开主页:", target);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("goto 异常:", e.message));
    await page.waitForTimeout(waitSec * 1000);

    // 页面标题与登录态线索
    console.log("=== 页面标题 ===");
    console.log(await page.title());

    // 查找回答列表相关 DOM
    console.log("=== DOM 结构探测 ===");
    const domInfo = await page.evaluate(() => {
      const out = { candidates: [] };
      // 常见列表容器
      const selectors = [".user-answer-list", ".answer-list", ".wgt-answers", ".list", ".item", "[class*='answer']", "[class*='question']", "[class*='list']"];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) out.candidates.push({ sel, count: els.length, sample: els[0].outerHTML.slice(0, 600) });
      }
      // 页面上所有指向问题的链接
      out.questionLinks = Array.from(document.querySelectorAll("a[href*='/question/']"))
        .slice(0, 10)
        .map((a) => ({ href: a.getAttribute("href"), text: (a.textContent || "").trim().slice(0, 60) }));
      out.bodyClass = document.body.className;
      return out;
    });
    console.log(JSON.stringify(domInfo, null, 1).slice(0, 4000));

    console.log("=== 捕获的接口请求（前 25 条） ===");
    for (const c of apiCalls.slice(0, 25)) {
      console.log(`[${c.status}] ${c.type} ${c.url}`);
      if (c.sample) console.log(`   sample: ${c.sample.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    edge.close();
  }
}

main().catch((e) => { console.error("探测失败:", e.message); process.exit(1); });
