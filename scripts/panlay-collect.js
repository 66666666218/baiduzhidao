"use strict";

/**
 * panlay.com 资源采集器（方式一）：复用持久登录会话，走站点 API 采集网盘资源。
 *
 * 两种来源：
 *   A. 投稿流（默认，免配额）：/api/tools/resource-search?page=N&limit=50 翻页全量采
 *   B. 关键词搜索（--search，消耗 200/天搜索配额）：&q=关键词，先查 usage 余量，扣完即停
 *
 * 仅入库 platform=baidu 且带提取码的 valid 资源（与供给链路一致）。
 *
 * 用法：
 *   node scripts/panlay-collect.js                       # 投稿流翻页（免配额）
 *   node scripts/panlay-collect.js --search 小学语文课件,考研数学
 *   node scripts/panlay-collect.js --search-file kw.txt  # 每行一个关键词
 *   通用选项： --max-pages=400   投稿流最大页数（默认 400）
 *             --delay-min/--delay-max  请求间随机延时秒数（默认 2~4）
 *             --out=xx.xlsx            导出路径（默认 运行缓存/pan-resources-master.xlsx）
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");
const { launchHeadedEdge } = require("../electron/src/headed-edge-launcher");
const lib = require("./pan-library");

// ---------- 参数（兼容 --flag=value 与 --flag value 两种写法；MSYS 下引号会被拆开） ----------
const VALUE_FLAGS = new Set(["search", "search-file", "max-pages", "delay-min", "delay-max", "out"]);
const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const m = a.match(/^--([a-z-]+)=(.*)$/i);
    if (m) { args[m[1]] = m[2]; continue; }
    const name = a.replace(/^--/, "");
    if (VALUE_FLAGS.has(name) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      args[name] = true;
    }
  }
}
const maxPages = Math.max(1, Number(args["max-pages"]) || 400);
const delayMinS = Math.max(1, Number(args["delay-min"]) || 2);
const delayMaxS = Math.max(delayMinS, Number(args["delay-max"]) || 4);
const outFile = args.out ? path.resolve(args.out) : path.join(lib.cacheDir, "pan-resources-master.xlsx");

const searchKeywords = [];
if (args.search) searchKeywords.push(...String(args.search).split(/[,，]/).map((s) => s.trim()).filter(Boolean));
if (args["search-file"]) {
  const extra = fs.readFileSync(String(args["search-file"]), "utf8").split(/\r?\n/)
    .map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  searchKeywords.push(...extra);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randDelay() { return (delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000; }

(async () => {
  const { cdpUrl } = await launchHeadedEdge({ onLog: (m) => console.log(m) });
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("panlay.com"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://www.panlay.com", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  }
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (text.includes("欢迎登录")) {
    console.log("❌ 登录态失效，请重跑 node scripts/panlay-login.js");
    process.exit(2);
  }

  /** 站内 fetch（带登录 Cookie）。 */
  async function apiGet(pathAndQuery) {
    return page.evaluate(async (u) => {
      const resp = await fetch(u, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    }, `https://www.panlay.com${pathAndQuery}`);
  }

  const index = lib.loadLinkIndex();
  console.log(`主资源库已有 ${index.size} 条链接`);

  // ---- 配额查询 ----
  let usage = { search_count: 0, search_limit: 200 };
  try {
    const u = await apiGet("/api/tools/resource-search/usage");
    usage = u.data || usage;
    console.log(`配额：搜索 ${usage.search_count}/${usage.search_limit} | 投稿 ${usage.upload_count}/${usage.upload_limit} | 等级 Lv${usage.user_level}`);
  } catch (e) { console.log("配额查询失败（继续）:", (e.message || "").slice(0, 60)); }

  let added = 0, scanned = 0;
  function ingest(list, source, kw) {
    for (const it of list || []) {
      scanned += 1;
      if (it.platform !== "baidu") continue;               // 供给链路只收百度网盘
      if (it.status && it.status !== "valid") continue;     // 平台已判失效的跳过
      const url = String(it.url || "");
      if (!/pan\.baidu\.com\/s\//.test(url)) continue;
      const pwd = (url.match(/pwd=([a-z0-9]{4})/i) || [])[1] || "";
      if (!pwd) continue;                                   // SOP：必须含提取码
      const name = String(it.title || "").trim();
      if (lib.preFilter(name) || index.has(url)) continue;
      lib.appendResource(index, { name, url, pwd, source, kw: kw || "" });
      added += 1;
    }
  }

  // ---- A. 投稿流翻页（免配额） ----
  console.log(`[投稿流] 开始翻页（上限 ${maxPages} 页，每页 50 条）…`);
  let pageNo = 1, emptyStreak = 0;
  while (pageNo <= maxPages) {
    let data = [], pagination = null;
    try {
      const resp = await apiGet(`/api/tools/resource-search?page=${pageNo}&limit=50`);
      data = resp.data || [];
      pagination = resp.pagination || null;
    } catch (e) {
      console.log(`  第 ${pageNo} 页请求失败: ${(e.message || "").slice(0, 60)}`);
      await sleep(randDelay());
      continue;
    }
    const before = added;
    ingest(data, "panlay-feed");
    console.log(`  第 ${pageNo} 页：取回 ${data.length} 条，新入库 ${added - before}`);
    emptyStreak = added === before ? emptyStreak + 1 : 0;
    if (!data.length) break;
    if (pagination && pageNo >= (pagination.totalPages || 1)) { console.log("  已到最后一页。"); break; }
    if (emptyStreak >= 5) { console.log("  连续 5 页无新增（可能都是旧资源/重复），提前收尾。"); break; }
    pageNo += 1;
    await sleep(randDelay());
  }

  // ---- B. 关键词搜索（耗配额） ----
  if (searchKeywords.length) {
    console.log(`[关键词搜索] ${searchKeywords.length} 个关键词（每条耗 1 次搜索配额）`);
    for (const kw of searchKeywords) {
      if (usage.search_count >= usage.search_limit) {
        console.log(`  ⏸ 搜索配额用尽（${usage.search_count}/${usage.search_limit}），剩余关键词明日再跑。`);
        break;
      }
      try {
        const resp = await apiGet(`/api/tools/resource-search?page=1&limit=50&q=${encodeURIComponent(kw)}`);
        const before = added;
        ingest(resp.data || [], "panlay-search", kw);
        if (resp.usage) usage = resp.usage;
        console.log(`  [${kw}] 命中 ${(resp.data || []).length} 条，新入库 ${added - before}（配额 ${usage.search_count}/${usage.search_limit}）`);
      } catch (e) {
        console.log(`  [${kw}] 搜索失败: ${(e.message || "").slice(0, 60)}`);
      }
      await sleep(randDelay());
    }
  }

  const total = lib.exportXlsx(outFile);
  console.log("=== panlay 采集完成 ===");
  console.log(`扫描 ${scanned} 条 | 新入库 ${added} 条 | 主资源库总量 ${index.size} 条`);
  if (total) console.log(`资源表已导出: ${outFile}（${total} 行）`);
  console.log(`下一步转换: node scripts/pan-to-qa.js "${outFile}"`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 160)); process.exit(1); });
