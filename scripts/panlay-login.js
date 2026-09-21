"use strict";

/**
 * panlay.com 登录引导：拉起有头 Edge（持久会话），等待用户完成手机验证码登录。
 * 登录态保存在 运行缓存/panlay-profile，之后 panlay 采集脚本直接复用，无需重复登录。
 *
 * 用法：node scripts/panlay-login.js [等待秒数=480]
 */

const path = require("path");
const { chromium } = require("playwright-core");
const { launchHeadedEdge } = require("../electron/src/headed-edge-launcher");

const waitMs = Math.max(60, Number(process.argv[2]) || 480) * 1000;

(async () => {
  const { cdpUrl } = await launchHeadedEdge({
    onLog: (m) => console.log(m),
  });
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];

  // 找到（或新开）panlay 标签页
  let page = context.pages().find((p) => p.url().includes("panlay.com"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://panlay.com", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  }
  await page.bringToFront().catch(() => {});
  console.log("→ 已打开 panlay.com，请在浏览器窗口完成登录（手机号 + 验证码）…");

  // 未登录时页面右侧有「欢迎登录」面板；登录完成后消失
  const deadline = Date.now() + waitMs;
  let loggedIn = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (text && !text.includes("欢迎登录")) { loggedIn = true; break; }
    const left = Math.round((deadline - Date.now()) / 1000);
    if (left % 60 < 4) console.log(`  等待登录中… 剩余 ${left}s（检测标志：页面不再出现「欢迎登录」）`);
  }

  if (loggedIn) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const lv = (text.match(/Lv\s*\d+/) || [""])[0];
    console.log(`✅ 登录成功（${lv || "已进入工作台"}）。会话已持久化，后续脚本可直接复用。`);
  } else {
    console.log("⏰ 等待超时。浏览器窗口保持打开，可稍后重跑本脚本继续等待，或直接在窗口里登录后运行采集脚本。");
  }
  process.exit(loggedIn ? 0 : 2);
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
