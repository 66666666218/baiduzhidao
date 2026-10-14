"use strict";

/**
 * 第 19 轮：**「为什么还是一个一个的进行转存，我们不是有批量转存吗」**（用户 2026-10-14 反馈）。
 *
 * 先摆事实（都是从用户机器上的真实产物读出来的，不是推测）：
 *   · 资源表 `搜资源_20261014100937.xlsx` 共 **11164 行**，第一行资源名正是用户日志里的
 *     「求分享中国式网游_游戏百度网盘完整版下载」→ 用户看到的就是**这一个**批量任务的进度播报。
 *   · 台账 `批量转存/搜资源_20261014100937/state.jsonl` 实测：226 条完成用了 34 分 35 秒
 *     = **9.18 秒/条**，四段 50 条分别 481/432/458/451 秒 → 节奏非常均匀，是**串行**。
 *   · 用户 `settings.json` 里 `accountProxies: ""`（2 个账号但没配代理）
 *     → `autoParallel = 1` → `cc = 1` → 严格串行。**这不是 bug，是 2026-10-10 真机实验换来的硬规则**
 *     （同 IP 并发 cc=2 时 9/9 失败），可它从来没在界面上被解释过。
 *
 * 也就是说用户的两半疑问各有答案，而且**代码确实缺了东西**：
 *   ① "是不是批量" → 是。11164 条一次性入队，`✅ [N/11164]` 是进度播报，不是手动点。
 *      但代码没有一句话说明这一点 → 缺。
 *   ② "然后生成问答表格" → 顺序**本来就是对**的（转存成功 → 建分享 → 写 qaRow → 生成上传专用表），
 *      可这张表**只在整批结束时写一次**：11164 条 × 9.18 秒 ≈ **28.5 小时**，
 *      等于"第二天下午才第一次看到问答表"。这 28 小时里打开数据目录只看得到 state.jsonl → 缺。
 *
 * 所以本轮补两件事，并且都做成可单测的纯函数（`netdisk/transfer-progress.js`）：
 *   ① 开工就说清楚"这是批量 / 为什么串行 / 这批最多只能出多少条有分享链接"；
 *   ② 上传专用表**增量落盘**（约每 25 条、≥15 秒节流一次），并把"还剩多久"滚动报出来。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const {
  formatDuration, measurePace, estimateRemaining, shareCeiling,
  progressLine, batchScaleNotice, shouldFlushQa,
  shouldAnnounceShareExhausted, shareExhaustedNotice,
  PROGRESS_EVERY, QA_FLUSH_EVERY, QA_FLUSH_MIN_GAP_MS, QA_FLUSH_MAX_GAP_MS,
} = require("../../electron/src/netdisk/transfer-progress");

const BATCH_TRANSFER = "electron/src/tasks/batch-transfer.js";
const MODULE = "electron/src/netdisk/transfer-progress.js";

/**
 * 剥注释（保字符串）。⚠️ 必须先剥行注释、再剥块注释 —— 被扫文件里若有
 * `// 脚本类工具（scripts/*.js）` 这种行注释含块注释起始符，先剥块注释会一路吃到
 * 下一个结束符，把中间几百行真实代码整段吞掉（本仓库踩过，见 round18 的同名工具）。
 */
function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

// ------------------------------------------------------ A 组：时长与节奏

test("A1 时长说人话：秒 → 分钟 → 小时（不能出现 ×1000 的单位错）", () => {
  assert.equal(formatDuration(47000), "47 秒");
  assert.equal(formatDuration(60 * 1000), "1 分钟");
  assert.equal(formatDuration(59.4 * 1000), "59 秒");
  assert.equal(formatDuration(3600 * 1000), "1 小时");
  assert.equal(formatDuration(3600 * 1000 + 12 * 60 * 1000), "1 小时 12 分钟");
  // 27.9 小时 → 不能再显示成"1676 分钟"（用户读不出这是通宵任务）
  assert.equal(formatDuration(27.9 * 3600 * 1000), "27 小时 54 分钟");
});

test("A2 算不出来就说算不出来，不许显示 0（0 的含义是「已经跑完」）", () => {
  assert.equal(formatDuration(NaN), "");
  assert.equal(formatDuration(-1), "");
  assert.equal(formatDuration(undefined), "");
});

