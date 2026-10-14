"use strict";

/**
 * 第 23 轮：用户问「在生成问答的时候是否可以并发呢，一条一条生成太慢了你不觉的吗」。
 *
 * 先给结论（都回代码核对过，不是猜的）：
 *   · AI 生成阶段**本来就是并发的**，并发数是设置页「AI 生成答案」里的「并发数」（1~8）。
 *     真机实测（2026-10-09 那次跑批的日志）：51 题、并发 2、共 135 秒 = 2.65 秒/题。
 *   · 但默认值只有 2，而且界面上那个数字旁边**一个字都没解释** ——
 *     用户看完日志里"并发 2"也不会往"我可以调到 8"上想。这就是本轮要修的：
 *     默认 2 → 6，并在输入框下面把"单条多久 / 调高会怎样 / 429 会怎样"写清楚。
 *   · 顺带补上生成阶段从来没有的东西：**节奏播报**（每 10 条一次「进度/秒条/还剩多久」）。
 *     用户盯着 20 条一点点蹦，最想问的就是"还要多久"，以前这一段一个数字都不给。
 *
 * 两个设计约束（本项目的规矩）：
 *   ① 「秒/条」与 ETA 的口径**全仓只有一处** = netdisk/transfer-progress.js。
 *      生成阶段只复用它的 shouldReportPace / progressLine / measurePace / formatDuration，
 *      不在 generate.js 里另算一份 —— 两个"还剩多久"互相不一致，比没有更糟。
 *   ② 静态守卫只能守"接线"，守不住逻辑。所以 shouldReportPace 的行为由 G1 **真调**验证，
 *      generate.js 里怎么用它由 G3 扫文本验证（锚点唯一）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { normalizeSettings, AI_CONCURRENCY_MAX } = require("../../electron/src/config");
const {
  shouldReportPace, progressLine, measurePace, generatePaceTail, PACE_EVERY,
} = require("../../electron/src/netdisk/transfer-progress");

const GENERATE = "electron/src/tasks/generate.js";
const TRANSFER_PROGRESS = "electron/src/netdisk/transfer-progress.js";
const CONFIG = "electron/src/config.js";
const RENDERER = "electron/renderer/renderer.js";
const INDEX_HTML = "electron/renderer/index.html";

function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取一段唯一区段（锚点必须恰好命中一次，否则后面全部断言都是空话） */
function sliceBetween(src, startNeedle, endNeedle) {
  const a = src.indexOf(startNeedle);
  assert.notEqual(a, -1, `找不到起始锚点：${startNeedle}`);
  const b = src.indexOf(endNeedle, a + startNeedle.length);
  assert.notEqual(b, -1, `找不到结束锚点：${endNeedle}`);
  return src.slice(a, b + endNeedle.length);
}

// --------------------------------------------- G 组：节奏播报的判据（纯函数，真调）

test("G1 shouldReportPace：样本至少 2 条才报，之后每 10 条一次", () => {
  // 为什么样本 <2 不报：单条生成耗时的波动能到一倍以上（题目长短、供应商排队），
  // 拿 1 条算出来的"秒/条"和 ETA 是在骗人。本项目在"给一个拍脑袋数字"上栽过的跟头
  // 足够写一页，所以宁可少报一次。
  assert.equal(shouldReportPace({ done: 0 }), false);
  assert.equal(shouldReportPace({ done: 1 }), false);
  assert.equal(shouldReportPace({ done: 2 }), false, "2 条不是 10 的倍数，不报");
  assert.equal(shouldReportPace({ done: 9 }), false);
  assert.equal(shouldReportPace({ done: 10 }), true);
  assert.equal(shouldReportPace({ done: 11 }), false);
  assert.equal(shouldReportPace({ done: 20 }), true);
  assert.equal(shouldReportPace({ done: 25 }), false, "25 不是 10 的倍数");
  assert.equal(shouldReportPace({ done: 30 }), true);
  // every 可注入（测试与将来改节奏都不用改调用方）
  assert.equal(shouldReportPace({ done: 5, every: 5 }), true);
  assert.equal(shouldReportPace({ done: 3, every: 5 }), false);
  // 缺省值就是导出的 PACE_EVERY，且是 10（转存那边用 25，生成一批通常只有几十条）
  assert.equal(PACE_EVERY, 10);
});

test("G2 生成阶段复用的是 transfer-progress 的口径，不是本地另算一份", () => {
  // 这条守的是"一条逻辑只有一个家"：如果 generate.js 自己写了一份
  // `(elapsed / done / 1000).toFixed(1)`，就会出现两个"秒/条"互相不一致。
  const src = read(GENERATE);
  assert.match(
    src,
    /const \{ progressLine, measurePace, shouldReportPace, generatePaceTail \} = require\("\.\.\/netdisk\/transfer-progress"\);/,
    "generate.js 必须从 netdisk/transfer-progress 解构这四个函数（含收尾文案）",
  );
  // 反向：本地连"秒/条"这三个字都不许出现 —— round19 的 E7 就是全仓扫这个
  assert.doesNotMatch(stripComments(src), /秒\/条/, "generate.js 不许自己出现秒/条，文案归 transfer-progress");
});

