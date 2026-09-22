"use strict";

/**
 * 批量转存任务（软件内置版 · 真UI流程）：
 *   选择资源表格（名称/链接/提取码）→ 比特环境窗口内逐条
 *   打开分享页 → 提取 → 保存到网盘 → 确定（捕获转存响应拿权威落盘路径）
 *   → 创建自己的永久分享 → 生成答题模板问答行 → 输出上传专用表。
 *
 * 断点续跑：dataDir/批量转存/<表名>/state.jsonl；同一链接失败满 3 次进入黑名单。
 * 风控：滑块验证自动暂停 60 秒等人工在窗口里拖动；连续 8 条失败自动停止。
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");
const { createShare } = require("../netdisk/share");
const qaLib = require(path.join(__dirname, "..", "..", "..", "scripts", "qa-template-lib"));

const dataDir = path.resolve(__dirname, "..", "..", "..", "运行缓存");
const SKIP_NAMES = new Set(["netdisk-share-test.txt", "老司机必看.zip"]);

function parseLinkCell(text) {
  const s = String(text || "");
  const link = (s.match(/https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i) || [])[0] || "";
  let pwd = (s.match(/[?&]pwd=([a-z0-9]{4})/i) || [])[1] || "";
  if (!pwd) pwd = (s.match(/(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i) || [])[1] || "";
  return { link, pwd };
}
function randomPwd() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBatchTransferTask(ctx, deps) {
  const { browserPool, log } = deps;
  const payload = ctx.livePayload ? ctx.livePayload() : ctx.payload;
  const filePath = String(payload.filePath || "").trim().replace(/^"|"$/g, "");
  if (!filePath || !fs.existsSync(filePath)) throw new Error("请先选择资源表格（xlsx，含名称/链接/提取码列）");
  const bitEnv = String(payload.bitEnv || "").trim();
  if (!bitEnv) throw new Error("请填写用于转存的比特环境名称（该窗口需已登录百度网盘）");
  const destRoot = String(payload.destDir || "/来自资源批量转存").trim() || "/来自资源批量转存";
  const limit = Math.max(0, Number(payload.limit) || 0);
  const delayMin = Math.max(2, Number(payload.delayMin) || 5);
  const delayMax = Math.max(delayMin, Number(payload.delayMax) || 10);
  const makeShare = payload.makeShare !== false;
  const startIdx = Math.max(0, Number(payload.start) || 0);

  // 读表 + 识别列
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  if (!rows.length) throw new Error("资源表为空");
  const keys = Object.keys(rows[0]);
  const nameKey = keys.find((k) => /文件名|名称|标题|资源/.test(k)) || keys[0];
  const linkKey = keys.find((k) => /链接|网址|url/i.test(k)) || keys.find((k) => /pan\.baidu\.com/.test(String(rows[0][k] || ""))) || keys[1];
  const pwdKey = keys.find((k) => /提取码|密码|访问码/.test(k)) || "";
  log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);

  // 打开比特环境
  log(`打开比特环境：${bitEnv}`);
  const handle = await browserPool.acquire(bitEnv);
  const browser = await chromium.connectOverCDP(handle.cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  let page = context.pages().find((p) => p.url().includes("pan.baidu.com"))
    || context.pages().find((p) => !/chrome:|edge:|about:/.test(p.url()))
    || (await context.newPage());
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);

  const cookies = await context.cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  if (!bduss) throw new Error("该比特环境窗口没有 pan.baidu.com 登录态（BDUSS）——请先在此窗口登录百度网盘");
  log(`网盘登录态：BDUSS(${bduss.length}字符)`);

  // 断点状态
  const baseName = path.basename(filePath).replace(/\.xlsx$/i, "").slice(0, 40);
  const workDir = path.join(dataDir, "批量转存", baseName);
  const stateFile = path.join(workDir, "state.jsonl");
  const outDir = path.join(workDir, "上传专用表");
  const state = new Map();
  try {
    for (const line of fs.readFileSync(stateFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); state.set(r.srcLink, r); } catch { /* 跳过 */ }
    }
  } catch { /* 首次 */ }
  const saveState = (e) => { fs.mkdirSync(workDir, { recursive: true }); fs.appendFileSync(stateFile, JSON.stringify(e) + "\n"); };
  const randomPwd = () => { const c = "abcdefghjkmnpqrstuvwxyz23456789"; return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join(""); };

  const total = limit > 0 ? Math.min(limit, rows.length - startIdx) : rows.length - startIdx;
  log(`开始批量转存：目标 ${total} 条 | 目标目录 ${destRoot}`);
  ctx.report({ done: 0, total, status: "running" });

  let done = 0, failed = 0, consecutiveFails = 0;
  const qaRows = [];

  for (let i = startIdx; i < rows.length; i += 1) {
    if (ctx.shouldStop()) { log("收到停止信号，收尾导出。"); break; }
    if (limit > 0 && done >= limit) break;
    await ctx.pausePoint?.("批量转存·条间检查点");
    const rawName = String(rows[i][nameKey] || "").trim();
    const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? ` 提取码:${rows[i][pwdKey]}` : ""));
    const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
    if (!link || !cellPwd) continue;

    const prev = state.get(srcLink);
    if (prev && prev.status === "done" && prev.ownLink) { qaRows.push(prev.qaRow); continue; }
    if (prev && (prev.attempts || 0) >= 3) continue; // 黑名单

    const meta = qaLib.parseName(rawName);
    const title = qaLib.buildTitle(meta, i);
    const itemBase = { title, name: rawName.slice(0, 30), bitEnv };

    try {
      // ① 打开分享页
      await page.goto(srcLink, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
      await sleep(3000);

      // ② 提取码页
      if (await page.locator("#submitBtn").count()) {
        const box = await page.locator("#submitBtn").boundingBox();
        if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.up(); }
        await sleep(6000);
      }

      // 滑块验证 → 暂停等人工
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => "");
      if (/安全验证|拖动.*滑块/.test(pageText)) {
        log(`⏸ 「${rawName.slice(0, 20)}」触发滑块验证——请在窗口中手动拖动滑块，60 秒后自动继续…`);
        await sleep(60000);
        if (await page.locator("#submitBtn").count()) {
          const box2 = await page.locator("#submitBtn").boundingBox();
          if (box2) { await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2); await page.mouse.down(); await page.mouse.up(); }
          await sleep(6000);
        }
      }

      // ③ 保存到网盘
      const immediateBtn = page.locator("text=立即保存").first();
      const saveBtn = page.locator("text=保存到网盘").first();
      let clicked = false;
      if (await immediateBtn.isVisible().catch(() => false)) { await immediateBtn.click(); clicked = true; }
      else if (await saveBtn.isVisible().catch(() => false)) { await saveBtn.click(); clicked = true; }
      if (!clicked) throw new Error("找不到保存按钮（分享可能已失效）");
      await sleep(3000);

      // ④ 确定并捕获转存响应
      const transferResp = new Promise((resolve) => {
        const handler = async (res) => {
          if (/share\/transfer/i.test(res.url())) {
            let body = {};
            try { body = await res.json(); } catch { /* 忽略 */ }
            resolve(body);
          }
        };
        page.on("response", handler);
        setTimeout(() => { page.off("response", handler); resolve({ errno: -1 }); }, 20000);
      });
      const confirmBtn = page.getByText("确定", { exact: true }).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        const cb = await confirmBtn.boundingBox();
        if (cb) { await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down(); await page.mouse.up(); }
      } else {
        await page.keyboard.press("Enter");
      }
      const tBody = await transferResp;
      await sleep(2000);
      if (tBody.errno === 12 || tBody.errno === -10) throw Object.assign(new Error("网盘容量不足"), { fatal: true });
      if (tBody.errno !== 0) throw new Error(`转存 errno=${tBody.errno} ${tBody.show_msg || ""}`);
      const toPaths = ((tBody.extra && tBody.extra.list) || []).map((x) => x.to);
      if (!toPaths.length) throw new Error("转存成功但未取得落盘路径");

      // ⑤ 创建自己的永久分享（确权后）
      let ownLink = "", ownPwd = "";
      if (makeShare) {
        ownPwd = randomPwd();
        const share = await createShare({ bduss, stoken, paths: toPaths, password: ownPwd });
        if (!share.link) throw new Error("创建分享失败");
        ownLink = `${share.link}?pwd=${share.password}`;
        ownPwd = share.password;
      }

      done += 1;
      consecutiveFails = 0;
      const qaRow = makeShare ? {
        qid: "",
        问题标题: title,
        回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta), true),
      } : null;
      const okEntry = { srcLink, name: rawName, status: "done", phase: "done", toPaths, ownLink, ownPwd, qaRow, at: new Date().toISOString() };
      state.set(srcLink, okEntry);
      saveState(okEntry);
      if (qaRow) qaRows.push(qaRow);
      ctx.emitItem({ ...itemBase, status: "已转存分享", ownLink, toCount: toPaths.length });
      ctx.report({ done, total, status: "running" });
      log(`✅ [${done}/${total}] ${rawName.slice(0, 26)} → ${ownLink}`);
    } catch (e) {
      failed += 1;
      consecutiveFails += 1;
      const attempts = ((prev && prev.attempts) || 0) + 1;
      const phase = e.fatal ? "failed" : "failed";
      saveState({ srcLink, name: rawName, status: "failed", attempts, error: (e.message || "").slice(0, 120), at: new Date().toISOString() });
      ctx.emitItem({ ...itemBase, status: `转存失败：${(e.message || "").slice(0, 60)}` });
      log(`✗ ${rawName.slice(0, 26)} → ${e.message.slice(0, 70)}`);
      if (e.fatal) { log("⛔ 致命错误（容量不足），停止本次任务。已成功条目完好。"); break; }
      if (/滑块/.test(e.message)) { log("  ⏸ 等待人工完成验证 60 秒…"); await sleep(60000); }
      if (consecutiveFails >= 8) { log(`⚠️ 连续 ${consecutiveFails} 条失败，自动停止（黑名单与断点已存档）。`); break; }
    }
    await ctx.delay(delayMin, delayMax, "批量转存·条间间隔");
  }

  // 导出上传专用表
  fs.mkdirSync(outDir, { recursive: true });
  if (qaRows.length) {
    const ws = XLSX.utils.json_to_sheet(qaRows, { header: ["qid", "问题标题", "回答内容"] });
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
    XLSX.writeFile(wbOut, path.join(outDir, "上传专用表-已转存.xlsx"));
  }
  await browserPool.release(bitEnv, { close: false });
  const totalOk = [...state.values()].filter((s) => s.status === "done").length;
  log(`=== 批量转存完成 === 本轮成功 ${done} | 失败 ${failed} | 历史累计 ${totalOk}`);
  if (qaRows.length) log(`上传专用表已生成：${path.join(outDir, "上传专用表-已转存.xlsx")}（${qaRows.length} 条）`);
  return { count: done, failed, totalOk };
}

module.exports = { runBatchTransferTask };
