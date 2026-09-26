"use strict";

/**
 * 批量上传任务（星链知道批量发布）：
 *   选「上传专用表.xlsx」（转存确权生成）→ 指定比特窗口（该账号需有批量发布权益）
 *   → 自动读剩余额度 → 分批（默认 500 行）上传到答主工作台 → 逐批校验结果。
 *
 * 安全：自动读取工作台剩余额度并自适应批大小；随机排序防服务端文件哈希查重；
 *       批间间隔 30 秒；失败即停（断点可重跑续传）。
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

async function runBatchUploadTask(ctx, deps) {
  const { browserPool, log } = deps;
  const { app } = require("electron");
  const baseDataDir = deps.dataDir || app.getPath("userData"); // 与「打开数据目录」指向同一处
  const payload = ctx.livePayload ? ctx.livePayload() : ctx.payload;
  const filePath = String(payload.filePath || "").trim().replace(/^"|"$/g, "");
  if (!filePath || !fs.existsSync(filePath)) throw new Error("请先选择上传专用表（xlsx）");
  const bitEnv = String(payload.bitEnv || "").trim();
  if (!bitEnv) throw new Error("请填写用于上传的比特环境名（该窗口需已登录百度账号且有批量发布权益）");
  let batchRows = Math.max(1, Number(payload.batchRows) || 500);
  const maxBatches = Math.max(1, Number(payload.maxBatches) || 999);
  const tmpDir = path.join(baseDataDir, "上传分片");
  fs.mkdirSync(tmpDir, { recursive: true });

  // 读取表格
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const allRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
  if (!allRows.length) throw new Error("表格为空");
  const keys = Object.keys(allRows[0]);
  const kAnswer = keys.find((k) => k.includes("回答内容")) || keys[keys.length - 1];
  let filled = allRows.filter((r) => String(r[kAnswer] || "").trim());
  if (!filled.length) throw new Error("表格里没有已填写回答内容的行");

  // 已提交链接台账：跳过平台已收过的链接（防 URL重复提交）
  const ledgerFile = path.join(baseDataDir, "已提交链接台账.jsonl");
  const submitted = new Set();
  try {
    for (const line of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { submitted.add(JSON.parse(line).link); } catch { /* 跳过 */ }
    }
  } catch { /* 首次 */ }
  const linkOf = (row) => (String(row[kAnswer] || "").match(/https:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i) || [])[0] || "";
  const before = filled.length;
  filled = filled.filter((r) => {
    const link = linkOf(r);
    return !link || !submitted.has(link);
  });
  if (before !== filled.length) log(`去重：跳过已提交过的 ${before - filled.length} 行（台账）`);
  if (!filled.length) { log("本表全部链接均已提交过，无需上传。"); return { uploaded: 0, batches: 0, quota: null }; }
  // 随机排序（服务端按文件内容哈希查重）
  for (let i = filled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [filled[i], filled[j]] = [filled[j], filled[i]];
  }
  log(`已填回答 ${filled.length} 行（随机排序防查重）`);

  // 打开比特窗口
  log(`打开比特窗口：${bitEnv}`);
  const handle = await browserPool.acquire(bitEnv);
  const browser = await chromium.connectOverCDP(handle.cdpUrl);
  const context = browser.contexts()[0];
  const cookies = await context.cookies();
  if (!cookies.some((c) => c.name === "BDUSS")) {
    await browserPool.release(bitEnv, { close: false });
    throw new Error(`窗口 ${bitEnv} 未登录百度账号`);
  }

  let page = context.pages().find((p) => p.url().includes("/b/batch"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://zhidao.baidu.com/b/batch/batch-upload", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(4500);
  }
  // 剩余额度自适应
  const quotaText = await page.evaluate(() => (document.body.innerText.match(/剩余额度：([\d,]+)/) || [])[1] || "").catch(() => "");
  const quotaNum = Number(String(quotaText || "").replace(/,/g, ""));
  if (quotaText) log(`工作台剩余额度：${quotaText}`);
  if (Number.isFinite(quotaNum) && quotaNum > 0 && quotaNum < batchRows) {
    batchRows = quotaNum;
    log(`额度小于批行数，本批调整为 ${quotaNum} 行`);
  }
  if (quotaText && Number.isFinite(quotaNum) && quotaNum === 0) {
    await browserPool.release(bitEnv, { close: false });
    log("⛔ 今日剩余额度为 0（T+1 结算，明日重置）。");
    ctx.report({ done: 0, total: 0, status: "done" });
    return { uploaded: 0, batches: 0, quota: 0 };
  }
  if (!quotaText) log("⚠️ 未读到剩余额度（页面文案可能变化），按未知额度继续上传。");

  const totalBatches = Math.min(maxBatches, Math.ceil(filled.length / batchRows));
  ctx.report({ done: 0, total: totalBatches, status: "running" });
  let uploaded = 0;

  try {
  for (let b = 0; b < totalBatches; b += 1) {
    if (ctx.shouldStop()) { log("收到停止信号，已上传部分保留。"); break; }
    await ctx.pausePoint?.("批量上传·批次检查点");
    const chunk = filled.slice(b * batchRows, (b + 1) * batchRows);
    if (!chunk.length) break;
    const partFile = path.join(tmpDir, `upload-${Date.now()}-${b}.xlsx`);
    const ws = XLSX.utils.json_to_sheet(chunk, { header: keys });
    const wbPart = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbPart, ws, sheetName);
    XLSX.writeFile(wbPart, partFile);

    await page.goto("https://zhidao.baidu.com/b/batch/batch-upload", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.locator('input[name="upload-panel-task-name"]').fill(`${bitEnv}-${b + 1}/${totalBatches}-${chunk.length}条`).catch(() => {});
    await page.locator("input[type=file]").first().setInputFiles(partFile);
    await page.waitForTimeout(2500);

    const responsePromise = page.waitForResponse((res) => res.url().includes("bulkqa/upload"), { timeout: 60000 }).catch(() => null);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "上传" && x.getBoundingClientRect().width > 0);
      if (el) el.click();
    });
    const response = await responsePromise;
    let ok = false, msg = "";
    if (response) {
      try {
        const body = JSON.parse(await response.text());
        ok = body.code === 200;
        msg = body.msg || "";
        if (body.data && body.data.taskId) msg += ` taskId=${body.data.taskId}`;
      } catch { msg = `解析失败 ${response.status()}`; }
    } else msg = "无 upload 响应";

    fs.rmSync(partFile, { force: true });
    ctx.emitItem({ title: `批次 ${b + 1}/${totalBatches}`, status: ok ? `上传成功 ${chunk.length} 行` : `上传失败：${msg}` });
    log(`批次 ${b + 1}/${totalBatches}: ${chunk.length} 行 → ${ok ? "成功" : `失败(${msg})`}`);
    if (!ok) { log("本批失败，停止（可稍后重跑续传）。"); break; }
    // 成功后记台账（保守：记录本批所有链接，避免重复提交被拒）
    for (const r of chunk) {
      const link = linkOf(r);
      if (link) fs.appendFileSync(ledgerFile, JSON.stringify({ link, at: new Date().toISOString() }) + "\n");
    }
    uploaded += chunk.length;
    ctx.report({ done: b + 1, total: totalBatches, status: "running" });
    if (b < totalBatches - 1) await page.waitForTimeout(30000);
  }
  } finally {
    // 无论成功/异常：释放窗口 + 清理分片临时文件
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        if (/^upload-\d+-\d+\.xlsx$/.test(f)) fs.rmSync(path.join(tmpDir, f), { force: true });
      }
    } catch { /* 忽略 */ }
    await browserPool.release(bitEnv, { close: false }).catch(() => {});
  }
  // 终止进度上报（缺此行 UI 按钮永久禁用）
  ctx.report({ done: totalBatches, total: totalBatches, status: ctx.shouldStop() ? "stopped" : "done" });
  log(`=== 批量上传完成：共 ${uploaded} 行 ===`);
  return { uploaded, batches: Math.ceil(uploaded / Math.max(1, batchRows)), quota: quotaNum || null };
}

module.exports = { runBatchUploadTask };
