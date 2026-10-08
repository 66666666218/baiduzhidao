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
const { parseTopicRules, classifyByRules, DEFAULT_TOPIC_RULES } = require("../domain/topic-rules");
const { buildTopicAllocation, topicKey } = require("../domain/account-topic");
const excel = require("../storage/excel");

/** 从表头里找「问题标题」类列（不同上游产出的列名不完全一致） */
function pickTitleKey(keys) {
  return keys.find((k) => /问题标题|资源名|标题/.test(String(k))) || keys[0] || "";
}

/** 账号名可能含路径非法字符，做文件名前先净化 */
function safeFileToken(text) {
  return String(text || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "account";
}

function writePartFile(partFile, rows, keys, sheetName) {
  const XLSX = require("xlsx");
  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  const wbPart = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbPart, ws, sheetName);
  XLSX.writeFile(wbPart, partFile);
}

/**
 * 把分配结果按题材合并回桶，用于落盘「一个题材一张表」。
 * 同一题材被多个账号分摊时会把它们的行重新合并——分表是按**题材**切的，不是按账号。
 */
function collectTopicRows(slots) {
  const byTopic = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (!slot || !slot.topic || !slot.rows.length) continue;
    if (!byTopic.has(slot.topic)) byTopic.set(slot.topic, []);
    byTopic.get(slot.topic).push(...slot.rows);
  }
  return byTopic;
}

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
  let browser;
  try {
    browser = await chromium.connectOverCDP(handle.cdpUrl);
  } catch (e) {
    await browserPool.release(bitEnv, { close: false });
    throw e;
  }
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
    if (browser) await browser.close().catch(() => {});
    await browserPool.release(bitEnv, { close: false }).catch(() => {});
  }
  // 终止进度上报（缺此行 UI 按钮永久禁用）
  ctx.report({ done: totalBatches, total: totalBatches, status: ctx.shouldStop() ? "stopped" : "done" });
  log(`=== 批量上传完成：共 ${uploaded} 行 ===`);
  return { uploaded, batches: Math.ceil(uploaded / Math.max(1, batchRows)), quota: quotaNum || null };
}

/**
 * 题材路由上传：把上传专用表按分类规则派生题材 → 拆成各账号的份 → 逐账号上传。
 *
 * 复用 runBatchUploadTask（它本就按单个 bitEnv 工作），不复制它的批次/额度/台账逻辑，
 * 只用一个覆写了 livePayload 的子上下文把「哪个账号、哪张分表」喂进去。
 */
