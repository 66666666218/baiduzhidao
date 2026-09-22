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
 * 用法：node scripts/pan-transfer-ui.js --input=<资源表.xlsx> [--start=0] [--limit=20]
 *          [--dest-select=我的资源] [--delay-min=6] [--delay-max=12]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { chromium } = require("playwright-core");
const { createShare } = require("../electron/src/netdisk/share");
const qaLib = require("./qa-template-lib");

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
const delayMaxS = Math.max(delayMinS, Number(args["delay-max"]) || 12);
const keepImg = !args["no-img"];
const destSelect = args["dest-select"] || "";

const baseName = path.basename(inputFile).replace(/\.xlsx$/i, "").slice(0, 40);
const workDir = path.join(root, "运行缓存", "transfer-ui", baseName);
const stateFile = path.join(workDir, "state.jsonl");
const outDir = path.join(workDir, "上传专用表");

function loadState() {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(stateFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); map.set(r.srcLink, r); } catch { /* 跳过 */ }
    }
  } catch { /* 首次 */ }
  return map;
}
const saveState = (e) => { fs.mkdirSync(workDir, { recursive: true }); fs.appendFileSync(stateFile, JSON.stringify(e) + "\n"); };
const randomPwd = () => { const c = "abcdefghjkmnpqrstuvwxyz23456789"; return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join(""); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
function parseLinkCell(text) {
  const s = String(text || "");
  const link = (s.match(/https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i) || [])[0] || "";
  let pwd = (s.match(/[?&]pwd=([a-z0-9]{4})/i) || [])[1] || "";
  if (!pwd) pwd = (s.match(/(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i) || [])[1] || "";
  return { link, pwd };
}

(async () => {
  const wb = XLSX.readFile(inputFile);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  const keys = Object.keys(rows[0]);
  const nameKey = keys.find((k) => /文件名|名称|标题|资源/.test(k)) || keys[0];
  const linkKey = keys.find((k) => /链接|网址|url/i.test(k)) || keys.find((k) => /pan\.baidu\.com/.test(String(rows[0][k] || ""))) || keys[1];
  const pwdKey = keys.find((k) => /提取码|密码|访问码/.test(k)) || "";
  console.log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);

  const cdp = fs.readFileSync(path.join(root, "运行缓存", "cdp.txt"), "utf8").trim();
  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const context = browser.contexts()[0];
  const cookies = await context.cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  if (!bduss) { console.error("❌ 无网盘登录态"); process.exit(1); }
  const page = await context.newPage();

  const state = loadState();
  const qaRows = [];
  let done = 0, failed = 0, consecutiveFails = 0;
  const startedAt = Date.now();

  for (let i = startIdx; i < rows.length; i += 1) {
    if (limit > 0 && done >= limit) break;
    if (Date.now() - startedAt > 8 * 3600 * 1000) { console.log("到达 8 小时上限，收尾。"); break; }
    const rawName = String(rows[i][nameKey] || "").trim();
    const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? "" : ""));
    const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
    if (!link || !cellPwd || qaLib.reject(rawName, srcLink)) continue;

    const prev = state.get(srcLink);
    if (prev && prev.status === "done" && prev.ownLink) { qaRows.push(prev.qaRow); continue; }
    if (prev && prev.attempts >= 3) continue; // 黑名单

    const entry = { srcLink, name: rawName, status: "failed", at: new Date().toISOString() };
    try {
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

      if (tBody.errno !== 0) throw new Error(`UI转存 errno=${tBody.errno} ${tBody.show_msg || ""}`);

      // ⑤ 落盘路径（来自响应，权威）
      const toPaths = (tBody.extra && tBody.extra.list || []).map((x) => x.to);
      if (!toPaths.length) throw new Error("转存成功但未取得落盘路径");

      // ⑥ 创建自己的永久分享
      const ownPwd = randomPwd();
      const share = await createShare({ bduss, stoken, paths: toPaths, password: ownPwd });
      if (!share.link) throw new Error("创建分享失败");
      const ownLink = `${share.link}?pwd=${share.password}`;

      // ⑦ 按模板生成问答行
      const meta = qaLib.parseName(rawName);
      const qaRow = {
        qid: "",
        问题标题: qaLib.buildTitle(meta, i),
        回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta), keepImg),
      };
      const okEntry = { srcLink, name: rawName, status: "done", phase: "done", toPaths, ownLink, ownPwd: share.password, qaRow, at: new Date().toISOString() };
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
      if (consecutiveFails >= 8) { console.log("⚠️ 连续 8 条失败，自动停止。已存档可续跑。"); break; }
    }
    await sleep((delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000);
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
  if (qaRows.length) console.log(`上传专用表: ${outDir}`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 180)); process.exit(1); });