test("G2b generatePaceTail：有样本才说，没样本闭嘴（不说 0 秒/条）", () => {
  // 收尾那句「（并发 6，实测 2.6 秒/条，共 2 分钟）」在 transfer-progress 里，
  // 因为「秒/条」口径只许有一个家（E7）。这里验的是它自己的行为。
  assert.equal(generatePaceTail({ concurrency: 6, perItemMs: 0, elapsedMs: 135000 }), "", "pace=0 = 算不出来，必须闭嘴");
  assert.equal(generatePaceTail({ concurrency: 6, perItemMs: -1, elapsedMs: 135000 }), "");
  assert.equal(generatePaceTail({ concurrency: 6, perItemMs: 2600, elapsedMs: 135000 }), "（并发 6，实测 2.6 秒/条，共 2 分钟）");
  assert.equal(generatePaceTail({ concurrency: 2, perItemMs: 2600, elapsedMs: 135000 }), "（并发 2，实测 2.6 秒/条，共 2 分钟）");
  // 并发数是脏数据时按 1 算，别在文案里出现"并发 0 条"
  assert.equal(generatePaceTail({ concurrency: 0, perItemMs: 2600, elapsedMs: 135000 }), "（并发 1，实测 2.6 秒/条，共 2 分钟）");
  // 总时长算不出来（负数/NaN）时只报 pace，不硬凑一个"共 0 秒"
  assert.equal(generatePaceTail({ concurrency: 6, perItemMs: 2600, elapsedMs: -5 }), "（并发 6，实测 2.6 秒/条）");
});

test("G3 节奏播报真的接在了 worker 循环里（锚点唯一）", () => {
  const src = read(GENERATE);
  const block = sliceBetween(
    src,
    "ctx.report({ done: results.filter(Boolean).length, total, status: \"running\" });",
    "if (filePath) await maybeWriteTable(false);",
  );
  assert.match(block, /const finished = results\.filter\(Boolean\)\.length;/);
  assert.match(block, /shouldReportPace\(\{ done: finished \}\)/);
  assert.match(block, /measurePace\(\{ done: finished, elapsedMs: Date\.now\(\) - generateStartedAt \}\)/);
  assert.match(block, /progressLine\(\{ done: finished, total, perItemMs: pace \}\)/);
  // 播报必须走 log（进日志文件），不能只 emit 到渲染端面板
  assert.match(block, /if \(paceLine\) log\(paceLine\);/);
});

test("G4 收尾行带实测节奏，且文案归 transfer-progress（秒/条只有一个家）", () => {
  const src = read(GENERATE);
  const block = sliceBetween(src, "const stopped = ctx.shouldStop() || budgetExhausted;", "if (filePath) {");
  assert.match(block, /const paceAll = measurePace\(\{ done: finishedAll, elapsedMs: elapsedAll \}\)/);
  // 收尾文案必须由 transfer-progress 出，generate.js 不自己拼（秒/条口径只有一个家）。
  // 用 \s* 匹配多行调用，不许在 generate.js 里出现手写的"秒/条"。
  assert.match(
    block,
    /generatePaceTail\(\{\s*concurrency: llm\.semaphore\.limit, perItemMs: paceAll, elapsedMs: elapsedAll, rateLimited,\s*\}\)/,
    "收尾文案必须由 transfer-progress 出，generate.js 不自己拼",
  );
  assert.doesNotMatch(block, /秒\/条/, "generate.js 里不许出现秒/条文案");
  // 文案要接在总结论的那一行末尾，而不是另起一行（用户要的是一眼看完）
  assert.match(block, /失败 \$\{failed\} 条\$\{paceTail\}/);
});

// --------------------------------------------- H 组：并发数的默认值、提示与入口

test("H1 并发数默认 6（不再是 2），且老设置不被覆盖", () => {
  // 依据：2026-10-09 真机实测 51 题 / 并发 2 / 135 秒 = 2.65 秒/题；
  // 同一条批在 6 条并发下约 45 秒。敢默认给 6 的理由是 429 有退避重试兜底（见 LlmClient）。
  // ⚠️ 上限（AI_CONCURRENCY_MAX）在**第 24 轮**改过（8 → 64），那条归 round24 的 K1 守，
  // 这里不再写死数字 —— 否则上限一改就出现"测试守着旧值、还全绿"的假象。
  const dflt = normalizeSettings({});
  assert.equal(dflt.aiConcurrency, 6, "新装/缺省应该是 6");
  assert.equal(normalizeSettings({ aiConcurrency: 0 }).aiConcurrency, 1, "下限 1");
  assert.equal(normalizeSettings({ aiConcurrency: -3 }).aiConcurrency, 1);
  // 已存在的用户设置不被默认值覆盖（他们 settings.json 里写着 2，就还是 2，要自己改）
  assert.equal(normalizeSettings({ aiConcurrency: 2 }).aiConcurrency, 2);
});

