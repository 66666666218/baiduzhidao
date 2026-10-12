"use strict";

/**
 * 网盘资源转存确权管线（一键全转 · 浏览器执行器版）：
 *
 *   任意格式资源表 → 逐条走五阶段 → 问答 xlsx
 *   ①COLLECT  verify+list：解析每条分享的真实文件清单（元数据缓存）
 *   ②TRANSFER 转存到自己网盘（每条独立子目录，防同名覆盖）
 *   ③CONFIRM  确认落盘（列自己的目录比对文件名——转存成功才算数）
 *   ④SHARE    创建自己的永久分享（share/pset，随机提取码）
 *   ⑤EXPORT   本地生成答题模板问答 xlsx（用自己的链接）
 *
 * 核心保证：问答里填的链接 = 确认落盘之后创建的【自己的】分享链接。
 *
 * ── 执行模型：**串行**，不是并发 ──────────────────────────────────────────
 * 以前这里写着「五阶段并发批处理」并提供了 `--cc-collect/--cc-transfer/--cc-confirm/--cc-share`
 * 四个并发参数。**那是错的，而且危险**：实际执行是 `for (const t of tasks)` 一条一条来，
 * 四个 `--cc-*` 参数解析完就再没人读过（0 个读者），`pool()` 并发池也是死代码。
 * 也就是说：用户按文档调 `--cc-transfer=8` 想提速 8 倍，**不会生效、不报错、不提示** ——
 * 他只会看到它跑了一整夜还是一样慢，然后以为是"百度太慢"。
 *
 * 为什么现在就是串行、也不打算改回并发（这是有意的）：
 *   本脚本走的是**真浏览器上下文**（比特浏览器），所有请求经同一个 page/context 发出，
 *   而 verify → list → transfer 三步共用**同一个 Cookie 罐**（sekey/BDCLND 要透传）。
 *   并发会让几条资源互相覆盖 Cookie，实测表现是 errno=-9 / 解析失败 —— 比慢更糟。
 *   而且它与 `protocol.js`（纯协议、每条资源独立 Cookie 会话、真能并发）是**两套不同架构**，
 *   要并发请用 `tasks/batch-transfer.js`（应用内）或 `scripts/pan-transfer-batch.js`。
 *
 * 所以本文件**唯一**有效的调速手段是 `--delay-min/--delay-max`（每条之间的随机间隔）。
 *
 * 用法：
 *   node scripts/pan-transfer-pipeline.js --input=<资源表.xlsx> [选项]
 *     --limit=N              本次最多处理条数（默认 100；0=全部）
 *     --start=N              跳过前 N 行
 *     --dest=/目录           转存目标根目录（默认 /来自资源批量转存）
 *     --delay-min=2          条间最小间隔秒数（默认 2，**真正生效的调速项**）
 *     --delay-max=5          条间最大间隔秒数（默认 5）
 *     --max-fails=10         连续失败多少条自动停（默认 10）
 *     --share-pwd=abcd       固定自有分享提取码（默认每条随机）
 *     --fresh                忽略历史状态全量重跑
 *
 * 断点续跑：state.jsonl 记录每条所处阶段，重跑自动从断点继续；
 * 风控处理：verify -62/-70（transfer.js 报「触发风控」）→ 阻塞等 5 分钟后继续；
 *           容量不足 errno=12/-10 → 立即优雅停止（已完成部分完好）；
 *           转存 errno=2 → 复检网盘剩余空间，<5GB 则停止。
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { chromium } = require("playwright-core");
const { resolveDataDir, readCdp } = require("../electron/src/data-dir");
const transfer = require("../electron/src/netdisk/transfer");
// 4 位随机提取码也在这里（原本 pipeline / batch-transfer / netdisk-share-existing 各写一份）
const { createShare, randomPwd } = require("../electron/src/netdisk/share");
// 表单元格 → {link, pwd}：四份拷贝已收敛到这一处（pan-transfer-ui.js 曾因拷贝漏改而整表静默跳过）
const { parseLinkCell } = require("../electron/src/netdisk/pan-link");
// 「哪一列是名称/链接/提取码」：本文件原本有自己的 detectColumns，现已与另外三处合并成一份
const { detectColumns } = require("../electron/src/netdisk/table-columns");
// 转存台账（state.jsonl）：原本五份，收敛到一处
const { loadLedger, appendLedger } = require("../electron/src/netdisk/state-ledger");
// 读 xlsx 统一走 storage/excel.js 的 readTableRows（本文件不再自己 XLSX.readFile）
const excel = require("../electron/src/storage/excel");
const qaLib = require("../electron/src/netdisk/qa-template-lib");

const root = path.resolve(__dirname, "..");
const cacheDir = path.join(resolveDataDir(root), "transfer-pipeline");

// ---------- 参数 ----------
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/i);
  if (m) args[m[1]] = m[2];
  else args[a.replace(/^--/, "")] = true;
}
if (!args.input) {
  console.error("用法: node scripts/pan-transfer-pipeline.js --input=<资源表.xlsx> [--limit=100] [--delay-min=2] [--delay-max=5]");
  process.exit(1);
}
const inputFile = path.resolve(args.input);
const limit = args.limit !== undefined ? Math.max(0, Number(args.limit)) : 100;
const destRoot = args.dest || "/来自资源批量转存";
const fixedPwd = typeof args["share-pwd"] === "string" ? args["share-pwd"] : "";

// ── 已失效的参数：**必须吼出来**，不能静默忽略 ────────────────────────────────
// 这个脚本是串行的（原因见文件头「执行模型」），`--cc-*` 与 `--pace-ms` 都没有读者。
// 静默忽略是最坏的处理：用户以为自己在提速，实际参数被吞了，跑一夜还是那么慢，
// 最后怪到"百度限速"头上。所以只要他显式传了，就在这里点名。
const DEAD_FLAGS = ["cc-collect", "cc-transfer", "cc-confirm", "cc-share", "pace-ms"];
const passedDead = DEAD_FLAGS.filter((k) => args[k] !== undefined);
if (passedDead.length) {
  console.log(`⚠️ 忽略无效参数：${passedDead.map((k) => `--${k}`).join("、")}`);
  console.log("   本脚本是**串行**执行的（真浏览器 + 共用 Cookie 罐，并发会互相覆盖导致 errno=-9），"
    + "所以并发参数没有任何效果。要调速度请用 --delay-min / --delay-max（条间间隔秒数）。");
  console.log("   要真正的并发跑批，请用 tasks/batch-transfer.js（应用内）或 scripts/pan-transfer-batch.js（纯协议）。");
}

const baseName = path.basename(inputFile).replace(/\.xlsx$/i, "").slice(0, 40);
const workDir = path.join(cacheDir, baseName);
const stateFile = path.join(workDir, "state.jsonl");
const outDir = path.join(workDir, "问答输出");

// ---------- 状态 ----------
// 台账读写收敛到 netdisk/state-ledger.js（本文件原本自己抄了一份）
const ledgerState = loadLedger(stateFile, "srcLink");
const saveState = (entry) => appendLedger(stateFile, entry);
const sleep = transfer.sleep;

// ⚠️ 这里原本还有一份 `pool()` 并发池 + `gate`/`waitGate()`/`tripPause()` 全局限频闸门，
// **三样都没有调用方**（死代码）。留着比删掉更糟：它让人以为「这脚本是并发的、有全局暂停机制」，
// 于是按文档去调 `--cc-*` 参数 —— 而那些参数同样**没有读者**。详见文件头「执行模型」一节。
// 删掉，别再误导。

// 注：表格列识别（detectColumns）与 4 位随机提取码（randomPwd）原本也在本文件里各有一份，
// 第 14 轮分别收敛到 netdisk/table-columns.js 与 netdisk/share.js（都从上面 require 进来）。

// ---------- 主流程 ----------
(async () => {
  // 0) 读表 + 识别列
  // 读表统一走 storage/excel.js（全仓唯一入口）。raw:false 不能省 —— 提取码带前导零时会丢数据。
  const rows = excel.readTableRows(inputFile, { raw: false });
  if (!rows.length) { console.error("资源表为空"); process.exit(1); }
  const { nameKey, linkKey, pwdKey, nameDegraded } = detectColumns(rows[0]);
  console.log(`资源表 ${rows.length} 行 | 列识别: 名称="${nameKey}" 链接="${linkKey}" 提取码="${pwdKey || "(自动抠取)"}"`);
  if (nameDegraded) {
    console.log(`⚠️ 这张表没有可用的「名称」列（现在拿"${nameKey}"凑数），资源名不可信 ——`
      + "建议加一列「名称」或「标题」，否则出题标题会是链接/提取码。");
  }

  // 1) 构建任务清单（过滤无效行 + 断点分类）
  const state = args.fresh ? new Map() : ledgerState;
  const tasks = [];
  let junk = 0;
  const startIdx = Math.max(0, Number(args.start) || 0);
  for (let i = startIdx; i < rows.length; i += 1) {
    const row = rows[i];
    const rawName = String(row[nameKey] || "").trim();
    const { link, pwd: cellPwd } = parseLinkCell(`${row[linkKey] || ""}${pwdKey ? " 提取码:" + row[pwdKey] : ""}`);
    if (!link || qaLib.reject(rawName, link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`))) { junk += 1; continue; }
    const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
    const prev = state.get(srcLink);
    const attempts = (prev && prev.attempts) || 0;
    if (prev && prev.status !== "done" && attempts >= 3) { junk += 1; continue; } // 反复失败的黑名单条目（疑似被单条风控拉黑）
    const phase = prev && prev.status === "done" ? "done" : (prev && prev.phase) || "new";
    const t = { idx: i, rawName, srcLink, phase, entry: prev || null, attempts };
    // 断点恢复：阶段①已采集的条目要把元数据带回（否则阶段②崩溃）
    if (t.phase === "collected" && prev && prev.meta) t.meta = prev.meta;
    tasks.push(t);
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
  // 统一走 data-dir.js（原来的手工存在性检查只说了"没有"，没告诉用户去哪儿开）
  const cdp = readCdp(resolveDataDir(root));
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
  // 分享会话互斥锁：verify/BDCLND/list 共用一个 Cookie 罐，必须串行（否则互相覆盖导致 -9/解析失败）
  const MAX_CONSECUTIVE_FAILS = Math.max(5, Number(args["max-fails"]) || 10);
  const delayMinS = Math.max(1, Number(args["delay-min"]) || 2);
  const delayMaxS = Math.max(delayMinS, Number(args["delay-max"]) || 5);
  let collectChain = Promise.resolve();
  function withCollectLock(fn) {
    const run = collectChain.then(fn, fn);
    collectChain = run.catch(() => {});
    return run;
  }

  // ─── 单条完整链：采集→转存→确认→分享（同一 Cookie 会话内串行，保证 BDCLND 一致） ───
  const quota = async () => {
    const q = await exe.call(`/api/quota?checkfree=1&checkexpire=1&web=1`).catch(() => ({}));
    if (q.errno !== 0 || !q.total) return null;
    return { freeGB: (q.total - q.used) / 1024 ** 3, totalGB: q.total / 1024 ** 3 };
  };
  const quota0 = await quota();
  if (quota0) {
    console.log(`网盘空间：总 ${quota0.totalGB.toFixed(0)}GB | 剩余 ${quota0.freeGB.toFixed(1)}GB`);
    if (quota0.freeGB < 10) {
      console.log("⛔ 剩余空间不足 10GB——转存必然失败。处理：① 扩容 ② 清理网盘 ③ 换大空间账号窗口。");
      await browser.close();
      process.exit(3);
    }
  }

  let done = 0, failed = 0, consecutiveFails = 0;
  const qaRows = [];
  for (const t of tasks) {
    if (fatalStop) break;
    // 注意：`tasks` 在上文已经过滤成"未完成"的条目（pendingTasks），
    // 所以这里永远进不去 —— 留着当防御，别指望它做实际的事。
    if (t.phase === "done") { if (t.qaRow) qaRows.push(t.qaRow); continue; }
    const entryBase = { srcLink: t.srcLink, name: t.rawName };
    try {
      // ① 采集
      if (t.phase === "new" || t.phase === "failed") {
        const resolved = await transfer.resolveShare(exe, { link: t.srcLink });
        t.meta = { shareid: resolved.shareid, from: resolved.from, sekey: resolved.sekey, bdstoken: resolved.bdstoken, files: resolved.files, sharePageUrl: resolved.sharePageUrl };
        t.phase = "collected";
        saveState({ ...entryBase, status: "pending", phase: "collected", meta: t.meta, at: new Date().toISOString() });
      }
      // ② 转存
      if (t.phase === "collected") {
        const idx = String(t.idx + 1).padStart(5, "0");
        t.destDir = `${destRoot}/${baseName}/${idx}`;
        const r = await transfer.transferFiles(exe, {
          shareid: t.meta.shareid, from: t.meta.from, sekey: t.meta.sekey,
          files: t.meta.files, destDir: t.destDir, bdstoken: t.meta.bdstoken,
          sharePageUrl: t.meta.sharePageUrl || t.srcLink,
        });
        if (r.errno === 12 || r.errno === -10) throw Object.assign(new Error("网盘容量不足"), { fatal: true });
        if (r.errno !== 0) throw new Error(`转存 errno=${r.errno} ${r.show_msg || ""}`);
        t.phase = "transferred";
        saveState({ ...entryBase, status: "pending", phase: "transferred", destDir: t.destDir, at: new Date().toISOString() });
      }
      // ③ 确认落盘
      if (t.phase === "transferred") {
        const names = t.meta.files.map((f) => f.path.split("/").pop());
        const v = await transfer.verifyTransferred(exe, { destDir: t.destDir, expectNames: names });
        if (!v.ok) throw new Error(`落盘确认失败 ${v.found.length}/${names.length}`);
        t.phase = "confirmed";
        saveState({ ...entryBase, status: "pending", phase: "confirmed", at: new Date().toISOString() });
      }
      // ④ 自有分享
      if (t.phase === "confirmed") {
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
          回答内容: qaLib.buildAnswerHtml(t.ownLink, qaLib.buildIntro(meta)),
        };
        qaRows.push(t.qaRow);
        done += 1;
        consecutiveFails = 0;
        saveState({ ...entryBase, status: "done", phase: "done", ownLink: t.ownLink, ownPwd: t.ownPwd, qaRow: t.qaRow, at: new Date().toISOString() });
        console.log(`  ✅ [${stamp()}] ${t.rawName.slice(0, 26)} → ${t.ownLink}`);
      }
    } catch (e) {
      failed += 1;
      consecutiveFails += 1;
      t.attempts = (t.attempts || 0) + 1;
      t.phase = t.phase === "new" ? "failed" : t.phase; // 已转存的保留阶段，重跑从断点续
      saveState({ ...entryBase, status: "failed", phase: t.phase, attempts: t.attempts, error: (e.message || "").slice(0, 120), at: new Date().toISOString() });
      console.log(`  ✗ [${stamp()}] ${t.rawName.slice(0, 26)} → ${e.message.slice(0, 70)}`);
      if (e.fatal) { console.log("⛔ 致命错误，停止（已完成条目完好，重跑续传）"); break; }
      if (/errno=2/.test(e.message)) {
        const q = await quota();
        if (q && q.freeGB < 5) { console.log(`⛔ 复检确认剩余仅 ${q.freeGB.toFixed(1)}GB——空间已满，自动停止。`); fatalStop = true; break; }
      }
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        console.log(`⚠️ 连续 ${MAX_CONSECUTIVE_FAILS} 条失败，疑似风控/接口变化，自动停止。`);
        break;
      }
      if (/风控/.test(e.message)) { console.log("  ⏸ 风控信号，暂停 5 分钟…"); await sleep(5 * 60 * 1000); }
    }
    await sleep((delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000);
  }

  // ─── 阶段⑤ EXPORT：问答 xlsx ───
  // 导出**一律以 state.jsonl 里的全量历史为准**，不是只看本轮 `tasks`。
  // 原因：`tasks` 上文已被过滤成"未完成"的条目（pendingTasks），里面**永远没有** phase==="done"，
  // 所以"先从 tasks 里取、空了再回落到 state"这种写法实际上永远走回落分支 ——
  // 它现在能用，但纯粹是靠巧合。一旦有人改动上面的 limit/过滤逻辑，导出就会被**静默截断**
  // （只出本轮完成的，历史累积的问答全丢，而文件照样生成、没有报错）。
  const doneRows = [...state.values()].filter((s) => s.status === "done" && s.qaRow).map((s) => s.qaRow);
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
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 180)); process.exit(1); });
