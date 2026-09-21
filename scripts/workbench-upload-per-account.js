"use strict";

/**
 * 按账号上传到答主工作台：
 * 打开指定比特窗口（该窗口登录的百度账号），以该账号身份把已填回答表上传。
 * 用法：node scripts/workbench-upload-per-account.js <xlsx> <比特窗口名> [批行数=500] [批数上限]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "运行缓存");
const srcFile = process.argv[2] || path.join(dataDir, "workbench-all-questions.xlsx");
const envLabel = process.argv[3] || "";
let batchRows = Math.max(1, Number(process.argv[4]) || 500);
const maxBatches = Number(process.argv[5]) || 999;

if (!envLabel) {
  console.error("用法: node scripts/workbench-upload-per-account.js <xlsx路径> <比特窗口名> [批行数=500] [批数上限]");
  process.exit(1);
}

const { chromium } = require("playwright-core");
const { createAdapter, BrowserPool } = require("../electron/src/browser");

(async () => {
  const { Config } = require("../electron/src/config");
  const config = new Config(dataDir);
  const settings = config.load();
  const browserPool = new BrowserPool(createAdapter({ apiUrl: settings.apiUrl }));
  const log = (m) => console.log(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${m}`);

  log(`打开比特窗口：${envLabel}`);
  const handle = await browserPool.acquire(envLabel);
  const browser = await chromium.connectOverCDP(handle.cdpUrl);
  const context = browser.contexts()[0];

  // 验证该窗口已登录百度（有 BDUSS cookie 才能进工作台）
  const cookies = await context.cookies();
  const loggedIn = cookies.some((c) => c.name === "BDUSS");
  if (!loggedIn) {
    console.error(`❌ 窗口 ${envLabel} 未登录百度账号，请先在该窗口中扫码登录后重试。`);
    await browserPool.release(envLabel, { close: false });
    process.exit(1);
  }
  log(`✅ ${envLabel} 百度登录态有效`);

  let page = context.pages().find((p) => p.url().includes("/b/batch"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://zhidao.baidu.com/b/batch/batch-upload", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(4500);
  }
  const quotaText = await page.evaluate(() => (document.body.innerText.match(/剩余额度：([\d,]+)/) || [])[1] || "");
  const quotaNum = Number((quotaText || "").replace(/,/g, ""));
  log(`工作台 ${quotaText ? "剩余额度：" + quotaText : "额度未识别"}`);
  if (Number.isFinite(quotaNum) && quotaNum > 0 && quotaNum < batchRows) {
    batchRows = quotaNum;
    log(`额度小于批行数，本账号批行数调整为 ${quotaNum}`);
  }

  // 切分已填行
  const wb = XLSX.readFile(srcFile);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const keys = Object.keys(allRows[0]);
  const kAnswer = keys.find((k) => k.includes("回答内容"));
  const filled = allRows.filter((r) => String(r[kAnswer] || "").trim());
  // 随机排序防文件查重
  for (let i = filled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [filled[i], filled[j]] = [filled[j], filled[i]];
  }
  log(`已填回答 ${filled.length} 行（随机排序），每批 ${batchRows} 行，批数上限 ${maxBatches}`);

  const totalBatches = Math.min(maxBatches, Math.ceil(filled.length / batchRows));
  let uploaded = 0;
  for (let b = 0; b < totalBatches; b += 1) {
    const chunk = filled.slice(b * batchRows, (b + 1) * batchRows);
    if (!chunk.length) break;
    const partFile = path.join(dataDir, `upload-${envLabel}-${Date.now()}-${b}.xlsx`);
    const ws = XLSX.utils.json_to_sheet(chunk, { header: keys });
    const wbPart = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbPart, ws, sheetName);
    XLSX.writeFile(wbPart, partFile);

    await page.goto("https://zhidao.baidu.com/b/batch/batch-upload", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.locator('input[name="upload-panel-task-name"]').fill(`${envLabel}-${b + 1}/${totalBatches}-${chunk.length}条`);
    await page.locator("input[type=file]").first().setInputFiles(partFile);
    await page.waitForTimeout(2500);

    const responsePromise = page.waitForResponse((res) => res.url().includes("bulkqa/upload"), { timeout: 60000 }).catch(() => null);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("button")).find((el) => el.textContent.trim() === "上传" && el.getBoundingClientRect().width > 0);
      if (el) el.click();
    });
    const response = await responsePromise;
    let ok = false;
    let msg = "";
    if (response) {
      try {
        const body = JSON.parse(await response.text());
        ok = body.code === 200;
        msg = body.msg || "";
        if (body.data?.taskId) msg += ` taskId=${body.data.taskId}`;
      } catch (e) {
        msg = `解析失败 ${response.status()}`;
      }
    } else {
      msg = "无 upload 响应";
    }
    console.log(`批次 ${b + 1}/${totalBatches}: ${chunk.length} 行 → ${ok ? "成功" : `失败(${msg})`}`);
    fs.rmSync(partFile, { force: true });
    if (!ok) {
      console.log("本批失败，停止（可重跑脚本从断点继续）。");
      break;
    }
    uploaded += chunk.length;
    if (b < totalBatches - 1) await page.waitForTimeout(30000);
  }

  await browserPool.release(envLabel, { close: false });
  console.log(`=== 账号 ${envLabel} 上传完成：共 ${uploaded} 行 ===`);
  process.exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  process.exit(1);
});
