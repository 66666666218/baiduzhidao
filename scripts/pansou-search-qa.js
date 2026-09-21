"use strict";

/**
 * 一站式采集器：搜索 pansou.app → 提取百度网盘链接 → 转换为问答格式
 * 单进程自包含，无 CDP 断连风险。
 * 用法：node scripts/pansou-search-qa.js <关键词> [输出xlsx] [最大等待秒=25]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const keyword = process.argv[2] || "学习资料";
const outFile = process.argv[3] || path.join(root, "运行缓存", `pansou-qa-${Date.now()}.xlsx`);
const maxWait = Math.max(10, Number(process.argv[4]) || 25) * 1000;

const { launchHeadlessEdge } = require("../electron/src/edge-launcher");
const { chromium } = require("playwright-core");

(async () => {
  const edge = await launchHeadlessEdge({});
  const browser = await chromium.connectOverCDP(edge.cdpUrl);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  console.log(`[1] 打开 pansou.app 并搜索「${keyword}」…`);
  await page.goto("https://pansou.app", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  // 关闭可能的设置弹窗
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator("input:not([type=hidden]):not([type=checkbox])").first().fill(keyword);
  // 用搜索按钮或 Enter
  const searchBtn = page.locator("button", { hasText: "搜索" }).first();
  if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  console.log("[2] 等待搜索结果聚合…");
  const deadline = Date.now() + maxWait;
  let pageText = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
    const searching = pageText.includes("搜索中") || pageText.includes("持续搜索");
    const links = (pageText.match(/pan\.baidu\.com\/s\//g) || []).length;
    console.log(`  等待中… 已见 ${links} 个百度链接（${Math.round((Date.now() - deadline + maxWait) / 1000)}s）`);
    if (!searching) break;
  }

  console.log("[3] 从页面提取百度网盘链接 + 资源名…");
  const re = /https:\/\/pan\.baidu\.com\/s\/([^\s?&]+)\?pwd=([a-z0-9]{4})/g;
  const seen = new Set();
  const resources = [];
  let m;
  while ((m = re.exec(pageText)) !== null) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const before = pageText.slice(Math.max(0, m.index - 100), m.index)
      .replace(/https?:\/\/[^\s]+/g, "")
      .replace(/[|←→→·]/g, " ")
      .trim();
    const name = before.split(/\s{2,}/).filter(Boolean).pop() || before.slice(-50);
    resources.push({ name: name.trim().slice(-60), url, pwd: m[2] });
  }
  console.log(`  提取 ${resources.length} 条百度网盘资源`);

  if (!resources.length) {
    console.log("⚠️ 没有提取到百度网盘链接（关键词可能太冷门或站点无结果）");
    edge.close();
    process.exit(0);
  }

  console.log("[4] 转换为问答格式…");
  const AD_PATTERNS = /微信号|加微信|VX[:：]?|公众号|代下|有偿|付费获取|联系QQ|加群|引流/i;
  const BANNED_EXT = /\.(zip|rar|7z)$/i;
  const qaRows = [];
  const rejected = [];
  for (const r of resources) {
    if (AD_PATTERNS.test(r.name)) { rejected.push({ name: r.name, reason: "含广告/引流" }); continue; }
    if (BANNED_EXT.test(r.name)) { rejected.push({ name: r.name, reason: "压缩包" }); continue; }
    if (r.name.length < 3) { rejected.push({ name: r.name, reason: "名称过短" }); continue; }

    // 问题标题（5~49 字）
    let title = `求${r.name}网盘资源下载`;
    if (title.length > 49) title = title.slice(0, 49);
    if (title.length < 5) title = `求${r.name}资源`;

    // 回答 HTML
    const answer = [
      `<p>整理了「${r.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}」，完整版放在网盘里，需要的自取。</p>`,
      `<p>网盘链接：<a href="${r.url}">${r.url}</a></p>`,
      `<p>提取码：<strong>${r.pwd}</strong></p>`,
      `<p>如果链接失效可以评论区留言，看到会补新的。</p>`,
    ].join("\n");

    qaRows.push({
      "qid（非必填，自问自答创建的问题无此字段）": "",
      "问题标题（必填）": title,
      "一级分类": "",
      "二级分类": "",
      "问题发布时间（空）": "",
      "回答内容（必填）": answer,
    });
  }
  console.log(`  合格 ${qaRows.length} 条，剔除 ${rejected.length} 条`);

  // 保存
  const ws = XLSX.utils.json_to_sheet(qaRows, {
    header: ["qid（非必填，自问自答创建的问题无此字段）", "问题标题（必填）", "一级分类", "二级分类", "问题发布时间（空）", "回答内容（必填）"],
  });
  const wbOut = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbOut, ws, "问答格式");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  XLSX.writeFile(wbOut, outFile);

  console.log(`=== 完成 ===`);
  console.log(`资源 ${resources.length} 条 → 问答 ${qaRows.length} 条（剔除 ${rejected.length}）`);
  console.log(`输出: ${outFile}`);
  console.log(`下一步: 在工作台上传 ${outFile}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message.slice(0, 160)); process.exit(1); });