test("A3 节奏用实测：还没成功过一条时返回 0（= 不知道），不猜常数", () => {
  assert.equal(measurePace({ done: 0, elapsedMs: 60000 }), 0);
  assert.equal(measurePace({ done: 10, elapsedMs: 0 }), 0);
  assert.equal(measurePace({ done: 10, elapsedMs: undefined }), 0);
  // 用户机器上的真实数字：226 条 / 2075 秒
  assert.equal(Math.round(measurePace({ done: 226, elapsedMs: 2075 * 1000 })), 9181);
});

test("A4 剩余时间 = (总数-已完成) × 实测节奏；已完成/未知节奏时返回 null", () => {
  const perItemMs = 9181;
  const est = estimateRemaining({ done: 226, total: 11164, perItemMs });
  assert.equal(est.perItemMs, 9181);
  assert.equal(est.remainingMs, (11164 - 226) * 9181);
  // 10938 × 9.181 秒 ≈ 27.9 小时 —— 这必须显示成"小时"，不是分钟/秒
  assert.match(est.remainingText, /^27 小时 \d+ 分钟$/);
  assert.match(est.totalText, /^28 小时/);
  assert.equal(estimateRemaining({ done: 11164, total: 11164, perItemMs }), null);
  assert.equal(estimateRemaining({ done: 0, total: 11164, perItemMs: 0 }), null);
});

test("A5 分享额度天花板 = 账号数 × 每日上限（11164 条里只有前 600 条有产出）", () => {
  assert.equal(shareCeiling({ accounts: 2, shareDailyLimit: 300 }), 600);
  assert.equal(shareCeiling({ accounts: 0, shareDailyLimit: 300 }), 0);
  assert.equal(shareCeiling({ accounts: 4, shareDailyLimit: 300 }), 1200);
  assert.equal(shareCeiling({}), 0);
});

test("A6 「额度全部用尽」只在那一刻喊一次，而且只认『全部账号都满了』", () => {
  assert.equal(shouldAnnounceShareExhausted({ blockedAccounts: 2, accounts: 2, announced: false }), true);
  assert.equal(shouldAnnounceShareExhausted({ blockedAccounts: 1, accounts: 2, announced: false }), false, "只满了一个号就喊，等于骗人");
  assert.equal(shouldAnnounceShareExhausted({ blockedAccounts: 2, accounts: 2, announced: true }), false, "喊过就不能再喊");
  assert.equal(shouldAnnounceShareExhausted({ blockedAccounts: 0, accounts: 0 }), false, "没有账号时不能成立");
  assert.equal(shouldAnnounceShareExhausted({}), false);
});

test("A7 「不再产出问答行」这句话必须同时给停止和不停两种选择（不许替用户做决定）", () => {
  const text = shareExhaustedNotice({ remaining: 10564, accounts: 2, shareDailyLimit: 300 });
  assert.match(text, /全部用尽/);
  assert.match(text, /剩余 10564 条/);
  assert.match(text, /不再产出任何问答行/);
  assert.match(text, /现在点「停止」不亏/);      // 选项一：止损
  assert.match(text, /让它跑完即可/);            // 选项二：我就是要存网盘
  assert.match(text, /台账不会丢/);
});

// ------------------------------------------------------ B 组：开工告知

test("B1 开工告知必须回答「是不是批量」「为什么串行」「能出多少条」", () => {
  const lines = batchScaleNotice({ total: 11164, accounts: 2, cc: 1, shareDailyLimit: 300, destRoot: "/来自资源批量转存" });
  const text = lines.join("\n");
  assert.match(text, /一次性排队的批量任务.*11164 条/);
  assert.match(text, /进度播报/);
  assert.match(text, /串行/);
  assert.match(text, /账号代理/);          // 必须给出"怎么变快"的出口
  assert.match(text, /只有前约 600 条能拿到分享链接/);
  assert.match(text, /其余 10564 条/);
  assert.match(text, /数量上限/);           // 必须给出可执行的止损动作
  assert.match(text, /\/来自资源批量转存/);
});

