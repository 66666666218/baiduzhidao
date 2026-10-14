"use strict";

/**
 * 第 20 轮：**"我们需要快速的转存"**（用户 2026-10-14 第二轮反馈）。
 *
 * 这一轮做的是两件与"快"直接相关的事，而且都留了可复核的证据：
 *
 * ① **少打请求**：`/share/transfer` 的 `fsidlist` 里放**文件夹**的 fs_id，百度会在服务端
 *    递归复制整个文件夹。依据是**用户自己机器上那份参考实现**（`C:\Users\周万鹏\wangpan`
 *    的 `backend/app/providers/baidu/provider.py`）：`fs_ids = [int(f["fs_id"]) for f in files]`
 *    **没有任何 isdir 过滤**，而且那个文件**从头到尾没调过 /share/list**。
 *    我们原来为了收集"文件的 fs_id"要把整棵目录树 BFS 展开（每个目录一次 /share/list）。
 *    → 新增"快路径"，并加三道保险：**根目录里真的有文件夹才启用**（没文件夹的分享本来就
 *      不打 /share/list，省不到就不许改行为）、**分享页 file_list 取满一页就退回慢路径**
 *      （防截断）、**被百度拒绝时自动退回完整枚举再试一次**。
 *
 * ② **让程序自己量每一步**：用户问"为什么一条 9 秒"，而我手上只有"9.18 秒/条"这个**总量**。
 *    测速探针量不到写请求（一碰就污染用户网盘），挑的链接形状和真跑批的还可能不是一回事
 *    （实测表尾是"单文件分享"、表头是"文件夹分享"）。所以改成由**真实跑批**把
 *    verify / 分享页 / 列目录 / 建目录 / 转存 五段的耗时带回来，每 25 条报一次平均值与占比。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const {
  emptyPhases, addPhases, phaseLine, PHASE_LABELS,
} = require("../../electron/src/netdisk/transfer-progress");
const { phaseMarks, phaseDurations, planFastPath, FILE_LIST_PAGE_CAP } = require("../../electron/src/netdisk/protocol");

const PROTOCOL = "electron/src/netdisk/protocol.js";
const BATCH_TRANSFER = "electron/src/tasks/batch-transfer.js";
const PROBE = "scripts/probe-transfer-speed.js";

/** 剥注释（保字符串）。⚠️ 必须先剥行注释、再剥块注释（见 round19 同名工具的注释）。 */
function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

// ------------------------------------------------- G 组：分段耗时的"量"与"报"

test("G1 分段计时能把五段折出来，缺的标记回退到上一个（不许算出 NaN）", () => {
  const t = phaseMarks();
  t.start = 1000;
  t.afterVerify = 1200;   // verify 200
  t.afterPage = 2000;     // page   800
  // afterList / afterCreate / afterTransfer 故意不设（= 这条链没走到那一步，例如 dryRun）
  const d = phaseDurations(t);
  assert.equal(d.verify, 200);
  assert.equal(d.page, 800);
  assert.equal(d.list, 0);
  assert.equal(d.create, 0);
  assert.equal(d.transfer, 0);
  for (const v of Object.values(d)) assert.ok(Number.isFinite(v), "分段耗时不许出现 NaN");
});

test("G2 累加器忽略 NaN/负数，且能接受缺失的 acc（不许让一条坏数据污染整批统计）", () => {
  const a = addPhases(emptyPhases(), { verify: 100, page: NaN, list: -5, create: 50, transfer: 400 });
  assert.equal(a.verify.ms, 100);
  assert.equal(a.page.n, 0);
  assert.equal(a.list.n, 0);
  assert.equal(a.create.ms, 50);
  assert.equal(a.transfer.ms, 400);
  const b = addPhases(undefined, { verify: 10 });
  assert.equal(b.verify.ms, 10);
  assert.equal(addPhases(emptyPhases(), null).verify.n, 0, "timings 缺失时不能抛");
});

