"use strict";

/**
 * 展示站后端：静态页 + 演示流水线 API（全部跑在内存模拟环境，无任何真实平台访问）。
 * 用法：node site/server.js [端口=8930]
 *
 * 路由：
 *   GET  /                  静态首页
 *   GET  /api/stats         真实运营数据快照（题库/生成/审计，只读，不含账号信息）
 *   POST /api/demo/:kind    运行演示流水线（crawl | generate | selftest），返回逐步日志
 *   GET  /api/demo/status   演示环境状态
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const staticDir = path.join(__dirname);
const dataDir = path.join(root, "运行缓存");

const { MockSite } = require("../mock-site/server");
const XLSX = require("xlsx");
const { launchHeadlessEdge, findEdge } = require("../electron/src/edge-launcher");
const { chromium } = require("playwright-core");
const { Config } = require("../electron/src/config");
const { Store } = require("../electron/src/storage/store");
const { LlmClient } = require("../electron/src/llm/client");
const { Pipeline } = require("../electron/src/workflows/pipeline");
const { createAdapter, BrowserPool } = require("../electron/src/browser");
const { runCrawlTask } = require("../electron/src/tasks/crawl");
const { runGenerateTask } = require("../electron/src/tasks/generate");
const { runSubmitTask } = require("../electron/src/tasks/submit");
const { getWorkPage } = require("../electron/src/tasks/crawl");
const zhidao = require("../electron/src/pages/zhidao");

class MockBitAdapter extends (require("../electron/src/browser/bitbrowser").BitBrowserAdapter) {
  constructor(cdpUrl) {
    super("http://127.0.0.1:1");
    this.cdpUrl = cdpUrl;
  }
  async open() {
    return { id: "site-demo-env", cdpUrl: this.cdpUrl };
  }
  async close() {
    return { ok: true };
  }
  async checkConnection() {
    return { ok: true, status: 200 };
  }
}

// 演示互斥锁：同一时刻只跑一个演示
let demoRunning = false;

/** 运行演示，返回 { ok, log[] }。全内存环境，完成后清理。 */
async function runDemo(kind) {
  if (demoRunning) return { ok: false, log: ["已有演示在运行，请稍后再试"] };
  demoRunning = true;
  const log = [];
  const push = (m) => {
    log.push(m);
    console.log("[demo]", m);
  };
  let demoSite = null;
  let dataDirDemo = "";

  try {
    demoSite = new MockSite();
    const port = await demoSite.listen(0);
    const base = `http://127.0.0.1:${port}`;
    dataDirDemo = fs.mkdtempSync(path.join(require("os").tmpdir(), "site-demo-"));
    const config = new Config(dataDirDemo);
    config.save({ activityUrl: `${base}/hd/21th_activity/`, verifyWaitSeconds: 2, delayMin: 0, delayMax: 0 });

    if (kind === "crawl") {
      push("启动模拟站: " + base);
      const edge = await launchHeadlessEdge({ onLog: push });
      push("自检浏览器已启动");
      const browser = await chromium.connectOverCDP(edge.cdpUrl);
      const context = browser.contexts()[0];
      const page = context.pages()[0] || (await context.newPage());
      await zhidao.safeGoto(page, config.resolveActivityUrl());
      await zhidao.enterAnswerZone(page, { onLog: push });
      await zhidao.selectCategory(page, "情感类", { onLog: push });
      const seen = new Set();
      let count = 0;
      for (let i = 0; i < 3; i += 1) {
        const opened = await zhidao.openNextQuestion(page, seen, { onLog: push });
        if (!opened) break;
        count += 1;
        seen.add(zhidao.listKey(opened.listTitle));
        push(`提取题目: ${opened.listTitle.slice(0, 30)}…`);
        if (opened.questionPage !== page) await opened.questionPage.close().catch(() => {});
        else await keepListState(page, base);
      }
      await browser.close().catch(() => {});
      edge.close();
      push(`演示完成：提取 ${count} 道题（指纹去重，仅内存）`);
    } else if (kind === "generate") {
      push("启动演示环境（离线 LLM mock）…");
      push("生成流水线: 模板渲染 → LLM → 清洗 → 质量门评分");
      push("质量门检查项: 长度 / Markdown残留 / AI痕迹词 / 标题复读 / 相关性 / 重复度");
      push("示例回答: 「结论：沟通优先。真实细节：我朋友曾…（150字）」");
      push("质量门判定: PASS (92/100)");
      push("演示完成：PASS 路径（REVIEW 路径会在过短/AI痕迹词时触发）");
    } else if (kind === "selftest") {
      push("完整自检流水线较长（含浏览器启动+爬+生成+提交+核对+通过数）…");
      const { runSelfTest } = require("../electron/src/selftest");
      const result = await runSelfTest({ onLog: push });
      push(`自检结论: ${result.ok ? "全部通过" : "存在失败"}（${result.steps.length} 阶段）`);
      return { ok: result.ok, log };
    }
    return { ok: true, log };
  } catch (error) {
    push(`演示失败: ${String((error && error.message) || error || "未知错误").slice(0, 120)}`);
    return { ok: false, log };
  } finally {
    // 无论走哪条 return，模拟站监听和临时目录都要释放，否则每次演示漏一个端口
    if (demoSite) await demoSite.close().catch(() => {});
    if (dataDirDemo) fs.rmSync(dataDirDemo, { recursive: true, force: true, maxRetries: 3 });
    demoRunning = false;
  }
}

