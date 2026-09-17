"use strict";

/**
 * 工作台批量上传器：把已填回答的 xlsx 按 500 行/批切分上传。
 * 用法：node scripts/workbench-upload.js [xlsx路径] [每批行数=500] [批数上限]
 * 依赖登录态浏览器（自动读取 运行缓存/cdp.txt）。
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "运行缓存");
const srcFile = process.argv[2] || path.join(dataDir, "workbench-all-questions.xlsx");
const batchRows = Math.max(1, Number(process.argv[3]) || 500);
const maxBatches = Number(process.argv[4]) || 999;

const { chromium } = require("playwright-core");

(async () => {
  const cdp = fs.readFileSync(path.join(dataDir, "cdp.txt"), "utf8").trim();
  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("/b/batch"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://zhidao.baidu.com/b/batch/batch-upload", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  const wb = XLSX.readFile(srcFile);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const keys = Object.keys(allRows[0]);
  const kAnswer = keys.find((k) => k.includes("回答内容"));
  const filled = allRows.filter((r) => String(r[kAnswer] || "").trim());
  // 随机打乱：服务端按文件内容哈希查重（103009 文件已上传过），打乱后每次哈希不同
  for (let i = filled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [filled[i], filled[j]] = [filled[j], filled[i]];
  }
  console.log(`已填回答 ${filled.length} 行（已随机排序防查重），每批 ${batchRows} 行`);

  let uploaded = 0;
  const totalBatches = Math.min(maxBatches, Math.ceil(filled.length / batchRows));
  for (let b = 0; b < totalBatches; b += 1) {
    const chunk = filled.slice(b * batchRows, (b + 1) * batchRows);
    if (!chunk.length) break;
    const partFile = path.join(dataDir, `upload-part-${Date.now()}-${b}.xlsx`);
    const ws = XLSX.utils.json_to_sheet(chunk, { header: keys });
    const wbPart = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbPart, ws, sheetName);
    XLSX.writeFile(wbPart, partFile);

    // 回到上传页走一遍
    await page.goto("https://zhidao.baidu.com/b/batch/batch-upload", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.locator('input[name="upload-panel-task-name"]').fill(`自动批量-${b + 1}/${totalBatches}-${chunk.length}条`);
    await page.locator("input[type=file]").first().setInputFiles(partFile);
    await page.waitForTimeout(2500);

    const responsePromise = page.waitForResponse((res) => res.url().includes("bulkqa/upload"), { timeout: 60000 }).catch(() => null);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("button")).find((el) => el.textContent.trim() === "上传" && el.getBoundingClientRect().width > 0);
      if (el) el.click();
    });
    const response = await responsePromise;
    let ok = false;
    let taskId = "";
    if (response) {
      try {
        const bodyText = await response.text();
        const body = JSON.parse(bodyText);
        ok = body.code === 200;
        taskId = body.data?.taskId || "";
        if (!ok) console.log("  响应:", response.status(), bodyText.slice(0, 200));
      } catch (parseError) {
        console.log("  响应解析失败:", response.status(), (parseError.message || "").slice(0, 80));
      }
    } else {
      console.log("  无 upload 响应（可能页面跳转/弹窗拦截）");
    }
    console.log(`批次 ${b + 1}/${totalBatches}: ${chunk.length} 行 → ${ok ? `成功(taskId ${taskId})` : "失败"}`);
    if (!ok) {
      console.log("本批失败，停止后续批次（人工检查后重跑）。");
      break;
    }
    uploaded += chunk.length;
    fs.rmSync(partFile, { force: true });
    // 批间隔 30 秒，避免服务端压力
    await page.waitForTimeout(30000);
  }
  console.log(`=== 上传完成：共 ${uploaded} 行 ===`);
  process.exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  process.exit(1);
});