test("G3 报出来的那一行：样本为 0 时返回空串，且不列『一次都没走到』的步骤", () => {
  assert.equal(phaseLine(emptyPhases()), "", "样本 0 = 不知道，不许显示 0");
  assert.equal(phaseLine(undefined), "");
  const acc = addPhases(emptyPhases(), { verify: 200, page: 800, list: 0, create: 0, transfer: 3000 });
  const line = phaseLine(acc);
  assert.match(line, /每步平均耗时/);
  assert.match(line, /合计 4\.00s\/条/);
  assert.match(line, /① 解析分享页 verify 0\.20s\(5%\)/);
  assert.match(line, /⑤ 转存 \/share\/transfer 3\.00s\(75%\)/);
  assert.doesNotMatch(line, /③ 列分享内文件/, "累计 0ms 的步骤不该出现（会让人以为它免费）");
  assert.doesNotMatch(line, /NaN/);
});

test("G4 阶段名只有一份（protocol 量、transfer-progress 累加，两边用同一组键）", () => {
  const src = stripComments(read(PROTOCOL));
  for (const [k] of PHASE_LABELS) {
    assert.ok(new RegExp(`\\b${k}\\b`).test(src), `protocol 里找不到阶段键 ${k}`);
  }
  assert.match(src, /phaseDurations/);
});

// ------------------------------------------------- H 组：快路径（少打请求）

test("H1 快路径判据**真调函数**（不是扫文本）：三条闸门缺一条都不许启用", () => {
  const file = { fs_id: 11, isdir: 0, size: 100, path: "/a.mp4" };
  const dir = { fs_id: 22, isdir: 1, size: 0, path: "/合集" };

  // ✅ 根里有文件夹、取不满一页 → 启用，而且**文件夹的 fs_id 要一起交出去**
  //   （这正是省时间的全部意义：/share/transfer 收到文件夹会在服务端递归复制）
  const yes = planFastPath({ entries: [dir], dryRun: true });
  assert.equal(yes.enabled, true);
  assert.equal(yes.hasDirAtRoot, true);
  assert.deepEqual(yes.ids, [22]);
  assert.deepEqual(yes.paths, ["/合集"]);

  // 闸门②：根里**只有文件** → 不启用。
  // 实测表尾那批小说/电子书分享就是这种形状（根 1 条且是文件），老路径本来就一次
  // /share/list 都不打 —— 省不到的场合不许有任何行为变化。
  const onlyFiles = planFastPath({ entries: [file], dryRun: true });
  assert.equal(onlyFiles.enabled, false);
  assert.equal(onlyFiles.hasDirAtRoot, false);
  assert.deepEqual(onlyFiles.ids, []);

  // 闸门①：取满一页 = 可能被截断 → 不启用；差一条就取不满
  const full = planFastPath({ entries: Array.from({ length: FILE_LIST_PAGE_CAP }, () => ({ ...dir })), dryRun: true });
  assert.equal(full.complete, false);
  assert.equal(full.enabled, false);
  const justUnder = planFastPath({ entries: Array.from({ length: FILE_LIST_PAGE_CAP - 1 }, () => ({ ...dir })), dryRun: true });
  assert.equal(justUnder.complete, true);
  assert.equal(justUnder.enabled, true);

  // 闸门③：测速探针的强制慢路径
  assert.equal(planFastPath({ entries: [dir], dryRun: "slow" }).enabled, false);
  // 空根 / 条目没有 fs_id / 只有占位垃圾 → 都不许启用
  assert.equal(planFastPath({ entries: [], dryRun: true }).enabled, false);
  assert.equal(planFastPath({ entries: [{ isdir: 1, path: "/x" }], dryRun: true }).enabled, false);
  assert.equal(planFastPath({ entries: [{ isdir: 0, fs_id: 9, size: 0, path: "/占位" }], dryRun: true }).enabled, false);
  // ⚠️ 文件夹的 size 也是 0，**绝不能**被当成占位垃圾丢掉（丢掉 = 少转存一整棵目录树）
  assert.deepEqual(planFastPath({ entries: [{ fs_id: 7, isdir: 1, size: 0, path: "/夹" }], dryRun: true }).ids, [7]);
  // 生产路径（不传 dryRun）与探针（dryRun=true）判据必须一致 —— 探针量到的就是生产会做的
  assert.equal(planFastPath({ entries: [dir] }).enabled, yes.enabled);
});

