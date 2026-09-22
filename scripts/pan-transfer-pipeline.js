"use strict";

/**
 * 网盘资源转存确权管线（一键全转 · 批处理版）：
 *
 *   任意格式资源表 → 【五阶段并发批处理】→ 问答 xlsx
 *   ①COLLECT  并发 verify+list：解析每条分享的真实文件清单（元数据缓存）
 *   ②TRANSFER 并发转存到自己网盘（每条独立子目录，防同名覆盖）
 *   ③CONFIRM  并发确认落盘（列自己的目录比对文件名——转存成功才算数）
 *   ④SHARE    并发创建自己的永久分享（share/pset，随机提取码）
 *   ⑤EXPORT   本地生成答题模板问答 xlsx（用自己的链接）
 *
 * 核心保证：问答里填的链接 = 确认落盘之后创建的【自己的】分享链接。
 *
 * 断点续跑：state.jsonl 记录每条所处阶段，重跑自动从断点继续；
 * 风控自愈：verify errno=2 / -62 / -70 → 全局暂停 10 分钟自动恢复；
 *           容量不足 errno=12/-10 → 立即优雅停止（已完成部分完好）。
 *
 * 用法：
 *   node scripts/pan-transfer-pipeline.js --input=<资源表.xlsx> [选项]
 *     --limit=N              本次最多处理条数（默认 100；0=全部）
 *     --cc-collect=4         阶段①并发数（默认 4）
 *     --cc-transfer=3        阶段②并发数（默认 3）
 *     --cc-confirm=5         阶段③并发数（默认 5）
 *     --cc-share=2           阶段④并发数（默认 2）
 *     --pace-ms=1500         同阶段相邻请求间隔（默认 1500，防风控）
 *     --dest=/目录           转存目标根目录（默认 /来自资源批量转存）
 *     --share-pwd=abcd       固定自有分享提取码（默认每条随机）
 *     --no-img               回答不带空 img 标签（默认按模板保留）
 *     --fresh                忽略历史状态全量重跑
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { chromium } = require("playwright-core");
const transfer = require("../electron/src/netdisk/transfer");
const { createShare } = require("../electron/src/netdisk/share");
const qaLib = require("./qa-template-lib");

const root = path.resolve(__dirname, "..");
const cacheDir = path.join(root, "运行缓存", "transfer-pipeline");

// ---------- 参数 ----------
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/i);
  if (m) args[m[1]] = m[2];
  else args[a.replace(/^--/, "")] = true;
}
if (!args.input) {
  console.error("用法: node scripts/pan-transfer-pipeline.js --input=<资源表.xlsx> [--limit=100] [--cc-transfer=3] ...");
  process.exit(1);
}
const inputFile = path.resolve(args.input);
const limit = args.limit !== undefined ? Math.max(0, Number(args.limit)) : 100;
const destRoot = args.dest || "/来自资源批量转存";
const cc = {
  collect: Math.max(1, Number(args["cc-collect"]) || 4),
  transfer: Math.max(1, Number(args["cc-transfer"]) || 3),
  confirm: Math.max(1, Number(args["cc-confirm"]) || 5),
  share: Math.max(1, Number(args["cc-share"]) || 2),
};
const paceMs = Math.max(300, Number(args["pace-ms"]) || 1500);
const keepImg = !args["no-img"];
const fixedPwd = typeof args["share-pwd"] === "string" ? args["share-pwd"] : "";

const baseName = path.basename(inputFile).replace(/\.xlsx$/i, "").slice(0, 40);
const workDir = path.join(cacheDir, baseName);
const stateFile = path.join(workDir, "state.jsonl");
const outDir = path.join(workDir, "问答输出");

// ---------- 状态 ----------
function loadState() {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(stateFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); map.set(r.srcLink, r); } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 首次运行 */ }
  return map;
}
function saveState(entry) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.appendFileSync(stateFile, JSON.stringify(entry) + "\n");
}
function randomPwd() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
const sleep = transfer.sleep;

/** 并发池：按并发数处理任务列表（任务内部自己 pacing） */
async function pool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try { await worker(items[idx], idx); } catch (e) { /* worker 自捕获 */ }
      await sleep(paceMs + Math.random() * paceMs);
    }
  });
  await Promise.all(runners);
}

// ---------- 全局限频控制 ----------
const gate = { pausedUntil: 0 };
async function waitGate() {
  if (gate.pausedUntil > Date.now()) {
    const waitS = Math.ceil((gate.pausedUntil - Date.now()) / 1000);
    console.log(`  ⏸ 全局限频暂停中，剩余 ${waitS}s…`);
    await sleep(Math.min(gate.pausedUntil - Date.now(), 60000));
    return waitGate();
  }
}
function tripPause(minutes, reason) {
  const until = Date.now() + minutes * 60 * 1000;
  if (until > gate.pausedUntil) {
    gate.pausedUntil = until;
    console.log(`  ⏸ ${reason} → 全局暂停 ${minutes} 分钟（自动恢复）`);
  }
}

