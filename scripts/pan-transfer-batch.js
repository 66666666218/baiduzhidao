"use strict";

/**
 * 网盘资源转存确权管线（纯协议版 · 高速批量）：
 *   输入 txt（一行一个链接）或 xlsx → 纯 HTTP 协议逐条：
 *   verify → 分享页解析(mset) → 建目标目录 → fsidlist 转存 → 创建自有永久分享 → 按答题模板出问答行
 *
 * ⚠️ 本脚本**不再自己实现协议链**。以前这里抄了一份 `Jar` / `makeClient` / `processOne`，
 * 抄的那份落后主实现一大截，后果都不是"少个功能"，而是会**静默做错事**：
 *   · 直接 `fetch(`，没有 dispatcher（代理）也没有超时 → 同一批操作从两个 IP 发出、
 *     或某条请求永久吊住而日志一片安静；
 *   · 没有 分享页无 mset 的重试/退避 → 跑批时把限流误判成"链接失效"，白丢资源；
 *   · 没有 errno=2（目的路径不存在）回落顶层目录 → 建目录偶发失败就整条报废；
 *   · 没有 errno=4（已转存）的路径拼装回落 → 每轮把同一条资源当"失败"重来一遍；
 *   · 没有 info[0].errno 提升 → 容量不足（-9）被当成"成功但未取得落盘路径"；
 *   · 没有 0 字节占位过滤 / 递归目录展开 / 建目录缓存。
 * 现在统一 require 主实现（electron/src/netdisk/protocol.js），上面这些改进自动跟着走。
 * 「一份逻辑只有一个家」——这也是仓库里反复写下来的约定（见 domain/account-topic.js 的 dedupeEnvLabels）。
 *
 * 断点续跑（state.jsonl）/ 失败3次黑名单 / 连续失败熔断 / errno=4 已存在复用。
 *
 * 用法：
 *   node scripts/pan-transfer-batch.js --input=<链接.txt 或 资源.xlsx> [选项]
 *     --start=N        跳过前 N 行（默认 0）
 *     --limit=N        本次处理条数（默认 50；0=全部）
 *     --cc=N           并发数（默认 4）
 *     --dest=/目录     转存目标根目录（默认 /来自资源批量转存）
 *     --out-dir=目录   上传专用表输出目录
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { chromium } = require("playwright-core");
const { resolveDataDir, readCdp } = require("../electron/src/data-dir");
// —— 协议链、Cookie 罐、客户端、分享创建：全部走主实现，本文件不再重复定义 ——
const { Jar, makeClient, processOne } = require("../electron/src/netdisk/protocol");
const { SHARE_DAILY_LIMIT, SHARE_SOFT_WARN_AT } = require("../electron/src/netdisk/share");
// 表单元格 → {link, pwd}：四份拷贝已收敛到这一处（pan-transfer-ui.js 曾因拷贝漏改而整表静默跳过）
const { parseLinkCell } = require("../electron/src/netdisk/pan-link");
// 「share_failed 的行重跑时要不要补分享 / 要不要彻底跳过」——判断只此一处（见该文件头）
const { planShareRetry, shareRetryFields } = require("../electron/src/netdisk/share-retry");
// 「哪一列是名称/链接/提取码」：原本四处、三种算法，收敛到一处（本文件原本就是弱的那份）
const { detectColumns } = require("../electron/src/netdisk/table-columns");
// 转存台账（state.jsonl）：原本五份，收敛到一处
const { loadLedger, appendLedger } = require("../electron/src/netdisk/state-ledger");
// 读 xlsx 统一走 storage/excel.js 的 readTableRows（本文件不再自己 XLSX.readFile）
const excel = require("../electron/src/storage/excel");
const qaLib = require("../electron/src/netdisk/qa-template-lib");
// isGenericName 原本只写在 batch-transfer.js 里、没导出，本脚本却直接用 ——
// 跑到 288/307 行就 ReferenceError（契约⑥ 扫出来的）。
// runShareStep 同理：分享是**独立失败域**（见其注释），抄一份必然与主实现漂移。
const { isGenericName, runShareStep } = require("../electron/src/tasks/batch-transfer");

const root = path.resolve(__dirname, "..");

// ---------- 参数 ----------
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/i);
  if (m) args[m[1]] = m[2];
  else args[a.replace(/^--/, "")] = true;
}
if (!args.input) { console.error("用法: node scripts/pan-transfer-batch.js --input=<txt|xlsx> [--limit=50] [--cc=4]"); process.exit(1); }
const inputFile = path.resolve(args.input);
const startIdx = Math.max(0, Number(args.start) || 0);
const _limN = Number(args.limit);
const limit = args.limit !== undefined && Number.isFinite(_limN) ? Math.max(0, _limN) : 50;
const CC = Math.max(1, Number(args.cc) || 4);
const paceMs = Math.max(300, Number(args["pace-ms"]) || 1200);
const destRoot = args.dest || "/来自资源批量转存";

const baseName = path.basename(inputFile).replace(/\.(xlsx|txt)$/i, "").slice(0, 40);
const workDir = path.join(resolveDataDir(root), "transfer-batch", baseName);
const stateFile = path.join(workDir, "state.jsonl");
const outDir = args["out-dir"] ? path.resolve(args["out-dir"]) : path.join(workDir, "上传专用表");

// 台账读写收敛到 netdisk/state-ledger.js（本文件原本自己抄了一份）
const state = loadLedger(stateFile, "srcLink");
const saveState = (e) => appendLedger(stateFile, e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

// ---------- 主流程 ----------
(async () => {
  // 0) 输入
  let rows;
  if (/\.txt$/i.test(inputFile)) {
    const lines = fs.readFileSync(inputFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    rows = lines.map((line, i) => ({ __name: `链接${i + 1}`, __link: line }));
  } else {
    // 读表统一走 storage/excel.js（全仓唯一入口）。raw:false 不能省 —— 提取码带前导零时会丢数据。
    rows = excel.readTableRows(inputFile, { raw: false });
  }
  const keys = Object.keys(rows[0]);
  const { nameKey, linkKey, pwdKey, nameDegraded } = detectColumns(rows);
  console.log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);
  if (nameDegraded) {
    console.log(`⚠️ 这张表没有可用的「名称」列（现在拿"${nameKey}"凑数），资源名不可信 ——`
      + "建议加一列「名称」或「标题」，否则出题标题会是链接/提取码。");
  }

  // 1) 凭证（从比特浏览器提取一次，之后全程纯 HTTP）
  // 读 CDP 端口统一走 data-dir.js：新电脑上「运行缓存/」根本不存在（.gitignore 忽略），
  // 以前这里直接 readFileSync，用户看到的是裸 ENOENT，既不知道要开比特浏览器、
  // 也不知道那个目录本来就是 git 忽略、从没被创建过。
  const cdp = readCdp(resolveDataDir(root));
  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const cookies = await browser.contexts()[0].cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  await browser.close();
  if (!bduss) { console.error("❌ 无网盘凭证（BDUSS）"); process.exit(1); }
  console.log(`凭证就绪 BDUSS(${bduss.length}字符) —— 全程纯协议，无浏览器`);

  // 2) 任务清单（state 已在文件顶部从台账读好）
  const tasks = [];
  // 分出「剔除原因」而不是一个笼统的 junk 计数：跑批是无人值守的，
  // 只报"剔除 87"没人知道该去补提取码、还是该去改表头。分开点名才能直接行动。
  // sharedSkipped：往期「转存成了、分享没建成」且已判定不再重试的（百度永久禁止 / 补分享次数用尽）
  const drop = { noLink: 0, noPwd: 0, blacklist: 0, alreadyDone: 0, shareSkipped: 0 };
  for (let i = startIdx; i < rows.length; i += 1) {
    if (limit > 0 && tasks.length >= limit) break;
    const rawName = String(rows[i][nameKey] || "").trim();
    const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? ` 提取码:${rows[i][pwdKey]}` : ""));
    const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
    if (!link) { drop.noLink += 1; if (drop.noLink <= 5) console.log(`  ⏭ 第 ${i + 1} 行没解析出链接：${rawName.slice(0, 24) || "(名称为空)"}`); continue; }
    if (!cellPwd) { drop.noPwd += 1; if (drop.noPwd <= 5) console.log(`  ⏭ 第 ${i + 1} 行无提取码（链接本身也没带 ?pwd=）：${rawName.slice(0, 24)}`); continue; }
    const prev = state.get(srcLink);
    if (prev && prev.status === "done" && prev.ownLink) { drop.alreadyDone += 1; continue; } // 断点：已确权
    if (prev && (prev.attempts || 0) >= 3) { drop.blacklist += 1; continue; }               // 失败 3 次黑名单
    // 上次「转存成了、分享没建成」→ 拿历史落盘路径直接补分享，**不再转存**（文件早就在网盘里了）
    const retry = planShareRetry(prev);
    if (retry.action === "skip") {
      drop.shareSkipped += 1;
      if (drop.shareSkipped <= 5) console.log(`  ⏭ 跳过 ${rawName.slice(0, 24)}：${retry.reason}`);
      continue;
    }
    tasks.push({ idx: i, rawName, srcLink, link, pwd: cellPwd, attempts: (prev && prev.attempts) || 0, retry });
  }
  const dropTotal = Object.values(drop).reduce((a, b) => a + b, 0);
  console.log(`本轮任务 ${tasks.length} 条 | 往期已完成跳过 ${drop.alreadyDone} 条`);
  if (dropTotal - drop.alreadyDone > 0) {
    console.log(`剔除 ${dropTotal - drop.alreadyDone} 行：无链接 ${drop.noLink} | 无提取码 ${drop.noPwd} | 黑名单 ${drop.blacklist} | 分享不再重试 ${drop.shareSkipped}`);
  }

  // 规范化名称去重键（历史完成 + 本轮，跨写法/跨链接去重）
  const seenKeys = new Set();
  for (const st of state.values()) {
    if (st.status === "done" && st.name) {
      const k = qaLib.normalizeName(st.name);
      if (k && k.length >= 2) seenKeys.add(k);
    }
  }
  console.log(`去重键库：${seenKeys.size} 个`);

  // 3) 并发池执行
  const pendingKeys = new Set();  // 在途预留（并发去重）
  let done = 0, failed = 0, consecutiveFails = 0, fatalStop = false;
  // 分享是**独立失败域**（见 share.js / runShareStep 注释）：本脚本单账号，env 用固定标签，
  // 只为让 runShareStep 的"该账号已达每日上限 → 本批后续仅转存不建分享"能正确工作。
  const ENV_LABEL = args.env || "脚本账号";
  const shareBlocked = new Set();     // 已撞每日分享上限的账号
  const sharesByEnv = new Map();      // 每账号本轮已建分享数（用于软告警）
  const warnedSoft = new Set();       // 已发过软告警的账号（避免刷屏）
  const createdDirs = new Set();      // 建目录缓存（跨资源复用，省写请求）
  let transferredNoShare = 0;
  const startedAt = Date.now();
  // 分享上限是**账号级**的，跟资源条数无关：这批总量若已超过上限，提前把话说清楚，
  // 免得到最后一堆条都是"转存成功但建不了分享"而不知道为什么。
  if (tasks.length > SHARE_DAILY_LIMIT) {
    console.log(`⚠️ 本批 ${tasks.length} 条，而百度单账号每日最多建 ${SHARE_DAILY_LIMIT} 个分享链接`
      + `（软告警线 ${SHARE_SOFT_WARN_AT}）。超出的部分会**转存成功但没有分享链接**（因此不进问答表）。`
      + "要全部出问答，请分批跑（隔天）或用多账号。");
  }
  const quota = async () => {
    const jar = new Jar(bduss, stoken);
    const cli = makeClient(jar);
    const q = await cli(`/api/quota?checkfree=1&checkexpire=1&web=1`).catch(() => ({}));
    if (q.errno !== 0 || !q.total) return null;
    return { freeGB: (q.total - q.used) / 1024 ** 3, totalGB: q.total / 1024 ** 3 };
  };
  const quota0 = await quota();
  if (quota0) {
    console.log(`网盘空间：总 ${quota0.totalGB.toFixed(0)}GB | 剩余 ${quota0.freeGB.toFixed(1)}GB`);
    if (quota0.freeGB < 10) {
      console.log("⛔ 剩余空间不足 10GB，转存必然失败。扩容/清理后重跑。");
      process.exit(3);
    }
  }

  let cursor = 0;
  async function worker(workerId) {
    while (cursor < tasks.length && !fatalStop) {
      const t = tasks[cursor++];
      // 每条独立 Cookie 会话
      const jar = new Jar(bduss, stoken);
      const entryBase = { srcLink: t.srcLink, name: t.rawName };
      // 提到 try 外面：catch 里要按它撤销"在途预留"，否则那条名字会被永久占住。
      // （原来在 catch 里写 `typeof preKey !== "undefined"` 就是因为 const 是块作用域 —— 治标不治本。）
      let preKey = "";
      try {
        const idx = String(t.idx + 1).padStart(5, "0");
        const dirLabel = isGenericName(t.rawName) ? "" : String(t.rawName).replace(/[\/:*?"<>|\r\n]/g, " ").trim().slice(0, 20);
        const destDir = `${destRoot}/${baseName}/${dirLabel ? idx + "_" + dirLabel : idx}`;
        // 预检去重：规范化名已存在或已被其他 worker 预留 → 跳过（并发安全）
        preKey = qaLib.normalizeName(t.rawName || "");
        if (preKey && preKey.length >= 2 && (seenKeys.has(preKey) || pendingKeys.has(preKey))) {
          console.log(`  ⏭ 跳过重复（${preKey}）：${(t.rawName || "").slice(0, 24)}`);
          await sleep(paceMs);
          continue;
        }
        if (preKey && preKey.length >= 2) pendingKeys.add(preKey);
        // 协议链走主实现（protocol.js）。这里只传 destDir（脚本的扁平「根/资源表/序号_名」语义）；
        // createdDirs 让「根」「根/资源表」这两层只建一次 —— 每条少两个写请求。
        let toPaths;
        if (t.retry && t.retry.action === "share-only") {
          // 文件上次就转存成功了，台账里有落盘路径 —— 一步都不必再碰转存接口，
          // 直接拿历史路径补建分享（否则每轮都多打一次 /share/transfer 并撞 errno=4）
          toPaths = t.retry.toPaths;
          console.log(`  [W${workerId}][${now()}] 🔁 ${t.rawName.slice(0, 26)} 上次已转存、只是分享没建成 → 直接补分享（第 ${t.retry.shareAttempts + 1} 次）`);
        } else {
          const oneResult = await processOne(jar, { link: t.link, pwd: t.pwd, destDir, createdDirs });
          // 大文件是**异步转存**：errno=0 但响应里没有落盘路径，show_msg 写着「文件转存中」。
          // 这不是失败（文件确实在转），记 pending 待下次确认。计成 failed 会虚报失败数，
          // 3 次之后还会进黑名单，而其实它每次都在正常转。
          if (oneResult.pending) {
            saveState({ ...entryBase, status: "pending", attempts: (t.attempts || 0) + 1, error: "百度在异步转存中（大文件），本次拿不到落盘路径", at: new Date().toISOString() });
            pendingKeys.delete(preKey);
            console.log(`  [W${workerId}][${now()}] ⏳ ${t.rawName.slice(0, 26)} 百度异步转存中（大文件），不算失败，下次再确认`);
            continue;
          }
          toPaths = oneResult.toPaths;
        }
        // 自有永久分享（确权后）。**关键**：转存成功 ≠ 分享成功 —— 分享是独立失败域。
        // 以前这里 `if (!share.link) throw`，于是"已达每日 300 分享上限"被外层 catch
        // 当成"整条失败"：已落盘的文件每轮都被重传（errno=4）+ 再撞分享接口，纯粹自伤。
        // runShareStep 会把这种情况返回 shareFailed（不重传、不计失败），并在撞上限时封该账号。
        const share = await runShareStep({
          makeShare: true, env: ENV_LABEL, bduss, stoken, toPaths,
          shareBlocked, sharesByEnv, warnedSoft, log: (m) => console.log(`  ${m}`),
        });
        if (share.shareFailed) {
          // shareAttempts/shareForbidden 让下一轮 planShareRetry 知道还能不能再补一次
          saveState({ ...entryBase, status: "share_failed", phase: "transferred", toPaths, ...shareRetryFields(t.retry, share), error: share.shareErrMsg.slice(0, 200), at: new Date().toISOString() });
          pendingKeys.delete(preKey);
          done += 1;
          transferredNoShare += 1;
          consecutiveFails = 0;   // 转存确实成功了，连败应当清零（否则一批"仅转存"会误触熔断）
          console.log(`  [W${workerId}][${now()}] ⚠️ ${t.rawName.slice(0, 26)} 已转存但建分享失败（不重传）`
            + `${share.shareLimited ? "[每日上限]" : share.shareForbidden ? "[该资源禁止二次分享]" : ""}：${share.shareErrMsg.slice(0, 80)}`);
          continue;
        }
        const ownPwd = share.ownPwd;
        const ownLink = share.ownLink;
        const landedBase = decodeURIComponent((toPaths[0] || "").split("/").pop() || "");
        let displayName = isGenericName(t.rawName) ? (landedBase || "资源") : t.rawName;
        if (isGenericName(displayName)) displayName = landedBase || displayName;
        // 名称质量门槛：广告词/压缩包等命名不得进入问答（资源已转存，仅跳过生成问答）
        if (qaLib.reject(displayName, ownLink)) {
          displayName = decodeURIComponent((toPaths[0] || "").split("/").pop() || "").replace(/\[([^\]]*)\]/g, "$1").trim();
          if (qaLib.reject(displayName, ownLink)) {
            saveState({ srcLink: t.srcLink, name: t.rawName, status: "done", phase: "done", toPaths, ownLink, ownPwd, note: "名称不合规跳过问答", at: new Date().toISOString() });
            pendingKeys.delete(preKey);
            done += 1;
            consecutiveFails = 0;
            console.log(`  [W${workerId}][${now()}] ⚠️ ${t.rawName.slice(0, 26)} 已转存但名称不合规，跳过问答`);
            continue;
          }
        }
        const meta = qaLib.parseName(displayName);
        const qaRow = {
          qid: "",
          问题标题: qaLib.buildTitle(meta, t.idx),
          回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta)),
        };
        const okEntry = { srcLink: t.srcLink, name: displayName, status: "done", phase: "done", toPaths, ownLink, ownPwd, qaRow, at: new Date().toISOString() };
        state.set(t.srcLink, okEntry);
        saveState(okEntry);
        const doneKey = qaLib.normalizeName(displayName);
        if (doneKey && doneKey.length >= 2) { pendingKeys.delete(doneKey); seenKeys.add(doneKey); }
        if (preKey) pendingKeys.delete(preKey);
        done += 1;
        consecutiveFails = 0;
        console.log(`  [W${workerId}][${now()}] ✅ ${displayName.slice(0, 26)} → ${ownLink}`);
      } catch (e) {
        failed += 1;
        consecutiveFails += 1;
        t.attempts = (t.attempts || 0) + 1;
        if (preKey) pendingKeys.delete(preKey);
        saveState({ ...entryBase, status: "failed", attempts: t.attempts, error: (e.message || "").slice(0, 120), at: new Date().toISOString() });
        console.log(`  [W${workerId}][${now()}] ✗ ${t.rawName.slice(0, 26)} → ${e.message.slice(0, 70)}`);
        if (e.fatal) { console.log("⛔ 容量不足，管线停止（已完成部分完好）。"); fatalStop = true; break; }
        // 分享页限流（protocol 打的标记）：不是链接失效，是打太快 —— 冷却 3 分钟再继续，
        // 别把整批都判死（原来这里没有任何针对性处理，10 条连着跑就会有一批撞上）。
        if (e.sharePageLimited) { console.log("  ⏸ 分享页限流（非链接失效），冷却 3 分钟…"); await sleep(3 * 60 * 1000); }
        if (e.risk) { console.log("  ⏸ verify 风控，全局暂停 10 分钟…"); await sleep(10 * 60 * 1000); }
        if (consecutiveFails >= 10) { console.log("⚠️ 连续 10 条失败，自动停止（可稍后重跑续传）。"); break; }
      }
      await sleep(paceMs + Math.random() * paceMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CC, tasks.length) }, (_, w) => worker(w + 1)));

  // 4) 导出上传专用表
  const allDone = [...state.values()].filter((s) => s.status === "done" && s.qaRow).map((s) => s.qaRow);
  fs.mkdirSync(outDir, { recursive: true });
  // 清理上一轮分片（文件名含条数，重跑会残留旧片导致重复上传）
  try {
    for (const f of fs.readdirSync(outDir)) {
      if (/^上传专用表-第\d+批-\d+条\.xlsx$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
    }
  } catch { /* 忽略 */ }
  if (allDone.length) {
    const chunkRows = 5000;
    for (let c = 0; c < Math.ceil(allDone.length / chunkRows); c += 1) {
      const part = allDone.slice(c * chunkRows, (c + 1) * chunkRows);
      const ws = XLSX.utils.json_to_sheet(part, { header: ["qid", "问题标题", "回答内容"] });
      const wbOut = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
      XLSX.writeFile(wbOut, path.join(outDir, `上传专用表-第${c + 1}批-${part.length}条.xlsx`));
    }
  }
  const mins = Math.round((Date.now() - startedAt) / 60000);
  console.log("\n=== 批量转存完成 ===");
  console.log(`本轮转存成功 ${done} | 失败 ${failed} | 历史累计可用问答 ${allDone.length} | 用时 ${mins} 分钟`);
  // 「转了但没有分享」必须单独说清楚：它不是失败（文件在你的网盘里），但**没有链接就出不了问答**。
  // 以前这类条目悄悄混在"失败"或干脆不计，用户看到的数字对不上却找不到原因。
  if (transferredNoShare > 0) {
    console.log(`⚠️ 其中 ${transferredNoShare} 条**已转存但没生成分享链接**（资源在网盘里，不进问答表）`
      + `，原因：${[...shareBlocked].length ? `账号「${[...shareBlocked].join("、")}」已达每日 ${SHARE_DAILY_LIMIT} 个分享上限` : "该资源被百度禁止二次分享 / 建分享接口偶发拒绝"}`
      + "。明天或换账号重跑本批即可补上（已转存的会走 errno=4 复用路径，不会重复占用空间）。");
  }
  if (allDone.length) console.log(`上传专用表: ${outDir}`);
  console.log(`状态文件: ${stateFile}（重跑自动断点续传）`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 180)); process.exit(1); });
