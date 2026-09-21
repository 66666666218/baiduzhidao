"use strict";

/**
 * 网盘资源批量采集器（供给端自动化）：
 *   关键词库驱动 → pansou.app 循环搜索翻页 → 提取百度网盘链接+提取码
 *   → 跨次去重累积到主资源库（JSONL 追加，崩溃不丢）
 *   → 导出两列表（SOP 1.1 格式），直接对接 pan-to-qa.js 转问答格式。
 *
 * 设计要点：
 *   - 单浏览器会话复用（一次启动跑全部关键词，避免反复拉起 Edge）
 *   - 断点续爬：状态文件记录已完成/失败关键词，重跑自动跳过
 *   - 防风控：关键词间随机延时；单次运行可设时间预算/关键词上限
 *   - 质量预过滤：广告词/压缩包/超短名在入库前剔除（SOP 1.2 门槛）
 *
 * 用法：
 *   node scripts/pan-crawl-batch.js [选项]
 *     --keywords-file=xx.txt   追加关键词文件（每行一个，可选）
 *     --pages=2                每个关键词翻页数（默认 2）
 *     --max-keywords=50        本次最多跑多少个关键词（默认 50）
 *     --minutes=60             时间预算（分钟，默认 60，到点收尾导出）
 *     --delay-min / --delay-max 关键词间随机延时秒数（默认 4~9）
 *     --out=xx.xlsx            导出路径（默认 运行缓存/pan-resources-master.xlsx）
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const cacheDir = path.join(root, "运行缓存");
const masterJsonl = path.join(cacheDir, "pan-resources-master.jsonl");
const stateFile = path.join(cacheDir, "pan-crawl-state.json");

// ---------- 参数解析 ----------
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([a-z-]+)=(.*)$/i);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const pagesPerKeyword = Math.max(1, Number(args.pages) || 2);
const maxKeywords = Math.max(1, Number(args["max-keywords"]) || 50);
const budgetMs = Math.max(5, Number(args.minutes) || 60) * 60 * 1000;
const delayMinS = Math.max(2, Number(args["delay-min"]) || 4);
const delayMaxS = Math.max(delayMinS, Number(args["delay-max"]) || 9);
const outFile = args.out ? path.resolve(args.out) : path.join(cacheDir, "pan-resources-master.xlsx");

// ---------- 关键词库（类目 × 限定词组合，可持续补充） ----------
const BASE_KEYWORDS = [
  // 教育资料（高频刚需，量大）
  "课件", "电子课本", "期末试卷", "单元测试卷", "期中试卷", "真题汇编", "知识点汇总",
  "思维导图", "名师网课", "同步练习", "教案", "假期作业", "专项训练", "中考真题", "高考真题",
  // 学段学科组合
  "小学语文课件", "小学数学课件", "小学英语课件", "初中物理课件", "初中化学课件",
  "初中数学课件", "高中数学课件", "高中物理课件", "高中英语课件", "高中生物课件",
  // 考试/职业技能
  "考研资料", "公务员考试资料", "教师资格证资料", "注册会计师资料", "法考资料",
  "一级建造师资料", "软考资料", "雅思资料", "托福资料", "普通话考试资料",
  // 书籍/文档
  "电子书", "pdf书籍", "四大名著", "茅盾文学奖作品", "武侠小说全集", "科幻小说",
  "育儿书籍", "心理学书籍", "历史书籍", "人物传记",
  // 影视/纪录片
  "纪录片", "高分电影", "经典电视剧", "动画片全集", "教育资源纪录片", "央视纪录片",
  // 素材/模板
  "PPT模板", "简历模板", "手抄报模板", "海报素材", "壁纸合集", "音效素材",
  "字体合集", "PS教程", "视频剪辑教程", "摄影教程",
];
const QUALIFIERS = ["完整版", "合集", "全套", "2026", "最新版", "高清", "精讲", "汇总", "裸海版"];
function buildKeywordPool() {
  const pool = [...BASE_KEYWORDS];
  // 每个基础词配 2 个限定词变体（循环取，控制总量）
  BASE_KEYWORDS.forEach((kw, i) => {
    pool.push(`${kw}${QUALIFIERS[i % QUALIFIERS.length]}`);
    pool.push(`${kw}${QUALIFIERS[(i + 3) % QUALIFIERS.length]}`);
  });
  return [...new Set(pool)];
}

// ---------- 质量预过滤（与 pan-to-qa 门槛一致） ----------
const AD_PATTERNS = /微信号|加微信|VX[:：]?|公众号|二维码|代下|有偿|收费|付费获取|联系QQ|加群|引流|广告|www\./i;
const BANNED_EXT = /\.(zip|rar|7z|tar|gz)$/i;
function preFilter(name) {
  const n = String(name || "").trim();
  if (!n || n.length < 4) return "名称过短";
  if (AD_PATTERNS.test(n)) return "含广告/引流";
  if (BANNED_EXT.test(n)) return "压缩包";
  return "";
}

// ---------- 状态（断点续爬） ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
const state = loadJson(stateFile, { done: {}, fail: {} });

// ---------- 主资源库（JSONL 追加 + 链接索引） ----------
function loadLinkIndex() {
  const index = new Set();
  try {
    const lines = fs.readFileSync(masterJsonl, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try { index.add(JSON.parse(line).url); } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 首次运行无文件 */ }
  return index;
}

