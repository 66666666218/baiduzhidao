"use strict";

/**
 * pansou.app 网盘资源采集器：
 * 用无头 Edge 搜索关键词，提取百度网盘链接 + 提取码 + 资源名称。
 * 产出格式兼容 pan-to-qa.js（两列：资源名称 | 网盘链接含提取码）。
 *
 * 用法：node scripts/pansou-crawl.js <关键词> [输出xlsx] [最大页数=1]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const keyword = process.argv[2] || "学习资料";
const outFile = process.argv[3] || path.join(root, "运行缓存", `pansou-${Date.now()}.xlsx`);
const maxPages = Math.max(1, Number(process.argv[4]) || 1);

const { launchHeadlessEdge } = require("../electron/src/edge-launcher");
const { chromium } = require("playwright-core");

(async () => {
  const edge = await launchHeadlessEdge({});
  const { chromium: pw } = require("playwright-core");
  const browser = await pw.connectOverCDP(edge.cdpUrl);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  await page.goto("https://pansou.app", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.locator("input").first().fill(keyword);
  await page.keyboard.press("Enter");

  // 等搜索完成
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const searching = await page.evaluate(() => document.body.innerText.includes("搜索中")).catch(() => true);
    if (!searching) break;
  }

  // 翻页采集
  const seen = new Set();
  const resources = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    if (pageNum > 1) {
      const nextBtn = page.locator("text=下一页").first();
      const vis = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (!vis) { console.log(`没有下一页了（当前第 ${pageNum - 1} 页）`); break; }
      await nextBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(5000);
    }
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");

    // 在 Node.js 端解析链接和资源名
    const re = /https:\/\/pan\.baidu\.com\/s\/([^\s?&]+)\?pwd=([a-z0-9]{4})/g;
    const pageData = [];
    let m;
    while ((m = re.exec(pageText)) !== null) {
      const before = pageText.slice(Math.max(0, m.index - 100), m.index)
        .replace(/https?:\/\/[^\s]+/g, "")
        .replace(/[|←→→·]/g, " ")
        .trim();
      const name = before.split(/\s{2,}/).filter(Boolean).pop() || before.slice(-50);
      pageData.push({
        name: name.trim().slice(-60),
        url: `https://pan.baidu.com/s/${m[1]}?pwd=${m[2]}`,
        pwd: m[2],
      });
    }

    let newCount = 0;
    for (const item of pageData) {
      const key = item.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      resources.push(item);
      newCount += 1;
    }
    console.log(`第 ${pageNum} 页：新增 ${newCount} 条，累计 ${resources.length} 条`);
  }

  await browser.close().catch(() => {});
  edge.close();

  // 过滤只保留百度网盘链接（用户要求只保存百度的）
  const baiduOnly = resources.filter((r) => r.url.includes("pan.baidu.com"));
  console.log(`=== 采集完成：百度网盘 ${baiduOnly.length} 条 ===`);

  if (!baiduOnly.length) {
    console.log("没有采集到百度网盘链接");
    process.exit(0);
  }

  // 产出资源表（两列：资源名称 | 网盘链接含提取码）
  const rows = baiduOnly.map((item) => ({
    "网盘内容名称": item.name,
    "网盘链接": `${item.url} 提取码: ${item.pwd}`,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "资源表");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  XLSX.writeFile(wb, outFile);
  console.log(`资源表已保存: ${outFile}`);
  console.log(`下一步: node scripts/pan-to-qa.js ${outFile}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message.slice(0, 160)); process.exit(1); });
