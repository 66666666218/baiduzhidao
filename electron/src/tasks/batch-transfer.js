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
const qaLib = require("../netdisk/qa-template-lib");


// 打包后 __dirname 在 asar 内且安装目录不可写：数据一律放用户数据目录（%AppData%\zhidao-answer-studio）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function parseLinkCell(text) {
  const s = String(text || "");
  const link = (s.match(/https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i) || [])[0] || "";
  let pwd = (s.match(/[?&]pwd=([a-z0-9]{4})/i) || [])[1] || "";
  if (!pwd) pwd = (s.match(/(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i) || [])[1] || "";
  return { link, pwd };
}
/** 表格名是否为"通用/序号"占位（不能作为资源名）：序号、链接N、纯符号、通用词 */
function isGenericName(n) {
  const s = String(n || "").trim();
  if (!s || s.length < 4) return true;
  if (/^链接\d+$/.test(s)) return true;              // txt 模式占位
  if (/^[\d\s\-_.、（）()]+$/.test(s)) return true;  // 纯数字/编号/符号
  if (/^(资源|文件|附件|素材|下载|链接|文档|资料)\d*$/.test(s)) return true; // 通用词
  const cjk = (s.match(/[一-龥]/g) || []).length;
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  if (cjk < 2 && letters < 4) return true;            // 无足够中文也无足够字母 → 非描述性
  return false;
}

function randomPwd() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

