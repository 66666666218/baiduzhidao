"use strict";

/**
 * 网盘资源转存（真 UI 流程版 · 最可靠）：
 *   逐条用真浏览器打开分享页 → 提取文件 → 保存到网盘 → 确定
 *   → 从转存响应拿到落盘路径 → 对落盘文件创建自己的永久分享 → 按答题模板出上传专用表。
 *
 * 依据：手动 UI 流程实测成功（errno=0），API 直连形态存在账号级风控不确定性。
 *
 * 断点续跑 / 跳过清单 / 分片导出 与 pan-transfer-pipeline 一致。
 *
 * 转存响应的判定 **不在本文件里自己写** —— 统一走 `netdisk/transfer-outcome.js`
 * （errno=4 已转存 / 异步转存中 / info 层错误提升 / 容量不足）。本文件原来一条规则都没有，
 * 于是把三种"其实成功"的情况记成了失败；那份判断的唯一家在 transfer-outcome.js。
 *
 * 用法：node scripts/pan-transfer-ui.js --input=<资源表.xlsx> [--start=0] [--limit=20]
 *          [--delay-min=6] [--delay-max=12] [--env=账号标签]
 *   ⚠️ 不要传 --dest-select：本脚本没有实现目标目录选择（旧文档写了，但一直没接线）。
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { chromium } = require("playwright-core");
const { resolveDataDir, readCdp } = require("../electron/src/data-dir");
// 分享上限常量（每日 300）+ runShareStep：分享是**独立失败域**，别在这里自己判
const { SHARE_DAILY_LIMIT, SHARE_SOFT_WARN_AT } = require("../electron/src/netdisk/share");
// 表单元格 → {link, pwd}：本文件曾自己抄了一份并漏改（`pwdKey ? "" : ""`），
// 导致提取码列永远读不到、整表静默跳过；现在统一用主实现，不再各写一份。
const { parseLinkCell } = require("../electron/src/netdisk/pan-link");
// 「share_failed 的行重跑时要不要补分享 / 要不要彻底跳过」——判断只此一处（见该文件头）
const { planShareRetry, shareRetryFields } = require("../electron/src/netdisk/share-retry");
// 「一次 /share/transfer 响应意味着什么」的唯一实现。UI 拦截到的就是原始响应，
// 与纯协议路线是同一个响应，必须用同一套判定 —— 以前这里一条规则都没有。
const { normalizeTransferBody, describeTransferOutcome } = require("../electron/src/netdisk/transfer-outcome");
const { runShareStep } = require("../electron/src/tasks/batch-transfer");
// 「哪一列是名称/链接/提取码」：收敛到一处（本文件原本是"多一个 guard"的变体）
const { detectColumns } = require("../electron/src/netdisk/table-columns");
// 转存台账（state.jsonl）：原本五份，收敛到一处
const { loadLedger, appendLedger } = require("../electron/src/netdisk/state-ledger");
// 读 xlsx 统一走 storage/excel.js 的 readTableRows（本文件不再自己 XLSX.readFile）
const excel = require("../electron/src/storage/excel");
const qaLib = require("../electron/src/netdisk/qa-template-lib");

const root = path.resolve(__dirname, "..");
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/i);
  if (m) args[m[1]] = m[2];
  else args[a.replace(/^--/, "")] = true;
}
if (!args.input) { console.error("用法: node scripts/pan-transfer-ui.js --input=<资源表.xlsx> [--start=0] [--limit=20]"); process.exit(1); }

const inputFile = path.resolve(args.input);
const startIdx = Math.max(0, Number(args.start) || 0);
const limit = args.limit !== undefined ? Math.max(0, Number(args.limit)) : 20;
const delayMinS = Math.max(3, Number(args["delay-min"]) || 6);
// ⚠️ `--dest-select` 在用法里写了好几年，但**从来没实现过**（解析出来之后没有任何读者）。
// 静默忽略是最坏的处理：用户以为资源会被存进"我的资源"，实际存进了默认位置，
// 而日志里一个字都不会提。所以显式传了就点名，并说清怎么处理。
if (args["dest-select"] !== undefined) {
  console.warn(`⚠️ 忽略无效参数 --dest-select=${args["dest-select"]}：本脚本**没有**实现目标目录选择。`);
  console.warn("   转存会落到网盘默认保存位置（弹窗里直接点「确定」）。要指定目录请在网盘里移动，或改用");
  console.warn("   scripts/pan-transfer-batch.js --dest=/目标目录（纯协议，支持指定目录）。");
}
const delayMaxS = Math.max(delayMinS, Number(args["delay-max"]) || 12);

const baseName = path.basename(inputFile).replace(/\.xlsx$/i, "").slice(0, 40);
const workDir = path.join(resolveDataDir(root), "transfer-ui", baseName);
const stateFile = path.join(workDir, "state.jsonl");
const outDir = path.join(workDir, "上传专用表");

// 台账读写收敛到 netdisk/state-ledger.js（本文件原本自己抄了一份）
const state = loadLedger(stateFile, "srcLink");
const saveState = (e) => appendLedger(stateFile, e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

(async () => {
  // 输入两种形态：xlsx 表格（自动识别列） 或 txt（一行一个链接，直接批量转存）
  let rows;
  if (/\.txt$/i.test(inputFile)) {
    const lines = fs.readFileSync(inputFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    rows = lines.map((line, i) => ({ __name: `链接${i + 1}`, __link: line }));
    console.log(`链接清单 ${rows.length} 行（txt 模式：一行一个链接，转存后用真实文件名生成问答）`);
  } else {
    // 读表统一走 storage/excel.js（全仓唯一入口）。raw:false 不能省 —— 提取码带前导零时会丢数据。
    rows = excel.readTableRows(inputFile, { raw: false });
  }
  const { nameKey, linkKey, pwdKey, nameDegraded } = detectColumns(rows);
  console.log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);
  if (nameDegraded) {
    console.log(`⚠️ 这张表没有可用的「名称」列（现在拿"${nameKey}"凑数），资源名不可信 ——`
      + "建议加一列「名称」或「标题」，否则出题标题会是链接/提取码。");
  }

  const cdp = readCdp(resolveDataDir(root));
  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const context = browser.contexts()[0];
  const cookies = await context.cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  if (!bduss) { console.error("❌ 无网盘登录态"); process.exit(1); }
  const page = await context.newPage();

  const qaRows = [];
  let done = 0, failed = 0, consecutiveFails = 0;
  const startedAt = Date.now();
  // 分享是**独立失败域**（见 share.js / runShareStep 注释）：本脚本单账号，env 用固定标签，
  // 让 runShareStep 的"该账号已达每日上限 → 本批后续仅转存不建分享"能正常生效。
  const ENV_LABEL = args.env || "UI脚本账号";
  const shareBlocked = new Set();     // 已撞每日分享上限的账号
  const sharesByEnv = new Map();      // 每账号本轮已建分享数（软告警用）
  const warnedSoft = new Set();
  let transferredNoShare = 0;
  // 每轮之间的节奏。抽成函数是因为循环里新增的 pending 分支也要走同一节奏 ——
  // 直接复制那行表达式迟早会漏掉一处，而转存的节奏正是限流触发点。
  const pace = () => sleep((delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000);

  // 跳过计数：**每一个"选了却没跑成"的分支都必须留痕**（仓库历史多次出现"界面报成功、实际没跑"）。
  // 这个循环里有 4 处 `continue`，以前一处日志都没有 —— 表格里有提取码列时**整表静默跳过**，
  // 用户只看到"成功 0 | 失败 0"，完全不知道是自己被程序悄悄筛掉了。
  // shareSkipped：往期「转存成了、分享没建成」且已判定不再重试的（百度永久禁止 / 补分享次数用尽）
  const skipped = { noLink: 0, noPwd: 0, blacklist: 0, alreadyDone: 0, nameReject: 0, shareSkipped: 0 };

  // 分享上限是**账号级**的，跟资源条数无关：这批总量若已超过上限，提前把话说清楚，
  // 免得到最后一堆条都是"转存成功但建不了分享"而不知道为什么。
  const pendingCount = rows.length - startIdx;
  if (pendingCount > SHARE_DAILY_LIMIT) {
    console.log(`⚠️ 预计处理 ${pendingCount} 行，而百度单账号每日最多建 ${SHARE_DAILY_LIMIT} 个分享链接`
      + `（软告警线 ${SHARE_SOFT_WARN_AT}）。超出的部分会**转存成功但没有分享链接**（因此不进问答表）。`
      + "要全部出问答，请分批跑（隔天）或用多账号。");
  }

  for (let i = startIdx; i < rows.length; i += 1) {
    if (limit > 0 && done >= limit) break;
    if (Date.now() - startedAt > 8 * 3600 * 1000) { console.log("到达 8 小时上限，收尾。"); break; }
    const rawName = String(rows[i][nameKey] || "").trim();
    // ⚠️ 这里原来写的是 `+ (pwdKey ? "" : "")` —— 两个分支都是空串，等于**永远不把提取码列读进来**。
    // 于是当资源表把提取码单独放一列（很常见）时，cellPwd 恒为空 → 下面 `!cellPwd` 把**每一行**都 continue 掉，
    // 全程零日志。对比 pan-transfer-batch.js / pan-transfer-pipeline.js 的同名逻辑，它们都是
    // `pwdKey ? " 提取码:" + row[pwdKey] : ""` —— 只有这份漏了。现在对齐。
    const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? ` 提取码:${rows[i][pwdKey]}` : ""));
    const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
    if (!link) { skipped.noLink += 1; continue; }
    // 提取码缺失要**点名**：只把这一行单独日志出来（不刷屏），否则用户得一行行自己找。
    if (!cellPwd) { skipped.noPwd += 1; if (skipped.noPwd <= 5) console.log(`  ⏭ 第 ${i + 1} 行无提取码，已跳过：${rawName.slice(0, 24)}`); continue; }
    if (qaLib.reject(rawName, srcLink)) { skipped.nameReject += 1; if (skipped.nameReject <= 5) console.log(`  ⏭ 第 ${i + 1} 行名称不合规（广告/失效关键词），已跳过：${rawName.slice(0, 24)}`); continue; }

    const prev = state.get(srcLink);
    if (prev && prev.status === "done" && prev.ownLink) { qaRows.push(prev.qaRow); skipped.alreadyDone += 1; continue; }
    if (prev && prev.attempts >= 3) { skipped.blacklist += 1; continue; } // 黑名单（连续失败 3 次）
    // 上次「转存成了、分享没建成」→ 下面 ①②③④⑤ 都不走，直接拿历史落盘路径补建分享
    const retry = planShareRetry(prev);
    if (retry.action === "skip") {
      skipped.shareSkipped += 1;
      if (skipped.shareSkipped <= 5) console.log(`  ⏭ 跳过 ${rawName.slice(0, 24)}：${retry.reason}`);
      continue;
    }

    const entry = { srcLink, name: rawName, status: "failed", at: new Date().toISOString() };
    try {
      let toPaths;
      if (retry.action === "share-only") {
        // 上次已转存成功、只是分享没建成 → 直接拿台账里记的落盘路径补建分享，
        // ①②③④⑤ 一步都不走。这条链路是**真点 UI**（开分享页→点保存→等目录弹窗→捕包），
        // 每重跑一遍代价最大，所以这里省下来的不只是请求数，还有真窗口时间。
        toPaths = retry.toPaths;
        console.log(`  [${now()}] 🔁 ${rawName.slice(0, 26)} 上次已转存、只是分享没建成 → 直接补分享（第 ${retry.shareAttempts + 1} 次）`);
      } else {
        // ① 打开分享页（链接自带提取码时服务端直接通过）
        await page.goto(srcLink, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
        await sleep(3000);

        // ② 提取码页：点「提取文件」
        if (await page.locator("#submitBtn").count()) {
          const box = await page.locator("#submitBtn").boundingBox();
          if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.up(); }
          await sleep(6000);
        }

        // 滑块验证检测 → 人工介入信号
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => "");
        if (/安全验证|拖动.*滑块/.test(pageText)) {
          throw Object.assign(new Error("触发滑块验证——请在浏览器窗口手动完成后重跑"), { captcha: true });
        }

        // ③ 点「保存到网盘」/「立即保存」
        const saveBtn = page.locator("text=保存到网盘").first();
        const immediateBtn = page.locator("text=立即保存").first();
        let clicked = false;
        if (await immediateBtn.isVisible().catch(() => false)) { await immediateBtn.click(); clicked = true; }
        else if (await saveBtn.isVisible().catch(() => false)) { await saveBtn.click(); clicked = true; }
        if (!clicked) throw new Error("找不到保存按钮（分享可能已失效）");
        await sleep(3000);

        // ④ 目录弹窗：点「确定」并捕获转存响应
        const transferResp = new Promise((resolve) => {
          const handler = async (res) => {
            if (/share\/transfer/i.test(res.url())) {
              let body = {};
              try { body = await res.json(); } catch { /* 忽略 */ }
              page.off("response", handler);
              resolve(body);
            }
          };
          page.on("response", handler);
          // 超时用一个显式标记，别再用 `{errno:-1}` 冒充响应 —— 那会让超时和"接口真返回 -1"
          // 混在一起，日志里只看到「UI转存 errno=-1」，完全看不出是**根本没等到响应**。
          setTimeout(() => { page.off("response", handler); resolve({ __timedOut: true }); }, 20000);
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

        if (tBody.__timedOut) {
          throw new Error("20 秒内没等到 /share/transfer 响应 —— 可能「确定」没点上、或网络慢/被风控。"
            + "本条未确认落盘，按失败记档（重跑会重试）。");
        }

        // ⑤ 判定「这次转存到底成没成」——统一走 transfer-outcome.js，**不在这里自己写判断**。
        //   这份判断的另外两份拷贝（protocol.js / transfer.js）都比这里成熟，而这里原来
        //   一条规则都没有，于是把三种「其实成功」的情况记成了失败：
        //     · errno=4（已转存过）→ 每次重跑都刷一遍假失败，而且**永远不可能变成功**；
        //     · 大文件异步转存（errno=0 但无 extra）→ 报"未取得落盘路径"，3 次后进黑名单；
        //     · info 层真实错误被吞 → 真实原因被掩盖成"未取得落盘路径"。
        const o = normalizeTransferBody(tBody);
        if (o.capacityFull) throw Object.assign(new Error(describeTransferOutcome(o)), { fatal: true });
        if (o.pending) {
          const pe = {
            srcLink, name: rawName, status: "pending", attempts: ((prev && prev.attempts) || 0) + 1,
            error: "UI 转存已提交，但百度在异步转存中（大文件），本次拿不到落盘路径", at: new Date().toISOString(),
          };
          state.set(srcLink, pe);
          saveState(pe);
          console.log(`  [${now()}] ⏳ ${rawName.slice(0, 26)} 百度异步转存中（大文件），不算失败，下次再确认`);
          await pace();
          continue;
        }
        if (o.dup) {
          // 已转存过 → 复用已有路径。重跑时必然出现，**绝不能当失败**。
          toPaths = o.dupPaths.length ? o.dupPaths : o.infoPaths;
          if (!toPaths.length) throw new Error("该资源此前已转存过，但响应里没给出已有文件路径（无法据此建分享）");
          console.log(`  [${now()}] ♻️ ${rawName.slice(0, 26)} 此前已转存过，复用已有文件（不重复占用空间）`);
        } else {
          if (o.errno !== 0 && !o.infoSucceeded) throw new Error(describeTransferOutcome(o));
          toPaths = o.extraPaths.concat(o.dupPaths);
          if (!toPaths.length) throw new Error("转存返回成功但未取得落盘路径（extra/duplicated 均为空）");
        }
      }

      // ⑥ 创建自己的永久分享 —— 走 runShareStep：分享是独立失败域，
      //   "已达每日 300 上限"不能算整条失败（否则已落盘的文件会被反复重传）。
      const share = await runShareStep({
        makeShare: true, env: ENV_LABEL, bduss, stoken, toPaths,
        shareBlocked, sharesByEnv, warnedSoft, log: (m) => console.log(`  ${m}`),
      });
      if (share.shareFailed) {
        // shareAttempts/shareForbidden 让下一轮 planShareRetry 知道还能不能再补一次
        const sfEntry = { srcLink, name: rawName, status: "share_failed", phase: "transferred", toPaths, ownLink: "", ...shareRetryFields(retry, share), error: share.shareErrMsg.slice(0, 200), at: new Date().toISOString() };
        state.set(srcLink, sfEntry);
        saveState(sfEntry);
        done += 1;
        transferredNoShare += 1;
        consecutiveFails = 0;
        console.log(`  [${now()}] ⚠️ ${rawName.slice(0, 26)} 已转存但建分享失败（不重传）`
          + `${share.shareLimited ? "[每日上限]" : share.shareForbidden ? "[该资源禁止二次分享]" : ""}：${share.shareErrMsg.slice(0, 80)}`);
        await pace();
        continue;
      }
      const ownPwd = share.ownPwd;
      const ownLink = share.ownLink;

      // ⑦ 按模板生成问答行（无名时用落盘真实文件名）
      const displayName = rawName && rawName.length >= 4 && !/^链接\d+$/.test(rawName)
        ? rawName
        : decodeURIComponent((toPaths[0] || "").split("/").pop() || rawName);
      const meta = qaLib.parseName(displayName);
      const qaRow = {
        qid: "",
        问题标题: qaLib.buildTitle(meta, i),
        回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta)),
      };
      const okEntry = { srcLink, name: rawName, status: "done", phase: "done", toPaths, ownLink, ownPwd, qaRow, at: new Date().toISOString() };
      state.set(srcLink, okEntry);
      saveState(okEntry);
      qaRows.push(qaRow);
      done += 1;
      consecutiveFails = 0;
      console.log(`  [${now()}] ✅ ${rawName.slice(0, 26)} → ${ownLink} (${toPaths.length}项落盘)`);
    } catch (e) {
      failed += 1;
      consecutiveFails += 1;
      entry.status = "failed";
      entry.attempts = ((prev && prev.attempts) || 0) + 1;
      entry.error = (e.message || "").slice(0, 120);
      state.set(srcLink, entry);
      saveState(entry);
      console.log(`  [${now()}] ✗ ${rawName.slice(0, 26)} → ${e.message.slice(0, 70)}`);
      if (e.captcha) {
        console.log("  ⏸ 请在浏览器窗口完成滑块验证，60 秒后自动继续（未完成可重跑续传）…");
        await sleep(60000);
      }
      // 容量不足：原地重试没有意义（换账号/清空间才有用）。直接停，别让后面每条都白撞一次。
      if (e.fatal) { console.log("⛔ 网盘容量不足，停止（已完成条目完好，换账号或清空间后重跑续传）。"); break; }
      if (consecutiveFails >= 8) { console.log("⚠️ 连续 8 条失败，自动停止。已存档可续跑。"); break; }
    }
    await pace();
  }

  // 导出上传专用表
  fs.mkdirSync(outDir, { recursive: true });
  if (qaRows.length) {
    const ws = XLSX.utils.json_to_sheet(qaRows, { header: ["qid", "问题标题", "回答内容"] });
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
    XLSX.writeFile(wbOut, path.join(outDir, "上传专用表-已转存.xlsx"));
  }
  console.log("=== 本轮完成 ===");
  console.log(`成功 ${done} | 失败 ${failed} | 累计可用 ${[...state.values()].filter((s) => s.status === "done").length} 条`);
  // 「转了但没有分享」必须单独说清楚：它不是失败（文件在你的网盘里），但**没有链接就出不了问答**。
  if (transferredNoShare > 0) {
    console.log(`⚠️ 其中 ${transferredNoShare} 条**已转存但没生成分享链接**（资源在网盘里，不进问答表）`
      + `，原因：${shareBlocked.size ? `账号「${[...shareBlocked].join("、")}」已达每日 ${SHARE_DAILY_LIMIT} 个分享上限` : "该资源被百度禁止二次分享 / 建分享接口偶发拒绝"}`
      + "。明天或换账号重跑本批即可补上（已转存的会复用已有文件，不会重复占用空间）。");
  }
  // 把"被跳过"的数字摆到台面上。以前这里只有"成功/失败"，被静默筛掉的行一点痕迹都没有 ——
  // 看到「成功 0 | 失败 0」时完全无从判断是表格没数据、还是全被程序筛了。
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal) {
    console.log(`跳过 ${skippedTotal} 行：无链接 ${skipped.noLink} | 无提取码 ${skipped.noPwd} | 名称不合规 ${skipped.nameReject}`
      + ` | 已转存过 ${skipped.alreadyDone} | 黑名单（连续失败3次） ${skipped.blacklist} | 分享不再重试 ${skipped.shareSkipped}`);
    if (skipped.noPwd) console.log("  ↳ 「无提取码」多为资源表把提取码单独放了一列、但列名不含「提取码/密码/访问码」字样，或该行确实没码。");
    if (skipped.noLink) console.log("  ↳ 「无链接」多为链接列没被识别出来，请确认表头含「链接/网址/url」。");
  }
  if (qaRows.length) console.log(`上传专用表: ${outDir}`);
  console.log(`状态文件: ${stateFile}（重跑自动断点续传）`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 180)); process.exit(1); });