test("B2 配了互不相同的代理走并行时，告知改成说并行倍数而不是劝人配代理", () => {
  const lines = batchScaleNotice({ total: 500, accounts: 4, cc: 4, shareDailyLimit: 300 });
  const text = lines.join("\n");
  assert.match(text, /并行 4 条链/);
  assert.doesNotMatch(text, /当前\*\*串行\*\*/);
  // 500 条在 4×300=1200 额度内 → 不要说"白转"
  assert.match(text, /都在分享额度内/);
  assert.doesNotMatch(text, /建不了分享/);
});

test("B3 单账号（只有 1 个号）时不能把「串行」说成「你没配代理」", () => {
  const text = batchScaleNotice({ total: 100, accounts: 1, cc: 1, shareDailyLimit: 300 }).join("\n");
  assert.match(text, /只有 1 个可用账号，无法并行/);
  assert.doesNotMatch(text, /没有配/);
});

// ------------------------------------------------------ C 组：增量落表判据

test("C1 没有新增行就不写盘（否则等于每条都白写一次 4MB xlsx）", () => {
  assert.equal(shouldFlushQa({ done: 10, flushedRows: 10, lastFlushAt: 0, now: 10 * 60 * 1000 }), false);
  assert.equal(shouldFlushQa({ done: 5, flushedRows: 10, lastFlushAt: 0, now: 10 * 60 * 1000 }), false);
});

test("C2 攒够 every 条就写（连续跑的正常节奏）", () => {
  assert.equal(shouldFlushQa({ done: 25, flushedRows: 0, lastFlushAt: 0, now: QA_FLUSH_MIN_GAP_MS + 1 }), true);
  assert.equal(shouldFlushQa({ done: 24, flushedRows: 0, lastFlushAt: 0, now: QA_FLUSH_MIN_GAP_MS + 1 }), false);
});

test("C3 被限流暂停很久时，靠 maxGap 兜底刷新（不能让表一直冻在旧数字）", () => {
  // 只新增 2 条，但距离上次已经 5 分钟 → 必须刷新
  assert.equal(shouldFlushQa({ done: 2, flushedRows: 0, lastFlushAt: 0, now: QA_FLUSH_MAX_GAP_MS }), true);
  assert.equal(shouldFlushQa({ done: 2, flushedRows: 0, lastFlushAt: 0, now: QA_FLUSH_MAX_GAP_MS - 1 }), false);
});

test("C4 15 秒节流：一秒钟内新增 30 条也不能连写两次", () => {
  const now = 100000;
  const first = shouldFlushQa({ done: 30, flushedRows: 0, lastFlushAt: now - QA_FLUSH_MIN_GAP_MS - 1, now });
  assert.equal(first, true);
  const second = shouldFlushQa({ done: 60, flushedRows: 30, lastFlushAt: now, now: now + 3000 });
  assert.equal(second, false);
});

test("C5 节奏常量是有意的个数，不是随手写死的魔法数", () => {
  assert.equal(PROGRESS_EVERY, 25);
  assert.equal(QA_FLUSH_EVERY, 25);
  assert.ok(QA_FLUSH_MIN_GAP_MS >= 10000 && QA_FLUSH_MIN_GAP_MS <= 60000);
  assert.ok(QA_FLUSH_MAX_GAP_MS >= QA_FLUSH_MIN_GAP_MS);
});

// ------------------------------------------------------ D 组：进度行文案

test("D1 进度行带节奏与剩余时间；算不出剩余时不能显示 0", () => {
  const withEta = progressLine({ done: 300, total: 11164, perItemMs: 9181 });
  assert.match(withEta, /^📈 进度 300\/11164（9\.2 秒\/条，剩余约 27 小时 \d+ 分钟）$/);
  const noEta = progressLine({ done: 0, total: 11164, perItemMs: 0 });
  assert.equal(noEta, "📈 进度 0/11164");
});

// ------------------------------------------------------ E 组：接线（扫文本，只守"接上了没"）