test("H1b 判据只许有一份：processOne 里不许再自己拼一遍条件", () => {
  const src = stripComments(read(PROTOCOL));
  assert.match(src, /const fast = planFastPath\(\{ entries: rawList, dryRun \}\);/);
  assert.match(src, /if \(fast\.enabled\) \{/);
  // 3 处 = 声明 + 参与 allowed 判定 + 返回对象（注释里的那些不算，stripComments 已经剥掉）
  assert.equal((src.match(/hasDirAtRoot/g) || []).length, 3, "闸门只该在 planFastPath 里（声明 + 判定 + 返回）");
});

test("H2 快路径被百度拒了必须自动退回完整枚举再试一次（改快了却开始失败 = 更糟）", () => {
  const src = stripComments(read(PROTOCOL));
  // 回退条件里必须把四种「其实不是拒绝」的形态排除掉
  assert.match(src, /if \(usedFastPath && !outcome\.dup && !outcome\.pending && !outcome\.capacityFull/);
  assert.match(src, /outcome\.errno !== 0 && !outcome\.infoSucceeded\) \{/);
  // 回退动作：重新完整枚举 + 再转一次
  assert.match(src, /await fullCollect\(\);/);
  assert.match(src, /usedFastPath = false;/);
  // 只回退一次：回退块内不许再出现一次 `usedFastPath = true`
  const body = src.slice(src.indexOf("if (usedFastPath &&"), src.indexOf("tMark.afterTransfer"));
  assert.ok(body.length > 0, "找不到回退块");
  assert.equal((body.match(/usedFastPath = true/g) || []).length, 0, "回退块里不许再把快路径打开（会来回横跳）");
  assert.equal((body.match(/fullCollect\(\)/g) || []).length, 1);
});

test("H3 慢路径被完整保留（快路径只是抄近道，不是把老逻辑删掉）", () => {
  const src = stripComments(read(PROTOCOL));
  assert.match(src, /const fullCollect = async \(\) => \{/);
  assert.match(src, /await walkDirs\(dirPaths\)/);
  assert.match(src, /const rootListAll = async \(\) => \{/);
  // 两个调用点：一开始的兜底 + 被拒后的回退
  assert.equal((src.match(/fullCollect\(\)/g) || []).length, 2);
});

test("H4 每一个成功出口都要带分段耗时（漏一个，统计就永远少一段）", () => {
  const src = stripComments(read(PROTOCOL));
  // dryRun / dup / pending / 正常 —— 四个 return 都要有 timings
  assert.equal((src.match(/timings: phaseDurations\(tMark\)/g) || []).length, 4,
    "有 4 条出口（dryRun / 已转存 / 异步中 / 成功），漏一条就少一份计时");
  // 五段标记必须真的被赋值，否则折出来永远是 0
  for (const mark of ["afterVerify", "afterPage", "afterList", "afterCreate", "afterTransfer"]) {
    assert.equal((src.match(new RegExp(`tMark\\.${mark} = Date\\.now\\(\\)`, "g")) || []).length, 1,
      `${mark} 必须被赋值且只有一处`);
  }
});

test("H5 探针必须能自证『没漏文件』——覆盖判据不许被删掉", () => {
  const src = stripComments(read(PROBE));
  assert.match(src, /--compare/);
  // 覆盖判据：慢路径枚举出的每个文件路径都要落在快路径某个根条目之下
  assert.match(src, /const missing = slowPaths\.filter/);
  assert.match(src, /coverageFail/);
  // ⚠️ 顺序必须交替：第一版是"永远先跑快路径"，量出来的是"顺序"不是"差别"
  assert.match(src, /const fastFirst = i % 2 === 0;/);
  // 不许再被正在跑批的任务抢同一批链接：--tail / --any 是为此加的
  assert.match(src, /has\("tail"\)/);
  assert.match(src, /anyRow && !dryRun/);
});

// ------------------------------------------------- I 组：接线

test("I1 真实跑批每 25 条报一次『时间花在哪一步』，收尾再报一次", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /let phaseAcc = progress\.emptyPhases\(\);/);
  assert.match(code, /phaseAcc = progress\.addPhases\(phaseAcc, oneResult && oneResult\.timings\)/);
  // 播报必须挂在 countDone 的 25 条节拍上（和进度行同一处，不许另开一个节拍器）
  const done = code.slice(code.indexOf("function countDone()"));
  const body = done.slice(0, done.indexOf("shareExhaustedAnnounced = true;"));
  assert.match(body, /progress\.phaseLine\(phaseAcc\)/);
  // 收尾那次（整批结束时）
  assert.ok((code.match(/progress\.phaseLine\(phaseAcc\)/g) || []).length >= 2,
    "至少两处：每 25 条一次 + 整批结束一次");
});
