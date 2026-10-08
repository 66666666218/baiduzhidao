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
const { INVOKE_CHANNELS, LISTENER_CHANNELS } = require("../../electron/src/ipc-channels");

test("契约①：renderer 调用的所有通道都在 preload 白名单内", () => {
  const called = new Set([...rendererJs.matchAll(/rpc\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]));
  const whitelist = new Set([...preloadJs.matchAll(/"([a-z]+:[a-z-]+)"/gi)].map((m) => m[1]));
  const missing = [...called].filter((c) => !whitelist.has(c));
  assert.deepEqual(missing, [], `renderer 调用但不在白名单: ${missing.join(", ")}`);
});

test("契约①-b：preload 内联通道清单与 src/ipc-channels.js 必须完全一致（invoke + 推送）", () => {
  // preload 在 sandbox:true 下拿不到本地模块，只能内联一份；主进程用的那份在 ipc-channels.js。
  // 两份清单漂移的后果是"通道只在一边存在"，所以这里强制相等。
  // 只解析 invokeChannels 那个块：listenerChannels（task:log 等）是另一个集合，不参与比对。
  const block = preloadJs.match(/const invokeChannels = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "没能在 preload.js 里定位到 invokeChannels 清单");
  const inline = new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const shared = new Set(INVOKE_CHANNELS);
  const onlyInline = [...inline].filter((c) => !shared.has(c));
  const onlyShared = [...shared].filter((c) => !inline.has(c));
  assert.deepEqual(onlyInline, [], `只在 preload 里有：${onlyInline.join(", ")}`);
  assert.deepEqual(onlyShared, [], `只在 ipc-channels.js 里有：${onlyShared.join(", ")}`);

  // 推送（监听）通道同理：主进程 emit 了、preload 不在白名单里，界面就永远收不到
  const listenerBlock = preloadJs.match(/const listenerChannels = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(listenerBlock, "没能在 preload.js 里定位到 listenerChannels 清单");
  const inlineListeners = new Set([...listenerBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const sharedListeners = new Set(LISTENER_CHANNELS);
  assert.deepEqual([...inlineListeners].filter((c) => !sharedListeners.has(c)), [], "推送通道只在 preload 里有");
  assert.deepEqual([...sharedListeners].filter((c) => !inlineListeners.has(c)), [], "推送通道只在 ipc-channels.js 里有");
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
    "task:upload-by-topic": "electron/src/tasks/upload-batch.js",
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

/**
 * 从 app-context 里抠出 `startTask("<name>", { ... })` 那个对象字面量的**顶层**键名。
 *
 * 用状态机而不是正则：正则分不清 `{ filePath: x, results }` 里的 `x`（值）和 `results`（简写键）——
 * 第一版就是因此把值也当成了键。这里跟踪"下一个标识符是不是键"，
 * 并跳过字符串，避免值里的逗号/花括号把计数带偏。
 */
/**
 * 把搜索范围限定在「一键全自动」那段代码里。
 * 不限定的话会匹配到 IPC 处理器里的 startTask 调用——那些传的是 `payload` 或
 * `{ ...payload, results }`，抠出来的是别的阶段/别的花括号，比不检查还糟。
 */
function autoPipelineSource(source) {
  const start = source.indexOf('"task:auto-pipeline"');
  if (start < 0) return "";
  const next = source.indexOf("ipcMain.handle(", start + 10);
  return next > start ? source.slice(start, next) : source.slice(start);
}

function extractStagePayloadKeys(source, name) {
  const marker = new RegExp(`startTask\\(\\s*"${name}"\\s*,\\s*\\{`);
  const hit = marker.exec(source);
  if (!hit) return null;
  const braceStart = source.indexOf("{", hit.index + hit[0].length - 1);
  if (braceStart < 0) return null;
  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(braceStart + 1, end);

  const keys = new Set();
  let d = 0;
  let expectKey = true;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") { d += 1; expectKey = false; i += 1; continue; }
    if (ch === "}") { d -= 1; i += 1; continue; }
    if (ch === ",") { if (d === 0) expectKey = true; i += 1; continue; }
    // 跳过注释：注释里的标识符（比如「filePath 必须传」这句）会被误当成键，
    // 结果既认不出真正的那个键，还会让后面的键因为 expectKey 被吃掉而漏掉。
    if (ch === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      const close = body.indexOf("*/", i + 2);
      i = close < 0 ? body.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { // 跳过字符串字面量
      i += 1;
      while (i < body.length && body[i] !== ch) i += body[i] === "\\" ? 2 : 1;
      i += 1;
      expectKey = false;
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    const m = /^([A-Za-z_$][\w$]*)/.exec(body.slice(i));
    if (m) {
      if (d === 0 && expectKey) keys.add(m[1]);
      expectKey = false;
      i += m[1].length;
      continue;
    }
    i += 1;
  }
  return keys;
}

test("契约⑤：一键全自动各阶段传的字段，必须覆盖对应任务会读的 payload 字段", () => {
  // 这条是补盲区：E2E 测的是各任务函数本身，**编排器传什么**没人管。
  // 结果就是 generate 阶段漏传 filePath —— 生成"成功"但答案没写回表格，
  // 紧接着提交报「表格里有题目链接但没有回答内容」，看起来像生成没干活。
  const pipelineSrc = autoPipelineSource(read("electron/app-context.js"));
  assert.ok(pipelineSrc.length > 0, "没能定位到「一键全自动」那段代码，契约⑤失效了——请检查 marker");
  const stageFileOf = {
    crawl: "electron/src/tasks/crawl.js",
    generate: "electron/src/tasks/generate.js",
    submit: "electron/src/tasks/submit.js",
    "batch-transfer": "electron/src/tasks/batch-transfer.js",
    "upload-by-topic": "electron/src/tasks/upload-batch.js",
  };
  const problems = [];
  for (const [stage, file] of Object.entries(stageFileOf)) {
    const sent = extractStagePayloadKeys(pipelineSrc, stage);
    if (!sent) continue; // 该阶段没出现在编排里
    const src = read(file);
    for (const m of src.matchAll(/payload\.([a-zA-Z]\w*)/g)) {
      if (!sent.has(m[1])) problems.push(`${stage} 阶段没传 payload.${m[1]}（${file} 会读它）`);
    }
  }
  // 任务内自带默认值的字段豁免（这些确实在任务里有 `|| 默认`）
  const allowedDefaults = ["bitEnv", "start", "outName", "makeShare", "resume", "pageDelayMs", "crawlOutputDir", "enrichLimit", "limit", "maxBatches", "perEnv", "cc", "delayMin", "delayMax", "outName"];
  const real = problems.filter((p) => !allowedDefaults.some((a) => p.includes("payload." + a)));
  assert.deepEqual(real, [], real.join("\n"));
});

test("契约⑤-b：extractStagePayloadKeys 能正确抠出（含嵌套）顶层键", () => {
  const sample = 'startTask("generate", { filePath: x, results: rows, nested: { a: 1, b: 2 } }, (c) => run(c))';
  const keys = extractStagePayloadKeys(sample, "generate");
  assert.deepEqual([...keys].sort(), ["filePath", "nested", "results"], "嵌套对象只取顶层键名");
  assert.equal(extractStagePayloadKeys(sample, "不存在的阶段"), null);
});