async function runBatchTransferTask(ctx, deps) {
  const { app } = require("electron"); // 主进程内可用：数据放用户数据目录（打包后安装目录不可写）
  const { browserPool, log } = deps;
  const baseDataDir = deps.dataDir || app.getPath("userData"); // 与「打开数据目录」指向同一处
  const dataDir = path.join(baseDataDir, "\u6279\u91cf\u8f6c\u5b58");
  const payload = ctx.livePayload ? ctx.livePayload() : ctx.payload;
  const filePath = String(payload.filePath || "").trim().replace(/^"|"$/g, "");
  if (!filePath || !fs.existsSync(filePath)) throw new Error("请先选择资源表格（xlsx 或 txt，一行一个链接）");
  // 多账号：bitEnvs 数组（逗号分隔或数组），按窗口轮换；单账号兼容 bitEnv
  const envList = (Array.isArray(payload.bitEnvs) ? payload.bitEnvs : String(payload.bitEnvs || payload.bitEnv || "").replace(/\，/g, ",").replace(/\n/g, ",").split(","))
  if (!envList.length) throw new Error("请填写至少一个比特环境名（多账号每行一个）");
  const perEnv = Math.max(1, Number(payload.perEnv) || 50); // 每窗口连续处理条数（轮换粒度）
  const destRoot = String(payload.destDir || "/来自资源批量转存").trim() || "/来自资源批量转存";
  const limit = Math.max(0, Number(payload.limit) || 0);
  const cc = Math.max(1, Number(payload.cc) || 4);
  const delayMin = Math.max(0.5, Number(payload.delayMin) || 1);
  const delayMax = Math.max(delayMin, Number(payload.delayMax) || 2);
  const makeShare = payload.makeShare !== false;
  const startIdx = Math.max(0, Number(payload.start) || 0);
  // 自定义输出表名（默认 上传专用表-已转存）
  const outNameRaw = String(payload.outName || "").trim().replace(/[\/:*?"<>|]/g, "_").slice(0, 60);
  const outName = outNameRaw || "上传专用表-已转存";

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

  // 从各比特窗口提取一次网盘凭证（之后全程纯协议，窗口无操作）
  const creds = []; // {env, bduss, stoken}
  for (const env of envList) {
    log(`提取网盘凭证：${env}`);
    const h = await browserPool.acquire(env);
    const b = await chromium.connectOverCDP(h.cdpUrl);
    const cs = await b.contexts()[0].cookies("https://pan.baidu.com");
    const bd = (cs.find((c) => c.name === "BDUSS") || {}).value || "";
    const st = (cs.find((c) => c.name === "STOKEN") || {}).value || "";
    await browserPool.release(env, { close: false });
    await b.close().catch(() => {});
    if (!bd) { log(`⚠️ 窗口 ${env} 无网盘登录态，跳过该账号`); continue; }
    creds.push({ env, bduss: bd, stoken: st });
    log(`✅ ${env} 凭证就绪 BDUSS(${bd.length}字符)`);
  }
  if (!creds.length) throw new Error("没有任何窗口具备 pan.baidu.com 登录态");
  const bduss = creds[0].bduss;   // 兼容旧引用（分享创建用首个窗口凭证）
  const stoken = creds[0].stoken;
  log(`多账号就绪：${creds.length} 个窗口 —— 全程纯协议批量轮换`);

  // 断点状态
  const baseName = path.basename(filePath).replace(/\.(xlsx|txt)$/i, "").slice(0, 40);
  const workDir = path.join(dataDir, baseName);  // dataDir 已含"批量转存"层，不再重复
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

  // 规范化名称去重键：历史已完成 + 本轮动态累积（同一资源不同链接也只转一次）
  const seenKeys = new Set();
  for (const st of state.values()) {
    if (st.status === "done" && st.name) {
      const k = qaLib.normalizeName(st.name);
      if (k && k.length >= 2) seenKeys.add(k);
    }
  }
  log(`去重键库载入：${seenKeys.size} 个（按规范化名称，跨写法/跨链接去重）`);

  const total = limit > 0 ? Math.min(limit, rows.length - startIdx) : rows.length - startIdx;
  log(`开始纯协议批量转存：目标 ${total} 条 | 并发 ${cc} | 目标目录 ${destRoot}`);
  ctx.report({ done: 0, total, status: "running" });

  let done = 0, failed = 0, consecutiveFails = 0, fatalStop = false;
  const qaRows = [];

  // 每条完整链（独立 Jar 会话，并发安全）；窗口按轮换粒度切换
  // 【并发修复】游标与名额必须跨 worker 共享：此前每个 worker 各持 cursor=0，
  // 默认 4 并发会把同一批资源重复处理 4 遍（表格出现重复行的根因）
  let envCursor = 0;
  function pickEnv() { return creds[envCursor % creds.length]; }
  let sharedCursor = 0;
  let reservedCount = 0;
  function nextIndex() {
    if (limit > 0 && reservedCount >= limit) return null;
    const i = startIdx + sharedCursor;
    if (i >= rows.length) return null;
    sharedCursor += 1;
    reservedCount += 1;
    return i;
  }
  async function worker() {
    let myCount = 0;
    while (!fatalStop && !ctx.shouldStop()) {
      if (myCount > 0 && myCount % perEnv === 0) { envCursor += 1; myCount = 0; } // 轮换下一窗口
      const cred = pickEnv();
      const i = nextIndex();
      if (i === null) return;
      myCount += 1;
      await ctx.pausePoint?.("批量转存·条间检查点");
      const rawName = String(rows[i][nameKey] || "").trim();
      const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? ` 提取码:${rows[i][pwdKey]}` : ""));
      const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
      if (!link || !cellPwd) { log(`⏭ 行 ${i + 1} 缺链接或提取码，跳过`); continue; }

      const prev = state.get(srcLink);
      if (prev && prev.status === "done" && prev.ownLink) { if (prev.qaRow) qaRows.push(prev.qaRow); continue; }
      if (prev && (prev.attempts || 0) >= 3) continue;

      const meta = qaLib.parseName(rawName);
      const title = qaLib.buildTitle(meta, i);
      const itemBase = { title, name: rawName.slice(0, 30), bitEnv: cred.env };
      // 预检去重：规范化名已存在（历史或本轮）→ 不再转存
      const preKey = qaLib.normalizeName(rawName);
      if (preKey && preKey.length >= 2 && seenKeys.has(preKey)) {
        log(`⏭ 跳过重复（${preKey}）：${rawName.slice(0, 24)}`);
        continue;
      }

      try {
        const idx = String(i + 1).padStart(5, "0");
        // 目录名带资源名（非占位名时）：08104_资源名，便于网盘里辨识
        const dirLabel = isGenericName(rawName) ? "" : rawName.replace(/[\/:*?"<>|\r\n]/g, " ").trim().slice(0, 20);
        const destDir = `${destRoot}/${cred.env}/${baseName}/${dirLabel ? idx + "_" + dirLabel : idx}`;
        const jar = new Jar(cred.bduss, cred.stoken);
        const { toPaths } = await processOne(jar, {
          link: srcLink, pwd: cellPwd, destDir,
        });

        let ownLink = "", ownPwd = "";
        if (makeShare) {
          const ownPwdR = randomPwd();
          const share = await createShare({ bduss: cred.bduss, stoken: cred.stoken, paths: toPaths, password: ownPwdR });
          if (!share.link) throw new Error("创建分享失败");
          ownLink = `${share.link}?pwd=${share.password}`;
          ownPwd = share.password;
        }

        // 名称质量门槛（不合规跳过问答，资源保留）
        const landedBase = decodeURIComponent((toPaths[0] || "").split("/").pop() || "");
        // 表格名是序号/占位（如 1、1001、链接N）时，改用网盘落盘的真实文件名
        let displayName = isGenericName(rawName) ? (landedBase || "资源") : rawName;
        if (isGenericName(displayName)) displayName = landedBase || displayName;
        // 落盘真实文件名乱码 → 不进问答表（资源已转存，人工可在网盘处理）
        if (qaLib.isGarbledName(decodeURIComponent((toPaths[0] || "").split("/").pop() || ""))) {
          saveState({ srcLink, name: displayName, status: "done", phase: "done", toPaths, ownLink, note: "文件名乱码跳过问答", at: new Date().toISOString() });
          done += 1;
          ctx.emitItem({ ...itemBase, status: "已转存（文件名乱码，跳过问答）" });
          log(`⚠️ ${rawName.slice(0, 24)} 落盘文件名乱码，跳过问答`);
          continue;
        }
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
        const doneKey = qaLib.normalizeName(displayName);
        if (doneKey && doneKey.length >= 2) seenKeys.add(doneKey);
        saveState(okEntry);
        qaRows.push(qaRow);
        done += 1;
        consecutiveFails = 0;
        ctx.emitItem({ ...itemBase, status: "已转存分享", ownLink });
        ctx.report({ done, total, status: "running" });
        log(`✅ [${done}/${total}] ${rawName.slice(0, 26)} → ${ownLink}`);
      } catch (e) {
        if (e.risk) {
          log(`⏸ 触发行控（${(e.message || "").slice(0, 40)}），全局暂停 10 分钟后继续…`);
          await sleep(10 * 60 * 1000);
          continue;
        }
        failed += 1;
        consecutiveFails += 1;
        const attempts = ((prev && prev.attempts) || 0) + 1;
        const failEntry = { srcLink, name: rawName, status: "failed", attempts, error: (e.message || "").slice(0, 120), at: new Date().toISOString() };
        state.set(srcLink, failEntry);
        saveState(failEntry);
        ctx.emitItem({ ...itemBase, status: `转存失败：${(e.message || "").slice(0, 60)}` });
        log(`✗ ${rawName.slice(0, 26)} → ${e.message.slice(0, 70)}`);
        if (e.fatal) { log("⛔ 容量不足，停止本次任务（已完成部分完好）。"); fatalStop = true; break; }
        if (consecutiveFails >= 10) { log(`⚠️ 连续 ${consecutiveFails} 条失败，自动停止（断点已存档）。`); break; }
      }
      await sleep((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cc, total || 1) }, () => worker()));
  ctx.report({ done, total, status: (fatalStop || ctx.shouldStop()) ? "stopped" : "done" });

  // 导出上传专用表
  fs.mkdirSync(outDir, { recursive: true });
  let outputPath = "";
  if (qaRows.length) {
    const ws = XLSX.utils.json_to_sheet(qaRows, { header: ["qid", "问题标题", "回答内容"] });
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
    outputPath = path.join(outDir, `${outName}.xlsx`);
    XLSX.writeFile(wbOut, outputPath);
  }
  const totalOk = [...state.values()].filter((s) => s.status === "done").length;
  log(`=== 批量转存完成 === 本轮成功 ${done} | 失败 ${failed} | 历史累计 ${totalOk}`);
  if (outputPath) log(`上传专用表已生成：${outputPath}（${qaRows.length} 条，可在 Excel 修改后直接上传）`);
  return { count: done, failed, totalOk, outputPath };
}

module.exports = { runBatchTransferTask };
