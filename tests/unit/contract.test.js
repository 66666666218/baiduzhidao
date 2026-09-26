"use strict";

/**
 * 契约一致性测试（防止历史事故重演：bitEnv/bitEnvs 类字段名不匹配、通道缺失、DOM id 不存在）。
 *  1) renderer 调用的每个通道 → 必须在 preload 白名单 且 app-context 有对应 handler
 *  2) renderer 引用的每个 $("id") → 必须存在于 index.html
 *  3) 每个任务的 payload.字段 读取 → 必须在 renderer 对应 invoke 的对象字面量中出现（或已声明默认）
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const rendererJs = read("electron/renderer/renderer.js");
const indexHtml = read("electron/renderer/index.html");
const preloadJs = read("electron/preload.js");
const appContext = read("electron/app-context.js");

test("契约①：renderer 调用的所有通道都在 preload 白名单内", () => {
  const called = new Set([...rendererJs.matchAll(/rpc\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]));
  const whitelist = new Set([...preloadJs.matchAll(/"([a-z]+:[a-z-]+)"/gi)].map((m) => m[1]));
  const missing = [...called].filter((c) => !whitelist.has(c));
  assert.deepEqual(missing, [], `renderer 调用但不在白名单: ${missing.join(", ")}`);
});

test("契约②：renderer 调用的所有通道都有 main 侧 handler", () => {
  const called = new Set([...rendererJs.matchAll(/rpc\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]));
  const handled = new Set([...appContext.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]));
  const missing = [...called].filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], `renderer 调用但无 handler: ${missing.join(", ")}`);
});

test("契约③：renderer 引用的所有 DOM id 都存在于 index.html", () => {
  const used = new Set([...rendererJs.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]));
  const defined = new Set([...indexHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !defined.has(u));
  assert.deepEqual(missing, [], `renderer 引用但 html 中不存在: ${missing.join(", ")}`);
});

test("契约④：任务的 payload 字段都有来源（renderer 传参或显式默认）", () => {
  // 解析 renderer 中每个 task 通道的 invoke payload 键名
  const payloadKeysByChannel = new Map();
  const re = /rpc\.invoke\(\s*"(task:[a-z-]+)"\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  let m;
  while ((m = re.exec(rendererJs)) !== null) {
    const keys = new Set([...m[2].matchAll(/(?:^|[\s,{])([a-zA-Z][\w]*)\s*[:,]/g)].map((k) => k[1]));
    payloadKeysByChannel.set(m[1], keys);
  }
  const taskFileOf = {
    "task:batch-transfer": "electron/src/tasks/batch-transfer.js",
    "task:batch-upload": "electron/src/tasks/upload-batch.js",
    "task:submit": "electron/src/tasks/submit.js",
    "task:crawl": "electron/src/tasks/crawl.js",
  };
  const problems = [];
  for (const [channel, file] of Object.entries(taskFileOf)) {
    const sentKeys = payloadKeysByChannel.get(channel);
    if (!sentKeys) continue; // renderer 未调用（如 submit 由其它路径触发）
    const src = read(file);
    const readFields = new Set([...src.matchAll(/payload\.([a-zA-Z]\w*)/g)].map((x) => x[1]));
    for (const f of readFields) {
      if (!sentKeys.has(f)) problems.push(`${channel} 读取 payload.${f}，但 renderer 未传该字段（必须在任务内给默认值或 renderer 补传）`);
    }
  }
  // 允许任务内用默认值兜底的字段白名单（这些确实在任务里有 || 默认）
  const allowedDefaults = new Set(["bitEnv", "start", "cc", "delayMin", "delayMax", "makeShare", "maxBatches", "perEnv", "outName", "results"]);
  const real = problems.filter((p) => ![...allowedDefaults].some((a) => p.includes("payload." + a)));
  assert.deepEqual(real, [], real.join("\n"));
});