// ---------- 表格列识别（适应任意格式） ----------
function detectColumns(firstRow) {
  const keys = Object.keys(firstRow);
  const findKey = (patterns) => keys.find((k) => patterns.some((p) => k.toLowerCase().includes(p)));
  let nameKey = findKey(["文件名", "名称", "资源名", "标题", "片名", "书名"]);
  let linkKey = findKey(["链接", "网址", "url"]);
  let pwdKey = findKey(["提取码", "密码", "访问码"]);
  for (const k of keys) {
    const v = String(firstRow[k] || "");
    if (!linkKey && /pan\.baidu\.com\/s\//.test(v)) linkKey = k;
    if (!pwdKey && /^[a-z0-9]{4}$/i.test(v.trim()) && k !== linkKey) pwdKey = k;
  }
  if (!nameKey) nameKey = keys.find((k) => k !== linkKey && k !== pwdKey) || keys[0];
  if (!linkKey) linkKey = keys[1] || keys[0];
  return { nameKey, linkKey, pwdKey };
}
function parseLinkCell(text) {
  const s = String(text || "");
  const link = (s.match(/https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i) || [])[0] || "";
  let pwd = (s.match(/[?&]pwd=([a-z0-9]{4})/i) || [])[1] || "";
  if (!pwd) pwd = (s.match(/(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i) || [])[1] || "";
  return { link, pwd };
}

// ---------- 主流程 ----------
(async () => {
  // 0) 读表 + 识别列
  const wb = XLSX.readFile(inputFile);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  if (!rows.length) { console.error("资源表为空"); process.exit(1); }
  const { nameKey, linkKey, pwdKey } = detectColumns(rows[0]);
  console.log(`资源表 ${rows.length} 行 | 列识别: 名称="${nameKey}" 链接="${linkKey}" 提取码="${pwdKey || "(自动抠取)"}"`);

  // 1) 构建任务清单（过滤无效行 + 断点分类）
  const state = args.fresh ? new Map() : loadState();
  const tasks = [];
  let junk = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rawName = String(row[nameKey] || "").trim();
    const { link, pwd: cellPwd } = parseLinkCell(`${row[linkKey] || ""}${pwdKey ? " 提取码:" + row[pwdKey] : ""}`);
    if (!link || qaLib.reject(rawName, link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`))) { junk += 1; continue; }
    const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
    const prev = state.get(srcLink);
    const phase = prev && prev.status === "done" ? "done" : (prev && prev.phase) || "new";
    tasks.push({ idx: i, rawName, srcLink, phase, entry: prev || null });
  }
  // limit 只作用于未完成条目（已完成的不占配额）
  const doneTasks = tasks.filter((t) => t.phase === "done");
  let pendingTasks = tasks.filter((t) => t.phase !== "done");
  if (limit > 0) pendingTasks = pendingTasks.slice(0, limit);
  tasks.length = 0;
  tasks.push(...pendingTasks);
  const byPhase = { new: 0, collected: 0, transferred: 0, confirmed: 0, done: 0, failed: 0 };
  for (const t of tasks) byPhase[t.phase] = (byPhase[t.phase] || 0) + 1;
  console.log(`本轮任务 ${tasks.length} 条（历史已完成 ${doneTasks.length} 条不占配额，脏数据剔除 ${junk}）| 阶段分布:`, JSON.stringify(byPhase));

  // 2) 连接比特浏览器（浏览器执行器 = 真实指纹过风控）
  const cdpFile = path.join(root, "运行缓存", "cdp.txt");
  if (!fs.existsSync(cdpFile)) { console.error("没有 运行缓存/cdp.txt（比特浏览器未连接）"); process.exit(1); }
  const cdp = fs.readFileSync(cdpFile, "utf8").trim();
  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const context = browser.contexts()[0];
  let panPage = context.pages().find((p) => p.url().includes("pan.baidu.com"));
  if (!panPage) {
    panPage = await context.newPage();
    await panPage.goto("https://pan.baidu.com/disk/main", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await sleep(3000);
  }
  const cookies = await context.cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  if (!bduss) { console.error("❌ 浏览器无 pan.baidu.com 登录态（BDUSS）"); process.exit(1); }
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const exe = transfer.createBrowserExecutor(panPage);
  console.log("比特浏览器执行器就绪");

  let fatalStop = false;
  const stamp = () => new Date().toISOString().slice(11, 19);

  // ─── 阶段① COLLECT：verify + list 元数据 ───
  const toCollect = tasks.filter((t) => t.phase === "new" || t.phase === "failed");
  console.log(`\n[阶段① 采集] 待处理 ${toCollect.length} 条（并发 ${cc.collect}）`);
  await pool(toCollect, cc.collect, async (t) => {
    await waitGate();
    try {
      const resolved = await transfer.resolveShare(exe, { link: t.srcLink });
      t.meta = { shareid: resolved.shareid, from: resolved.from, sekey: resolved.sekey, bdstoken: resolved.bdstoken, files: resolved.files };
      t.phase = "collected";
      const entry = { srcLink: t.srcLink, name: t.rawName, status: "pending", phase: "collected", meta: t.meta, at: new Date().toISOString() };
      state.set(t.srcLink, entry);
      saveState(entry);
      logLine(`  ①✓ [${stamp()}] ${t.rawName.slice(0, 26)} (${resolved.files.length}文件)`);
    } catch (e) {
      handleCollectError(t, e);
    }
  });
  function handleCollectError(t, e) {
    const msg = e.message || "";
    t.phase = "failed";
    const entry = { srcLink: t.srcLink, name: t.rawName, status: "failed", phase: "failed", error: msg.slice(0, 120), at: new Date().toISOString() };
    state.set(t.srcLink, entry);
    saveState(entry);
    logLine(`  ①✗ [${stamp()}] ${t.rawName.slice(0, 26)} → ${msg.slice(0, 60)}`);
    if (msg.includes("errno=2") || msg.includes("风控")) tripPause(10, "verify 限频/风控");
  }

  // ─── 阶段② TRANSFER：转存到自己网盘 ───
  const toTransfer = tasks.filter((t) => t.phase === "collected");

  // 容量预检：空间不足直接停（转存接口对容量不足误报 errno=2"文件已存在"）
  const checkQuota = async () => {
    const q = await exe.call(`/api/quota?checkfree=1&checkexpire=1&web=1`).catch(() => ({}));
    if (q.errno !== 0 || !q.total) return null;
    return { freeGB: (q.total - q.used) / 1024 ** 3, totalGB: q.total / 1024 ** 3 };
  };
  const quota0 = await checkQuota();
  if (quota0) {
    console.log(`网盘空间：总 ${quota0.totalGB.toFixed(0)}GB | 剩余 ${quota0.freeGB.toFixed(1)}GB`);
    if (quota0.freeGB < 10) {
      console.log("⛔ 剩余空间不足 10GB——转存必然失败（百度会误报“文件已存在”）。");
      console.log("   处理：① 开通/续费 SVIP 扩容 ② 清理网盘空间 ③ 换大空间账号的浏览器窗口。");
      console.log("   管线停止（已采集元数据保留，扩容后重跑自动续传）。");
      await browser.close();
      process.exit(3);
    }
  }

  console.log(`\n[阶段② 转存] 待处理 ${toTransfer.length} 条（并发 ${cc.transfer}）`);
  await pool(toTransfer, cc.transfer, async (t) => {
    await waitGate();
    try {
      const idx = String(t.idx + 1).padStart(5, "0");
      const destDir = `${destRoot}/${baseName}/${idx}`;
      const r = await transfer.transferFiles(exe, {
        shareid: t.meta.shareid, from: t.meta.from, sekey: t.meta.sekey,
        files: t.meta.files, destDir, bdstoken: t.meta.bdstoken,
      });
      if (r.errno === 12 || r.errno === -10) throw Object.assign(new Error("网盘容量不足"), { fatal: true });
      if (r.errno === 2) throw Object.assign(new Error("errno=2：大概率容量不足（百度误报“文件已存在”）"), { capacityHint: true });
      if (r.errno !== 0) throw new Error(`转存 errno=${r.errno} ${r.show_msg || ""}`);
      t.phase = "transferred";
      t.destDir = destDir;
      updateState(t, { phase: "transferred", destDir });
      logLine(`  ②✓ [${stamp()}] ${t.rawName.slice(0, 26)} → ${destDir}`);
    } catch (e) {
      if (e.capacityHint) {
        const q = await checkQuota();
        if (q && q.freeGB < 5) {
          console.log(`⛔ 复检确认剩余空间仅 ${q.freeGB.toFixed(1)}GB——容量不足，管线停止。扩容后重跑自动续传。`);
          fatalStop = true;
          return;
        }
      }
      if (e.fatal) { fatalStop = true; t.phase = "collected"; logLine(`  ⛔ ${e.message} — 管线将在本阶段后停止`); return; }
      t.phase = "failed";
      updateState(t, { phase: "failed", error: (e.message || "").slice(0, 120) });
      logLine(`  ②✗ [${stamp()}] ${t.rawName.slice(0, 26)} → ${e.message.slice(0, 60)}`);
    }
  });

  // ─── 阶段③ CONFIRM：确认落盘 ───
  const toConfirm = tasks.filter((t) => t.phase === "transferred");
  console.log(`\n[阶段③ 确认落盘] 待处理 ${toConfirm.length} 条（并发 ${cc.confirm}）`);
  await pool(toConfirm, cc.confirm, async (t) => {
    await waitGate();
    try {
      const names = t.meta.files.map((f) => f.path.split("/").pop());
      const v = await transfer.verifyTransferred(exe, { destDir: t.destDir, expectNames: names });
      if (!v.ok) throw new Error(`落盘确认失败 ${v.found.length}/${names.length}`);
      t.phase = "confirmed";
      updateState(t, { phase: "confirmed" });
      logLine(`  ③✓ [${stamp()}] ${t.rawName.slice(0, 26)} 已确认在网盘`);
    } catch (e) {
      t.phase = "failed";
      updateState(t, { phase: "failed", error: (e.message || "").slice(0, 120) });
      logLine(`  ③✗ [${stamp()}] ${t.rawName.slice(0, 26)} → ${e.message.slice(0, 60)}`);
    }
  });

  // ─── 阶段④ SHARE：创建自己的永久分享 ───
  const toShare = tasks.filter((t) => t.phase === "confirmed");
  console.log(`\n[阶段④ 自有分享] 待处理 ${toShare.length} 条（并发 ${cc.share}）`);
  await pool(toShare, cc.share, async (t) => {
    await waitGate();
    try {
      const ownPwd = fixedPwd || randomPwd();
      const share = await createShare({
        bduss, stoken,
        paths: t.meta.files.map((f) => `${t.destDir}/${f.path.split("/").pop()}`),
        password: ownPwd,
      });
      if (!share.link) throw new Error("创建分享失败");
      t.ownLink = `${share.link}?pwd=${share.password}`;
      t.ownPwd = share.password;
      t.phase = "done";
      const meta = qaLib.parseName(t.rawName);
      t.qaRow = {
        qid: "",
        问题标题: qaLib.buildTitle(meta, t.idx),
        回答内容: qaLib.buildAnswerHtml(t.ownLink, qaLib.buildIntro(meta), keepImg),
      };
      updateState(t, { phase: "done", status: "done", ownLink: t.ownLink, ownPwd: t.ownPwd, qaRow: t.qaRow });
      logLine(`  ④✓ [${stamp()}] ${t.rawName.slice(0, 26)} → ${t.ownLink}`);
    } catch (e) {
      t.phase = "failed";
      updateState(t, { phase: "failed", error: (e.message || "").slice(0, 120) });
      logLine(`  ④✗ [${stamp()}] ${t.rawName.slice(0, 26)} → ${e.message.slice(0, 60)}`);
    }
  });

  // ─── 阶段⑤ EXPORT：问答 xlsx ───
  const doneRows = tasks.filter((t) => t.phase === "done" && t.qaRow).map((t) => t.qaRow);
  if (!doneRows.length) doneRows.push(...[...state.values()].filter((s) => s.status === "done" && s.qaRow).map((s) => s.qaRow));
  const chunk = 5000;
  const chunks = Math.ceil(doneRows.length / chunk);
  for (let c = 0; c < chunks; c += 1) {
    const part = doneRows.slice(c * chunk, (c + 1) * chunk);
    const ws = XLSX.utils.json_to_sheet(part, { header: ["qid", "问题标题", "回答内容"] });
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
    fs.mkdirSync(outDir, { recursive: true });
    XLSX.writeFile(wbOut, path.join(outDir, `问答-第${c + 1}批-${part.length}条.xlsx`));
  }

  const finalCount = { done: 0, failed: 0 };
  for (const t of tasks) finalCount[t.phase === "done" ? "done" : t.phase === "failed" ? "failed" : "other"] = (finalCount[t.phase === "done" ? "done" : t.phase === "failed" ? "failed" : "other"] || 0) + 1;
  console.log("\n=== 一键全转完成 ===");
  console.log(`本轮: 完成 ${finalCount.done || 0} | 失败 ${finalCount.failed || 0} | 中途其他阶段 ${finalCount.other || 0}${fatalStop ? "（因容量不足提前停止）" : ""}`);
  console.log(`历史累计完成: ${[...state.values()].filter((s) => s.status === "done").length} 条`);
  if (doneRows.length) console.log(`问答输出: ${outDir}`);
  console.log(`状态文件: ${stateFile}（重跑自动断点续传）`);
  await browser.close();
  process.exit(0);

  // ---------- helpers ----------
  function updateState(t, patch) {
    const prev = state.get(t.srcLink) || {};
    const entry = { srcLink: t.srcLink, name: t.rawName, status: patch.phase === "done" ? "done" : "pending", ...prev, ...patch, at: new Date().toISOString() };
    state.set(t.srcLink, entry);
    saveState(entry);
  }
  function logLine(m) { console.log(m); }
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 180)); process.exit(1); });
