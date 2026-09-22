"use strict";

/**
 * 网盘已有资源 → 自有分享 → 上传专用表：
 *   不转存，直接把【网盘里已有的文件/文件夹】逐个创建自己的永久分享，
 *   用自己的链接按答题模板生成上传专用 xlsx（qid/问题标题/回答内容）。
 *   幂等：state.jsonl 记录已分享路径，重跑跳过。
 *
 * 用法：node scripts/netdisk-share-existing.js [输出目录]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { chromium } = require("playwright-core");
const { createShare } = require("../electron/src/netdisk/share");
const qaLib = require("./qa-template-lib");

const root = path.resolve(__dirname, "..");
const workDir = path.join(root, "运行缓存", "网盘已有资源QA");
const stateFile = path.join(workDir, "state.jsonl");
const _positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
const outDir = _positional ? path.resolve(_positional) : path.join(workDir, "上传专用表");

// 跳过清单：测试文件/空目录/敏感命名
const SKIP_NAMES = ["netdisk-share-test.txt", "老司机必看.zip", "上海第二工业大学杀杀杀完整版.zip",
  "尽快保存 避免失效 保存即可观看", "云一朵知识问答", "redian百度转存_20260919_013706", "【抖音最新注册跳核对技术】无限注册.zip"];
function randomPwd() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(stateFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); map.set(r.srcPath, r); } catch { /* 跳过 */ }
    }
  } catch { /* 首次 */ }
  return map;
}
function saveState(entry) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.appendFileSync(stateFile, JSON.stringify(entry) + "\n");
}

(async () => {
  // --dir=/xxx：枚举指定网盘目录（默认根目录）
  const dirArg = (() => { const m = process.argv.slice(2).find((a) => a.startsWith("--dir=")); return m ? m.slice(6) : "/"; })() || "/";
  const dirArgNorm = dirArg.startsWith("/") ? dirArg : "/" + dirArg;
  // 1) 连接比特浏览器拿登录态
  const cdpFile = path.join(root, "运行缓存", "cdp.txt");
  const cdp = fs.readFileSync(cdpFile, "utf8").trim();
  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const context = browser.contexts()[0];
  const cookies = await context.cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  if (!bduss) { console.error("❌ 无 pan.baidu.com 登录态"); process.exit(1); }
  const list = async (dir) => context.pages().length && await (async () => {
    let page = context.pages().find((p) => p.url().includes("pan.baidu.com"));
    if (!page) { page = await context.newPage(); await page.goto("https://pan.baidu.com/disk/main", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {}); await sleep(3000); }
    return page.evaluate(async (d) => (await (await fetch(`https://pan.baidu.com/api/list?dir=${encodeURIComponent(d)}&web=1`)).json()).list || [], dir);
  })();

  // 2) 收集分享单元：根目录文件夹（整folder一个分享）+ 根目录合规文件
  const rootItems = await list(dirArgNorm);
  const units = [];
  for (const f of rootItems) {
    if (SKIP_NAMES.includes(f.server_filename)) continue;
    const isDir = Number(f.isdir) === 1;
    if (isDir) {
      const kids = await list(f.path);
      if (!kids.length) continue; // 空目录
      units.push({ path: f.path, name: f.server_filename, kind: "folder" });
    } else if ((Number(f.size) || 0) > 0) {
      units.push({ path: f.path, name: f.server_filename, kind: "file" });
    }
  }
  console.log(`分享单元 ${units.length} 个（跳过测试/空/敏感项）`);

  // 3) 逐个创建自有永久分享 + 生成问答行
  const state = loadState();
  const qaRows = [];
  let done = 0, failed = 0;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    const prev = state.get(u.path);
    if (prev && prev.status === "done" && prev.ownLink) {
      qaRows.push(prev.qaRow);
      continue;
    }
    const ownPwd = randomPwd();
    try {
      const share = await createShare({ bduss, stoken, paths: [u.path], password: ownPwd });
      if (!share.link) throw new Error("创建分享失败");
      const ownLink = `${share.link}?pwd=${share.password}`;
      const meta = qaLib.parseName(u.name);
      const qaRow = {
        qid: "",
        问题标题: qaLib.buildTitle(meta, i),
        回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta), true),
      };
      const entry = { srcPath: u.path, name: u.name, status: "done", phase: "done", ownLink, ownPwd: share.password, qaRow, at: new Date().toISOString() };
      state.set(u.path, entry);
      saveState(entry);
      qaRows.push(qaRow);
      done += 1;
      console.log(`  [${done}] ✅ ${u.name.slice(0, 30)} → ${ownLink}`);
    } catch (e) {
      failed += 1;
      saveState({ srcPath: u.path, name: u.name, status: "failed", phase: "failed", error: (e.message || "").slice(0, 120), at: new Date().toISOString() });
      console.log(`  ✗ ${u.name.slice(0, 30)} → ${e.message.slice(0, 60)}`);
    }
    await sleep(1500 + Math.random() * 1500);
  }

  // 4) 导出上传专用表
  fs.mkdirSync(outDir, { recursive: true });
  if (qaRows.length) {
    const ws = XLSX.utils.json_to_sheet(qaRows, { header: ["qid", "问题标题", "回答内容"] });
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
    XLSX.writeFile(wbOut, path.join(outDir, "上传专用表-网盘已有资源.xlsx"));
  }
  console.log("=== 完成 ===");
  console.log(`本次新分享 ${done} | 失败 ${failed} | 累计可用 ${qaRows.length} 条`);
  console.log(`上传专用表: ${path.join(outDir, "上传专用表-网盘已有资源.xlsx")}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 180)); process.exit(1); });