test("H2 设置页并发数输入框下面有解释（可调范围、单条多久、429 会退避）", () => {
  // 这一条修的是"功能在、入口没有"的姊妹篇——"功能在、说明没有"：
  // 以前那个 number 输入框光秃秃一个数字，用户根本不知道它能调、调了会怎样。
  // ⚠️ 范围文字（1~64）跟 config 的 AI_CONCURRENCY_MAX 是两处，round24 的 O2/K2 钉着它们一致。
  const html = read(INDEX_HTML);
  const block = sliceBetween(html, "<input type=\"number\" id=\"aiConcurrency\"", "</div>");
  assert.match(block, /class="hint"/, "并发数输入框下面必须跟一句解释");
  assert.match(block, new RegExp(`1~${AI_CONCURRENCY_MAX}`), "要写清可调范围，且与后端上限一致");
  assert.match(block, /429/, "要写清供应商限流时会怎样（这是用户唯一担心的事：调高会不会烧号）");
  assert.match(block, /退避重试/);
  // 界面文案不许出现 markdown 的 **（渲染层不会解析，会原样显示给用户）
  assert.doesNotMatch(block, /\*\*/);
});

test("H3 设置页回填值与后端默认一致", () => {
  const src = read(RENDERER);
  assert.match(src, /\$\("aiConcurrency"\)\.value = settings\.aiConcurrency \|\| 6;/, "兜底值要和 config.js 的 DEFAULTS 一致");
});

// --------------------------------------------- I 组：注释/日志不许再说半句真话

test("I1 generate.js 不再宣称运行中改并发立即生效", () => {
  // 原来的注释写「热配置：运行中修改 AI 设置立即生效」。实际情况是：
  // worker 池按**启动时**的并发数起（`Math.min(llm.semaphore.limit, uniqueWork.length)`），
  // 调大时信号量里没有"正在排队的 worker"可放行 → 调大没有任何效果，要等下一轮。
  // 半句真话比不说更糟：用户照着做了，发现没变化，就会怀疑整个软件都是假的。
  const raw = read(GENERATE);
  assert.doesNotMatch(raw, /热配置：运行中修改 AI 设置立即生效/);
  assert.match(raw, /调小立即生效，调大要等下一轮/);
  // 注释归注释，行为也要对得上：worker 池确实只按启动时的并发数起
  //（这一行是上面那句注释的唯一依据，哪天它变了，注释就得跟着改）
  assert.match(stripComments(raw), /Math\.min\(llm\.semaphore\.limit, uniqueWork\.length\)/);
});

test("I2 开工日志点明并发数可调 + 429 会退避", () => {
  // 开工那一行是用户判断"要不要调并发数"的唯一现场提示，所以必须说清三件事：
  // 现在跑的是几并发、上限是多少、撞 429 会怎样。
  // ⚠️ 上限写的是模板变量 ${AI_CONCURRENCY_MAX}，所以这里按同一个常量拼正则
  // —— 硬写 "1~8" 会出现"上限早就改了、测试还守着旧值"的假象（第 24 轮刚踩过）。
  const src = read(GENERATE);
  assert.match(src, /并发 \$\{llm\.semaphore\.limit\}（设置页「AI 生成答案」里可调 /);
  assert.match(src, new RegExp(`1~\\$\\{AI_CONCURRENCY_MAX\\}；供应商限流返 429 会自动退避重试，不烧号`));
  // 数字必须是模板引用，不许又落回硬编码（否则改了上限而日志不改 = 界面在骗人）
  assert.doesNotMatch(src, /里可调 1~\d+；/, "上限不许写死，必须引用 AI_CONCURRENCY_MAX");
});

// --------------------------------------------- J 组：编译守卫（round13 D2）

test("J1 改动文件都能当脚本编译（模块顶层不许有 return）", () => {
  const vm = require("node:vm");
  for (const rel of [GENERATE, TRANSFER_PROGRESS, CONFIG, RENDERER]) {
    const raw = read(rel);
    assert.doesNotThrow(() => new vm.Script(raw, { filename: rel }), `${rel} 必须能通过 vm.Script`);
  }
});

test("J2 progressLine/measurePace 行为没被改坏（生成阶段复用它们）", () => {
  // 生成阶段直接拿这两个函数出文案，所以它们的既有行为必须照旧：
  // 样本不足返回 0（= 不知道，调用方据此不显示），ETA 未知时只报进度不报剩余。
  assert.equal(measurePace({ done: 0, elapsedMs: 5000 }), 0);
  assert.equal(measurePace({ done: 3, elapsedMs: 0 }), 0);
  assert.equal(measurePace({ done: 2, elapsedMs: 5000 }), 2500);
  assert.equal(progressLine({ done: 10, total: 20, perItemMs: 0 }), "📈 进度 10/20");
  assert.match(progressLine({ done: 10, total: 20, perItemMs: 2600 }), /📈 进度 10\/20（2\.6 秒\/条，剩余约 26 秒）/);
});