// ---------- pansou 采集适配器 ----------
const LINK_RE = /https:\/\/pan\.baidu\.com\/s\/([^\s?&]+)\?pwd=([a-z0-9]{4})/g;
function extractLinks(pageText) {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(pageText)) !== null) {
    const before = pageText.slice(Math.max(0, m.index - 100), m.index)
      .replace(/https?:\/\/[^\s]+/g, "")
      .replace(/[|←→·]/g, " ")
      .trim();
    const name = (before.split(/\s{2,}/).filter(Boolean).pop() || before.slice(-50)).trim().slice(-60);
    out.push({ name, url: `https://pan.baidu.com/s/${m[1]}?pwd=${m[2]}`, pwd: m[2] });
  }
  return out;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function collectViaPansou(page, keyword, maxPages, log) {
  await page.goto("https://pansou.app", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape").catch(() => {});
  const input = page.locator("input:not([type=hidden]):not([type=checkbox])").first();
  await input.fill(keyword);
  const searchBtn = page.locator("button", { hasText: "搜索" }).first();
  if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) await searchBtn.click();
  else await page.keyboard.press("Enter");

  // 等聚合搜索完成（最多 25s）
  const deadline = Date.now() + 25000;
  let pageText = "";
  while (Date.now() < deadline) {
    await sleep(4000);
    pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (!pageText.includes("搜索中") && !pageText.includes("持续搜索")) break;
  }

  // 翻页采集
  const items = [];
  const seen = new Set();
  for (let p = 1; p <= maxPages; p += 1) {
    if (p > 1) {
      const nextBtn = page.locator("text=下一页").first();
      if (!(await nextBtn.isVisible({ timeout: 3000 }).catch(() => false))) break;
      await nextBtn.click({ timeout: 5000 }).catch(() => {});
      await sleep(4500);
    }
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    for (const item of extractLinks(text)) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
  }
  return items;
}

// ---------- 主流程 ----------
(async () => {
  const { launchHeadlessEdge } = require("../electron/src/edge-launcher");
  const { chromium } = require("playwright-core");

  const pool = buildKeywordPool();
  if (args["keywords-file"]) {
    const extra = fs.readFileSync(String(args["keywords-file"]), "utf8").split(/\r?\n/)
      .map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    pool.unshift(...extra); // 用户关键词优先
  }
  const todo = pool.filter((kw) => !state.done[kw]);
  console.log(`关键词池 ${pool.length} 个，待跑 ${todo.length} 个（已完成 ${Object.keys(state.done).length}）`);
  console.log(`本次上限 ${maxKeywords} 个 | 每词翻 ${pagesPerKeyword} 页 | 时间预算 ${Math.round(budgetMs / 60000)} 分钟`);

  const linkIndex = loadLinkIndex();
  console.log(`主资源库已有 ${linkIndex.size} 条链接`);

  const edge = await launchHeadlessEdge({});
  const browser = await chromium.connectOverCDP(edge.cdpUrl);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  const startedAt = Date.now();
  let ran = 0, added = 0, junk = 0;

  for (const kw of todo) {
    if (ran >= maxKeywords || Date.now() - startedAt > budgetMs) { console.log("到达本次上限，收尾。"); break; }
    ran += 1;
    let items = [];
    try {
      items = await collectViaPansou(page, kw, pagesPerKeyword, console.log);
    } catch (e) {
      console.log(`  ✗ [${kw}] 采集异常: ${(e.message || "").slice(0, 80)}`);
      state.fail[kw] = (state.fail[kw] || 0) + 1;
      saveJson(stateFile, state);
      continue;
    }

    let newCnt = 0;
    for (const item of items) {
      if (linkIndex.has(item.url)) continue;
      const bad = preFilter(item.name);
      if (bad) { junk += 1; continue; }
      linkIndex.add(item.url);
      fs.appendFileSync(masterJsonl, JSON.stringify({
        name: item.name, url: item.url, pwd: item.pwd, kw, at: new Date().toISOString(),
      }) + "\n");
      newCnt += 1;
    }
    added += newCnt;
    state.done[kw] = { at: Date.now(), found: items.length, added: newCnt };
    delete state.fail[kw];
    saveJson(stateFile, state);
    console.log(`  [${ran}/${Math.min(maxKeywords, todo.length)}] ${kw}: 提取 ${items.length}，新入库 ${newCnt}（累计新增 ${added}）`);

    const delay = (delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000;
    await sleep(delay);
  }

  await browser.close().catch(() => {});
  edge.close();

  // 导出两列表（SOP 1.1 输入格式 → pan-to-qa.js）
  const rows = [];
  try {
    for (const line of fs.readFileSync(masterJsonl, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        rows.push({ "网盘内容名称": r.name, "网盘链接（含提取码）": `${r.url} 提取码: ${r.pwd}` });
      } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 无数据 */ }
  if (rows.length) {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "资源表");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    XLSX.writeFile(wb, outFile);
  }

  const mins = Math.round((Date.now() - startedAt) / 60000);
  console.log("=== 本次采集完成 ===");
  console.log(`跑完 ${ran} 个关键词 | 新增 ${added} 条 | 剔除脏数据 ${junk} 条 | 主资源库总量 ${linkIndex.size} 条 | 用时 ${mins} 分钟`);
  if (rows.length) console.log(`资源表已导出: ${outFile}`);
  console.log(`下一步转换: node scripts/pan-to-qa.js "${outFile}"`);
  console.log(`继续采集:   node scripts/pan-crawl-batch.js（自动跳过已完成关键词）`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 160)); process.exit(1); });