test("E1 batch-transfer 真的用了这个模块（不是自己又抄一份文案）", () => {
  const src = read(BATCH_TRANSFER);
  assert.match(src, /require\("\.\.\/netdisk\/transfer-progress"\)/);
  const code = stripComments(src);
  assert.match(code, /progress\.batchScaleNotice\(/);
  assert.match(code, /progress\.shouldFlushQa\(/);
  assert.match(code, /progress\.progressLine\(/);
  assert.match(code, /progress\.measurePace\(/);
});

test("E2 「成功一条」这件事被绑到 countDone 上：4 个计数点全走它，且只留 1 个 done+=1", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.equal((code.match(/countDone\(\);/g) || []).length, 4,
    "有 4 条路径算成功（当日分享上限/乱码/名称不合规/正常），漏一条就少一次播报与落表");
  assert.equal((code.match(/done \+= 1;/g) || []).length, 1,
    "done += 1 只允许出现在 countDone 内部，否则进度与落表会漏");
  // 定义必须在那 4 次调用之前
  assert.ok(code.indexOf("function countDone()") < code.indexOf("countDone();"));
});

test("E3 增量落表用会抛的 writeWorkbook（不刷备份），最终一次才用 writeWorkbookSafe", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /flushQaTable\(/);
  assert.match(code, /excel\.writeWorkbook\(qaTablePath/);
  assert.match(code, /excel\.writeWorkbookSafe\(outputPath/);
  // 被占用时不能每 4 分钟生成一个备份文件 → 必须有禁用增量这条路径
  assert.match(code, /qaFlushDisabled = true/);
});

test("E4 上传专用表的路径只有一处定义（增量与最终写同一个文件，用户盯的那张就是成品）", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.equal((code.match(/const qaTablePath = /g) || []).length, 1);
  assert.equal((code.match(/path\.join\(outDir, `\$\{outName\}\.xlsx`\)/g) || []).length, 1);
  assert.match(code, /outputPath = qaTablePath;/);
});

test("E5 死绑定清理：本文件不再自己 require(\"xlsx\")（那个 XLSX 只被'建完就丢'的临时工作簿用到）", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.doesNotMatch(code, /require\("xlsx"\)/);
  assert.doesNotMatch(code, /\bXLSX\b/);
});

test("E6 旧的「本次要转存 N 条、每条都会建分享」文案已收敛进模块（不许两处各写一份）", () => {
  const transferOnly = stripComments(read(BATCH_TRANSFER));
  const moduleOnly = stripComments(read(MODULE));
  // 旧文案不许再留在任务文件里
  assert.equal((transferOnly.match(/每条都会建分享/g) || []).length, 0);
  assert.equal((transferOnly.match(/每日最多/g) || []).length, 0);
  // 新文案的家在模块里，而且必须说清"进不了上传专用表"这个后果
  assert.match(moduleOnly, /分享上限/);
  assert.match(moduleOnly, /不会进上传专用表/);
});

test("E7 「秒/条」这个口径只允许出现在 transfer-progress.js（防止别处再算一份 ETA）", () => {
  const dir = path.join(ROOT, "electron");
  const hits = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full).replace(/\\/g, "/");
      if (stripComments(fs.readFileSync(full, "utf8")).includes("秒/条")) hits.push(rel);
    }
  };
  walk(dir);
  // renderer 里不许有（它只显示，不算）—— 允许模块自己做格式化的那一处
  assert.deepEqual(hits, ["electron/src/netdisk/transfer-progress.js"]);
});

test("E8 「额度用尽」的那句话必须挂在 countDone 里（唯一漏斗），且不许在那里自己拼文案", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /progress\.shouldAnnounceShareExhausted\(/);
  assert.match(code, /progress\.shareExhaustedNotice\(/);
  // 判据与文案都在模块里：任务文件里不许出现"全部用尽"这种文案
  assert.equal((code.match(/全部用尽/g) || []).length, 0);
  // 只在喊过一次之后才置位，且必须放在 countDone 内部（否则新增成功路径会漏）
  assert.match(code, /shareExhaustedAnnounced = true;/);
  const body = code.slice(code.indexOf("function countDone()"), code.indexOf("shareExhaustedAnnounced = true;"));
  assert.ok(body.length > 0 && body.includes("shouldAnnounceShareExhausted"), "这段逻辑必须在 countDone 里");
  // 依此断言"不自动停"：这一刻不许出现 fatalStop
  assert.doesNotMatch(body, /fatalStop = true/);
});