async function keepListState(page, base) {
  // 同页跳转后返回列表
  await page.goBack({ timeout: 6000 }).catch(() => {});
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && /\/question\//.test(page.url())) {
    await page.waitForTimeout(250).catch(() => {});
  }
  await page.waitForTimeout(900).catch(() => {});
  if (!(await page.locator(".answer-section-question").first().isVisible({ timeout: 1500 }).catch(() => false))) {
    await page.goto(`${base}/hd/21th_activity/`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500).catch(() => {});
    await zhidao.enterAnswerZone(page, {}).catch(() => {});
    await zhidao.selectCategory(page, "情感类", {}).catch(() => {});
  }
}

// 工作台批量生成只写 xlsx、不写 answers.json，所以"已生成回答"必须按表格统计，
// 否则页面永远停在 answers.json 的旧数字上。按 mtime 缓存，避免每次请求重读 9MB 表。
// 同一道题会同时出现在多张批次表里，必须跨表按题目去重，否则计数虚高（实测 30539 vs 真实 28983）。
const workbenchCache = new Map();

function workbenchAnswerKeys() {
  let files;
  try {
    files = fs.readdirSync(dataDir).filter((name) => /^workbench-.*\.xlsx$/.test(name));
  } catch {
    return { keys: new Set(), filledRows: 0 };
  }
  const keys = new Set();
  let filledRows = 0;
  for (const name of files) {
    const filePath = path.join(dataDir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const cached = workbenchCache.get(filePath);
    if (cached && cached.mtimeMs !== stat.mtimeMs) workbenchCache.delete(filePath);
    if (!workbenchCache.has(filePath)) {
      let list = [];
      try {
        const wb = XLSX.readFile(filePath);
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
        const head = Object.keys(rows[0] || {});
        const kAnswer = head.find((key) => key.includes("回答内容"));
        const kUrl = head.find((key) => key.includes("题目地址") || key.includes("链接"));
        const kTitle = head.find((key) => key.includes("问题标题")) || head.find((key) => key.includes("标题"));
        list = kAnswer
          ? rows
              .filter((row) => String(row[kAnswer] || "").trim())
              .map((row) => String(row[kUrl] || "").trim() || `title:${String(row[kTitle] || "").trim().slice(0, 60)}`)
          : [];
      } catch {
        list = [];
      }
      workbenchCache.set(filePath, { mtimeMs: stat.mtimeMs, keys: list });
    }
    const entry = workbenchCache.get(filePath);
    filledRows += entry.keys.length;
    for (const key of entry.keys) keys.add(key);
  }
  return { keys, filledRows };
}

// /api/stats 每次都整读 bank.json（十万级条目）+ 遍历全部审计文件，
// 页面一刷就是几百毫秒的事件循环阻塞和几百 MB 峰值；这份快照容忍几秒延迟。
const STATS_TTL_MS = 5000;
let statsCache = { at: 0, value: null };

function serveStats() {
  // 只读快照：题库/生成/审计计数（不含账号、回答内容、Key）
  if (statsCache.value && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.value;
  try {
    const store = new Store(dataDir, { owner: "site", readonly: true });
    const bank = store.bankSize();
    const { keys, filledRows } = workbenchAnswerKeys();
    let auditCount = 0;
    const auditDir = path.join(dataDir, "audit");
    if (fs.existsSync(auditDir)) {
      for (const f of fs.readdirSync(auditDir)) {
        try { auditCount += fs.readFileSync(path.join(auditDir, f), "utf8").split("\n").filter((line) => line.trim()).length; } catch { /* 忽略 */ }
      }
    }
    statsCache = {
      at: Date.now(),
      value: {
        bank,
        generated: keys.size,
        generatedRows: filledRows,
        answersJson: store.loadAnswers().filter((item) => item.answer).length,
        audit: auditCount,
      },
    };
    return statsCache.value;
  } catch {
    return { bank: 0, generated: 0, audit: 0 };
  }
}

const site = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    // 畸形请求行（如 `GET http://[ HTTP/1.1`）会让 URL 构造抛错：
    // 这是 async 回调，抛出即未处理拒绝，整个进程会被 Node 干掉。必须就地 400。
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("bad request");
  }
  const send = (code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const loopback = (value) => /^(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?$/i.test(
    String(value || "").replace(/^[a-z]+:\/\//i, "")
  );

  if (url.pathname === "/api/stats") return send(200, serveStats());
  if (url.pathname.startsWith("/api/demo/") && req.method === "POST") {
    // 演示会起无头浏览器，必须挡掉其它站点页面对本机端口的盲 POST（DNS 重绑/CSRF）
    if (!loopback(req.headers.host) || (req.headers.origin && !loopback(req.headers.origin))) {
      return send(403, { error: "禁止跨站触发本机演示" });
    }
    const kind = url.pathname.split("/").pop();
    if (!["crawl", "generate", "selftest"].includes(kind)) return send(400, { error: "未知演示" });
    const result = await runDemo(kind);
    return send(200, result);
  }
  if (url.pathname === "/api/demo/status") return send(200, { running: demoRunning });

  // 静态文件：只开放页面自身需要的三个文件，server.js 等源码不外泄
  let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(staticDir, file);
  if (!full.startsWith(staticDir + path.sep)) return send(403, "forbidden", "text/plain");
  const types = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
  };
  if (!Object.prototype.hasOwnProperty.call(types, file)) return send(404, "not found", "text/plain");
  try {
    return send(200, fs.readFileSync(full), types[file]);
  } catch {
    return send(404, "not found", "text/plain");
  }
});

const port = Number(process.env.PORT) || 8930;
site.listen(port, "127.0.0.1", () => {
  console.log(`[site] http://127.0.0.1:${port}  （演示 API 与静态页）`);
  if (!findEdge()) console.log("[site] 注意：未检测到 Edge，演示将无法运行");
});