async function runTopicUploadTask(ctx, deps) {
  const { log } = deps;
  const { app } = require("electron");
  const baseDataDir = deps.dataDir || app.getPath("userData");
  const payload = (ctx.livePayload ? ctx.livePayload() : ctx.payload) || {};

  const sourcePath = String(payload.filePath || "").trim().replace(/^"|"$/g, "");
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error("请先选择上传专用表（xlsx）");

  const envLabels = (Array.isArray(payload.bitEnvs) ? payload.bitEnvs : [])
    .map((env) => (env && typeof env === "object" ? env.label ?? env.name : env))
    .map((label) => String(label || "").trim())
    .filter(Boolean);
  if (!envLabels.length) throw new Error("请先填写至少一个比特环境名称。");

  const XLSX = require("xlsx");
  const wb = XLSX.readFile(sourcePath);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
  if (!rows.length) throw new Error("表格为空");
  const keys = Object.keys(rows[0]);
  const titleKey = pickTitleKey(keys);

  const rules = parseTopicRules(payload.topicRules || DEFAULT_TOPIC_RULES);
  if (!rules.length) throw new Error("分类规则为空，无法按题材拆分上传表（请到设置页填写）。");
  const classify = (row) => classifyByRules(String(row[titleKey] || ""), rules);

  const { slots, unclassified, orphanByTopic, unboundAccounts, stats } = buildTopicAllocation(
    rows, envLabels, payload.accountTopics, { classify }
  );

  log(`上传表共 ${stats.total} 行，按分类规则识别出 ${stats.classified} 行（依据列：${titleKey}）。`);
  const assigned = slots.filter((slot) => slot.rows.length);
  if (assigned.length) log(`按题材拆分：${assigned.map((s) => `${s.envLabel}「${s.topic}」${s.rows.length} 行`).join(" | ")}`);
  if (unboundAccounts.length) log(`⚠️ 未绑定题材、本次不参与上传的账号：${unboundAccounts.join("、")}。`);
  if (Object.keys(orphanByTopic).length) {
    const detail = Object.entries(orphanByTopic).map(([topic, count]) => `${topic} ${count} 行`).join("、");
    log(`⚠️ 这些题材没有绑定账号，对应行本次不上传：${detail}。`);
  }
  if (unclassified.length) {
    log(`⚠️ 有 ${unclassified.length} 行没有命中任何分类规则，本次不上传（可补充规则后重跑）。`);
    log(`   示例：${unclassified.slice(0, 3).map((r) => String(r[titleKey] || "").slice(0, 40)).join(" / ")}`);
  }
  if (!assigned.length) {
    log("没有任何账号分配到待上传的行，本次结束。");
    return { uploaded: 0, batches: 0, accounts: [] };
  }

  // 分类产出 = 拆成多张表（一个题材一张），**不往表里加列**。
  // 上传模板是平台约定的，多一列风险是整批被拒收；分表则完全不动模板结构，
  // 而且分出来的表就是"哪个表是哪个题材"的凭据，可以人工过目再传。
  const splitDir = path.join(path.dirname(sourcePath), "分表");
  fs.mkdirSync(splitDir, { recursive: true });
  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const rowsByTopic = collectTopicRows(slots);
  const topicFileOf = new Map();
  for (const [topic, items] of rowsByTopic) {
    const file = excel.uniqueFilePath(path.join(splitDir, `${baseName}_${topic}.xlsx`));
    writePartFile(file, items, keys, sheetName);
    topicFileOf.set(topic, file);
    log(`已拆出题材分表：${topic} → ${file}（${items.length} 行）`);
  }

  const tmpDir = path.join(baseDataDir, "上传分片");
  fs.mkdirSync(tmpDir, { recursive: true });
  const results = [];
  let uploaded = 0;

  for (const slot of slots) {
    if (ctx.shouldStop()) {
      log("收到停止信号，未开始的账号不再上传。");
      break;
    }
    if (!slot.rows.length) continue;
    // 一个题材只对应一个账号时，直接把题材分表传上去；同题材多账号才再切一次
    const topicFile = topicFileOf.get(slot.topic);
    const sameTopicAccounts = slots.filter((s) => s.rows.length && topicKey(s.topic) === topicKey(slot.topic));
    const isTemp = !(topicFile && sameTopicAccounts.length === 1);
    const partFile = isTemp
      ? path.join(tmpDir, `topic-${Date.now()}-${safeFileToken(slot.envLabel)}.xlsx`)
      : topicFile;
    try {
      if (isTemp) writePartFile(partFile, slot.rows, keys, sheetName);
      log(`--- 账号 ${slot.envLabel}（题材「${slot.topic}」${slot.rows.length} 行）开始上传：${partFile} ---`);
      // 子上下文只覆写 livePayload：runBatchUploadTask 从 livePayload() 取 filePath / bitEnv
      const subCtx = { ...ctx, livePayload: () => ({ ...payload, filePath: partFile, bitEnv: slot.envLabel }) };
      const result = await runBatchUploadTask(subCtx, deps);
      uploaded += Number(result.uploaded) || 0;
      results.push({ envLabel: slot.envLabel, topic: slot.topic, planned: slot.rows.length, table: partFile, ...result });
    } catch (error) {
      // 单账号失败（未登录 / 无批量发布权益 / 额度为 0）不该拖垮其他账号
      log(`账号 ${slot.envLabel} 上传失败，跳过继续下一个：${error.message}`);
      results.push({ envLabel: slot.envLabel, topic: slot.topic, planned: slot.rows.length, uploaded: 0, error: error.message });
    } finally {
      // 题材分表是产物要留着；只有临时切片才清
      if (isTemp) fs.rmSync(partFile, { force: true });
    }
  }

  ctx.report({ done: 1, total: 1, status: ctx.shouldStop() ? "stopped" : "done" });
  log(`=== 题材路由上传完成：共 ${uploaded} 行，涉及 ${results.length} 个账号 ===`);
  if (topicFileOf.size) log(`题材分表已留存（可人工过目后再传）：${splitDir}`);
  return {
    uploaded,
    batches: 0,
    accounts: results,
    splitDir,
    topicTables: Array.from(topicFileOf.entries()).map(([topic, file]) => ({ topic, file })),
  };
}

module.exports = { runBatchUploadTask, runTopicUploadTask, pickTitleKey, safeFileToken, collectTopicRows };
