"use strict";

/**
 * 一键自检（v2.1-③ 起基于 Pipeline 执行器）：
 * 不依赖比特浏览器 / 真实 AI Key / 真实账号，
 * 内部拉起 模拟站 + 无头 Edge（CDP），按流水线阶段依次跑通：
 *   模拟站 → 自检浏览器 → 引擎装配 → 迷你爬题 → 模拟生成 → 自动提交 → 提交核对 → 通过数读取
 * 用于安装后验证引擎可用性，以及改版后快速定位断在哪一环。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const { MockSite } = require("../../mock-site/server");
const { launchHeadlessEdge, findEdge } = require("./edge-launcher");
const { BitBrowserAdapter } = require("./browser/bitbrowser");
const { BrowserPool } = require("./browser");
const { Config } = require("./config");
const { Store } = require("./storage/store");
const { LlmClient } = require("./llm/client");
const { Pipeline } = require("./workflows/pipeline");
const { runCrawlTask } = require("./tasks/crawl");
const { runGenerateTask } = require("./tasks/generate");
const { runSubmitTask } = require("./tasks/submit");
const { getWorkPage } = require("./tasks/crawl");
const zhidao = require("./pages/zhidao");

class MockBitAdapter extends BitBrowserAdapter {
  constructor(cdpUrl) {
    super("http://127.0.0.1:1");
    this.cdpUrl = cdpUrl;
  }
  async open() {
    return { id: "selftest-env", cdpUrl: this.cdpUrl };
  }
  async close() {
    return { ok: true };
  }
  async checkConnection() {
    return { ok: true, status: 200 };
  }
}

async function runSelfTest({ onLog = () => {} } = {}) {
  const steps = [];
  const stage = (name, fn) => ({
    name,
    run: async (args) => {
      const started = Date.now();
      onLog(`[自检] ${name} ...`);
      try {
        const detail = (await fn(args)) || "";
        steps.push({ name, ok: true, ms: Date.now() - started, detail: String(detail) });
        onLog(`[自检] ✅ ${name}（${Date.now() - started}ms）${detail ? `：${detail}` : ""}`);
        return detail;
      } catch (error) {
        steps.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
        onLog(`[自检] ❌ ${name}：${error.message}`);
        throw error;
      }
    },
  });

  // 环境前瞻：没装 Edge 时直接给出结论
  if (!findEdge()) {
    const message = "本机没有找到 Edge 浏览器，无法自检（不影响正常答题功能）";
    steps.push({ name: "环境检查", ok: false, ms: 0, detail: message });
    onLog(`[自检] ❌ ${message}`);
    return { ok: false, steps };
  }

  const site = new MockSite();
  const port = await site.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const state = { edge: null, deps: null };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-selftest-"));

  const noopCtxOf = (payload) => ({
    payload,
    shouldStop: () => false,
    livePayload() {
      return this.payload;
    },
    updateLiveSettings: () => {},
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  });

  const pipeline = new Pipeline({
    name: "selftest",
    stages: [
      stage("启动内置模拟站", async () => base),
      stage("启动自检浏览器（无头 Edge）", async () => {
        state.edge = await launchHeadlessEdge({ onLog });
        return state.edge.cdpUrl;
      }),
      stage("装配引擎依赖", async ({ previous }) => {
        const cdpUrl = previous["启动自检浏览器（无头 Edge）"];
        const config = new Config(dataDir);
        config.save({ activityUrl: `${base}/hd/21th_activity/`, verifyWaitSeconds: 2, delayMin: 0, delayMax: 0 });
        const store = new Store(dataDir);
        const llm = new LlmClient({
          apiKey: "selftest",
          baseUrl: `${base}/v1/chat/completions`,
          model: "mock-model",
          concurrency: 1,
        });
        const browserPool = new BrowserPool(new MockBitAdapter(cdpUrl));
        state.deps = {
          config, store, llm, browserPool,
          log: onLog,
          copy: async () => {},
          autosavePath: "",
        };
        return "Store/LLM/BrowserPool 就绪";
      }),
      stage("迷你爬题（模拟站 · 情感类）", async () => {
        const result = await runCrawlTask(
          noopCtxOf({ bitEnvs: [{ label: "自检账号" }], category: "情感类", crawlStartPage: 1 }),
          state.deps
        );
        if (result.count < 1) throw new Error(`爬到 ${result.count} 条`);
        return `入库 ${result.count} 条`;
      }),
      stage("模拟 AI 生成（1 题）", async () => {
        const bank = state.deps.store.loadBank();
        const rows = bank.slice(0, 1).map((item) => ({ ...item }));
        const result = await runGenerateTask(noopCtxOf({ results: rows, aiApiKey: "selftest" }), state.deps);
        if (result.count < 1) throw new Error("没有生成出回答");
        return `回答长度 ${result.results[0].answer.length} 字`;
      }),
      stage("自动提交（1 条 · 提交到模拟站）", async () => {
        const rows = state.deps.store.loadBank().slice(0, 1).map((item) => ({
          ...item,
          answer: state.deps.store.findAnswer(item).answer,
          status: "已生成回答",
        }));
        const result = await runSubmitTask(
          noopCtxOf({ bitEnvs: [{ label: "自检账号" }], results: rows, accountDailyLimit: 0 }),
          state.deps
        );
        if (result.count < 1) throw new Error("没有提交成功");
        return "模拟站已收到";
      }),
      stage("核对模拟站提交内容", async () => {
        if (!site.submissions.length) throw new Error("模拟站没有收到任何提交");
        const last = site.submissions[site.submissions.length - 1];
        if (!last.content || last.content.length < 20) throw new Error("提交内容异常");
        return `题目「${String(last.title).slice(0, 18)}…」`;
      }),
      stage("当天通过数读取", async () => {
        const browser = await chromium.connectOverCDP(state.edge.cdpUrl);
        try {
          const context = browser.contexts()[0] || (await browser.newContext());
          const page = await getWorkPage(context);
          await zhidao.safeGoto(page, `${base}/hd/21th_activity/`);
          await zhidao.enterAnswerZone(page, { onLog });
          const rows = await zhidao.readDailyPassed(page);
          const hit = rows.find((row) => row.done === 2 && row.total === 5);
          if (!hit) throw new Error(`未解析出 2/5 进度：${JSON.stringify(rows).slice(0, 120)}`);
          return "解析 2/5 正常";
        } finally {
          await browser.close().catch(() => {});
        }
      }),
    ],
  });

  let ok = true;
  try {
    await pipeline.run({ input: null, ctx: {} });
  } catch {
    ok = false;
  } finally {
    try {
      if (state.deps && state.deps.browserPool) await state.deps.browserPool.closeAll();
    } catch {
      /* 忽略 */
    }
    if (state.edge) state.edge.close();
    await site.close().catch(() => {});
    setTimeout(() => {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* 句柄延迟 */
      }
    }, 1500);
  }

  return { ok, steps };
}

module.exports = { runSelfTest };
