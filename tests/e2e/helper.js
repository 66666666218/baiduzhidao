"use strict";

/**
 * E2E 测试辅助：拉起 mock-site + 无头 Edge（CDP）+ 临时目录依赖。
 * 全程不依赖真实百度账号、比特浏览器和真实 LLM。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { MockSite } = require("../../mock-site/server");
const { Config } = require("../../electron/src/config");
const { Store } = require("../../electron/src/storage/store");
const { LlmClient } = require("../../electron/src/llm/client");
const { createAdapter, BrowserPool } = require("../../electron/src/browser");
const { BitBrowserAdapter } = require("../../electron/src/browser/bitbrowser");
const { launchHeadlessEdge } = require("../../electron/src/edge-launcher");

function findEdge() {
  const { findEdge: find } = require("../../electron/src/edge-launcher");
  return find();
}

/** 构建全套测试依赖（真实模块 + mock 外部服务） */
async function createTestRig() {
  const site = new MockSite();
  const port = await site.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const edge = await launchHeadlessEdge();

  // 指向 mock 的比特适配器：open() 直接返回 Edge 的 CDP 地址
  class MockBitAdapter extends BitBrowserAdapter {
    async open() {
      return { id: "mock-env", cdpUrl: edge.cdpUrl };
    }
    async close() {
      return { ok: true };
    }
    async checkConnection() {
      return { ok: true, status: 200 };
    }
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-rig-"));
  const config = new Config(dataDir);
  config.save({ activityUrl: `${base}/hd/21th_activity/`, verifyWaitSeconds: 2, delayMin: 0, delayMax: 0 });

  const store = new Store(dataDir);
  const logs = [];
  const log = (message) => logs.push(message);

  const llm = new LlmClient({
    apiKey: "test-key",
    baseUrl: `${base}/v1/chat/completions`,
    model: "mock-model",
    concurrency: 2,
  });

  const browserPool = new BrowserPool(new MockBitAdapter(base));

  const deps = { browserPool, store, config, log, llm };

  return {
    site,
    deps,
    dataDir,
    logs,
    base,
    cdpUrl: edge.cdpUrl,
    async cleanup() {
      browserPool.adapter = { close: async () => {} };
      await browserPool.closeAll().catch(() => {});
      edge.close();
      await site.close();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
    },
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

module.exports = { createTestRig, fetchJson, launchHeadlessEdge, MockSite };
