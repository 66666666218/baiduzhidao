"use strict";

/**
 * 批量转存任务（软件内置 · 纯协议版）：
 *   选资源表格（xlsx/txt）→ 从指定比特环境提取一次网盘凭证
 *   → 纯 HTTP 协议批量：verify → 解析 → 建目录 → 转存 → 确权自有永久分享
 *   → 自动生成答题模板问答行 → 输出上传专用表 xlsx。
 *
 * 断点续跑（state.jsonl）/ 失败3次黑名单 / 连续失败熔断 / 容量不足优雅停止。
 * 全程无需窗口点击；风控条目自动跳过并记录。
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");
const { createShare } = require("../netdisk/share");
const { Jar, processOne } = require("../netdisk/protocol");
const qaLib = require(path.join(__dirname, "..", "..", "..", "scripts", "qa-template-lib"));

const dataDir = path.resolve(__dirname, "..", "..", "..", "运行缓存");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function runBatchTransferTask(ctx, deps) {
  const { browserPool, log } = deps;
  const payload = ctx.livePayload ? ctx.livePayload() : ctx.payload;
  const filePath = String(payload.filePath || "").trim().replace(/^"|"$/g, "");
  if (!filePath || !fs.existsSync(filePath)) throw new Error("请先选择资源表格（xlsx 或 txt，一行一个链接）");
  const bitEnv = String(payload.bitEnv || "").trim();
  const destRoot = String(payload.destDir || "/来自资源批量转存").trim() || "/来自资源批量转存";
  const limit = Math.max(0, Number(payload.limit) || 0);
  const cc = Math.max(1, Number(payload.cc) || 4);
  const delayMin = Math.max(0.5, Number(payload.delayMin) || 1);
  const delayMax = Math.max(delayMin, Number(payload.delayMax) || 2);
  const makeShare = payload.makeShare !== false;
  const startIdx = Math.max(0, Number(payload.start) || 0);

  // 读表 / 链接清单
  const XLSX = require("xlsx");
  let rows;
  if (/\.txt$/i.test(filePath)) {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    rows = lines.map((line, i) => ({ __name: `链接${i + 1}`, __link: line }));
  } else {
    const wb = XLSX.readFile(filePath);
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  }
  if (!rows.length) throw new Error("资源表为空");
  const keys = Object.keys(rows[0]);
  const nameKey = keys.find((k) => /文件名|名称|标题|资源/.test(k)) || keys.find((k) => !/链接|网址|url/i.test(k)) || keys[0];
  const linkKey = keys.find((k) => /链接|网址|url/i.test(k)) || keys.find((k) => /pan\.baidu\.com/.test(String(rows[0][k] || ""))) || keys[1];
  const pwdKey = keys.find((k) => /提取码|密码|访问码/.test(k)) || "";
  log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);

  // 从比特环境提取一次网盘凭证（之后全程纯协议，窗口无操作）
  if (!bitEnv) throw new Error("请填写用于提取凭证的比特环境名（该窗口需已登录百度网盘）");
  log(`提取网盘凭证：${bitEnv}`);
  const handle = await browserPool.acquire(bitEnv);
  const browser = await chromium.connectOverCDP(handle.cdpUrl);
  const cookies = await browser.contexts()[0].cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  await browserPool.release(bitEnv, { close: false });
  if (!bduss) throw new Error("该比特环境窗口没有 pan.baidu.com 登录态（BDUSS）");
  log(`凭证就绪：BDUSS(${bduss.length}字符) —— 全程纯协议批量`);

  // 断点状态
  const baseName = path.basename(filePath).replace(/\.(xlsx|txt)$/i, "").slice(0, 40);
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

  const total = limit > 0 ? Math.min(limit, rows.length - startIdx) : rows.length - startIdx;
  log(`开始纯协议批量转存：目标 ${total} 条 | 并发 ${cc} | 目标目录 ${destRoot}`);
  ctx.report({ done: 0, total, status: "running" });

  let done = 0, failed = 0, consecutiveFails = 0, fatalStop = false;
  const qaRows = [];

  // 每条完整链（独立 Jar 会话，并发安全）
  async function worker(workerId) {
    let cursor = 0;
    // 简单游标分配（闭包共享）
    const next = () => { const i = startIdx + (cursor++); return i < rows.length ? i : null; };
    while (!fatalStop && !ctx.shouldStop()) {
      if (limit > 0 && done >= limit) return;
      const i = next();
      if (i === null) return;
      await ctx.pausePoint?.("批量转存·条间检查点");
      const rawName = String(rows[i][nameKey] || "").trim();
      const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? ` 提取码:${rows[i][pwdKey]}` : ""));
      const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
      if (!link || !cellPwd) continue;

      const prev = state.get(srcLink);
      if (prev && prev.status === "done" && prev.ownLink) { qaRows.push(prev.qaRow); continue; }
      if (prev && (prev.attempts || 0) >= 3) continue;

      const meta = qaLib.parseName(rawName);
      const title = qaLib.buildTitle(meta, i);
      const itemBase = { title, name: rawName.slice(0, 30), bitEnv };

      try {
        const idx = String(i + 1).padStart(5, "0");
        const destDir = `${destRoot}/${baseName}/${idx}`;
        const jar = new Jar(bduss, stoken);
        const { toPaths } = await processOne(jar, {
          link: srcLink, pwd: cellPwd, destDir,
        });

        let ownLink = "", ownPwd = "";
        if (makeShare) {
          const ownPwdR = randomPwd();
          const share = await createShare({ bduss, stoken, paths: toPaths, password: ownPwdR });
          if (!share.link) throw new Error("创建分享失败");
          ownLink = `${share.link}?pwd=${share.password}`;
          ownPwd = share.password;
        }

        // 名称质量门槛（不合规跳过问答，资源保留）
        let displayName = rawName && rawName.length >= 4 && !/^链接\d+$/.test(rawName)
          ? rawName
          : decodeURIComponent((toPaths[0] || "").split("/").pop() || "资源");
        if (qaLib.reject(displayName, ownLink)) {
          displayName = decodeURIComponent((toPaths[0] || "").split("/").pop() || "").replace(/\[([^\]]*)\]/g, "$1").trim();
          if (qaLib.reject(displayName, ownLink)) {
            saveState({ srcLink, name: rawName, status: "done", phase: "done", toPaths, ownLink, note: "名称不合规跳过问答", at: new Date().toISOString() });
            done += 1;
            ctx.emitItem({ ...itemBase, status: "已转存（名称不合规跳过问答）", ownLink });
            log(`⚠️ [${done}/${total}] ${rawName.slice(0, 24)} 名称不合规，已转存分享但不进问答表`);
            continue;
          }
        }
        const qaRow = {
          qid: "",
          问题标题: title,
          回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta), true),
        };
        const okEntry = { srcLink, name: rawName, status: "done", phase: "done", toPaths, ownLink, ownPwd, qaRow, at: new Date().toISOString() };
        state.set(srcLink, okEntry);
        saveState(okEntry);
        qaRows.push(qaRow);
        done += 1;
        consecutiveFails = 0;
        ctx.emitItem({ ...itemBase, status: "已转存分享", ownLink });
        ctx.report({ done, total, status: "running" });
        log(`✅ [${done}/${total}] ${rawName.slice(0, 26)} → ${ownLink}`);
      } catch (e) {
        failed += 1;
        consecutiveFails += 1;
        saveState({ srcLink, name: rawName, status: "failed", attempts: ((prev && prev.attempts) || 0) + 1, error: (e.message || "").slice(0, 120), at: new Date().toISOString() });
        ctx.emitItem({ ...itemBase, status: `转存失败：${(e.message || "").slice(0, 60)}` });
        log(`✗ ${rawName.slice(0, 26)} → ${e.message.slice(0, 70)}`);
        if (e.fatal) { log("⛔ 容量不足，停止本次任务（已完成部分完好）。"); fatalStop = true; break; }
        if (consecutiveFails >= 10) { log(`⚠️ 连续 ${consecutiveFails} 条失败，自动停止（断点已存档）。`); break; }
      }
      await sleep((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cc, total || 1) }, (_, w) => worker(w + 1)));

  // 导出上传专用表
  fs.mkdirSync(outDir, { recursive: true });
  if (qaRows.length) {
    const ws = XLSX.utils.json_to_sheet(qaRows, { header: ["qid", "问题标题", "回答内容"] });
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
    XLSX.writeFile(wbOut, path.join(outDir, "上传专用表-已转存.xlsx"));
  }
  const totalOk = [...state.values()].filter((s) => s.status === "done").length;
  log(`=== 批量转存完成 === 本轮成功 ${done} | 失败 ${failed} | 历史累计 ${totalOk}`);
  if (qaRows.length) log(`上传专用表已生成：${path.join(outDir, "上传专用表-已转存.xlsx")}（${qaRows.length} 条）`);
  return { count: done, failed, totalOk };
}

module.exports = { runBatchTransferTask };
