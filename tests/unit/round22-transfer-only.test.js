"use strict";

/**
 * 第 22 轮：用户贴了一张同类工具（PanLay 盘友助手的网盘拉新提效工具）的界面图，
 * 问「你真的理解了转存吗，我用的别人的为什么转存那么快，参考这个图片的步骤我们也做这种」。
 *
 * 那张图的六个步骤是：①保存到网盘 ②下载到本地 ③文件去重 ④清理广告 ⑤插入引流信息 ⑥上传到网盘。
 * 逐条对照之后的结论（都写进 CHANGELOG 了）：
 *   · ① 我们有；
 *   · ②~⑥ 我们**一步都没有**，而且用户自己机器上那份四家参考实现（baidu/quark/uc/xunlei）也都没有
 *     —— 它们的接口只到 `transfer / create_share / list_dir / fetch_text_preview`，没有下载、没有上传。
 *     所以"参考这个图片做这种"不是提速，是**补整整半条流水线**。
 *   · 它"快"的原因图里自己写着：第①步的「延迟 3 ~ 6 秒」，以及它**到第①步就结束了**。
 *     我们每条还要多做一个「建分享」（问答表里要放链接）。
 *
 * 本轮真正动手做的是最后那一句的落地：**「只转存、不建分享」这个开关后端早就支持，
 * 但渲染端从来没把它发出去**（界面没有任何入口）—— 又一起"功能在、入口没有"。
 * 而且那条老路径是**坏的**：`runShareStep` 在 `!makeShare` 时返回 `{ownLink:"", shareFailed:false}`，
 * 流程会带着一个**空链接**继续生成问答行，用户会拿到一张没有链接的表。
 * 因为从没有人走到过那里，所以这个 bug 一直藏着。
 *
 * 关键设计：只转存的条目记成 `share_failed`（带 `toPaths`），
 * 这样下一轮 `planShareRetry` 直接判 `share-only` —— **只补分享、一步转存接口都不碰**。
 * 这条不变式由 R1 直接验证（跨模块调用，不是扫文本）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const shareRetry = require("../../electron/src/netdisk/share-retry");
const { buildTransferOnlyEntry, planShareRetry } = shareRetry;

const BATCH_TRANSFER = "electron/src/tasks/batch-transfer.js";
const SHARE_RETRY = "electron/src/netdisk/share-retry.js";
const RENDERER = "electron/renderer/renderer.js";
const INDEX_HTML = "electron/renderer/index.html";

function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const TOPATHS = ["/来自资源批量转存/测试组1/某资源/文件A.iso"];

// --------------------------------------------- R 组：只转存模式的台账与"下轮自动补分享"

test("R1 只转存的条目必须能被下一轮判成 share-only（只补分享、不重传）", () => {
  // 这是整个模式的**关键承诺**：用户先只转存把资源全部搬完，之后再跑一次就能拿到链接，
  // 而且那一次不该把 11164 个文件重新转存一遍（那意味着再多一倍写请求、多撞一倍风控窗口）。
  // 所以这里跨模块真调：buildTransferOnlyEntry 造一条 → planShareRetry 判动作。
  const entry = buildTransferOnlyEntry({
    srcLink: "https://pan.baidu.com/s/1abc?pwd=wpxg",
    name: "求某资源百度网盘下载",
    toPaths: TOPATHS,
    at: "2026-10-14T14:00:00.000Z",
  });
  const plan = planShareRetry(entry);
  assert.equal(plan.action, "share-only", "下一轮必须只补分享");
  assert.deepEqual(plan.toPaths, TOPATHS, "落盘路径必须原样带过去，否则补分享时不知道分享哪个目录");
  assert.equal(entry.status, "share_failed");
  assert.equal(entry.ownLink, "", "这一条确实没有链接");
  assert.equal(entry.phase, "done", "资源是确实落盘了的，不能算半成品");
  assert.match(entry.error, /只转存/, "原因要能一眼看出是用户主动选的模式，不是百度拒的");
});

test("R2 只转存不许被误判成「转存失败」（那是两件不同的事）", () => {
  // 转存失败（status:"failed"）→ 必须重传；只转存（share_failed + toPaths）→ 只补分享。
  // 两者混在一起会让下一轮把已经落盘的资源全部重转一遍。
  assert.equal(planShareRetry({ status: "failed", toPaths: TOPATHS }).action, "transfer");
  assert.equal(planShareRetry({ status: "done", toPaths: TOPATHS }).action, "transfer",
    "done 且有链接的行本来就不该进这里；这条只是守卫别把语义搞反");
  // 没有落盘路径时只能重传（不能凭空补分享）
  assert.equal(planShareRetry({ status: "share_failed", toPaths: [] }).action, "transfer");
});

test("R3 只转存不许污染 attempts（那是「失败 N 次进黑名单」的计数器）", () => {
  const entry = buildTransferOnlyEntry({ srcLink: "s", name: "n", toPaths: TOPATHS });
  assert.equal(entry.shareAttempts, 0, "补分享次数从 0 开始");
  assert.ok(!("attempts" in entry), "绝不许写 attempts —— 它一涨，明明已落盘的资源会被拉黑");
  // 被百度永久禁止二次分享的那一条，只转存模式也不该反复试
  assert.equal(planShareRetry({ ...entry, shareForbidden: true }).action, "skip");
});

// --------------------------------------------- S 组：入口与接线（这次修的就是"入口没有"）

test("S1 渲染端必须把 makeShare / delayMin / delayMax 真的发出去", () => {
  // 这三个后端一直都支持（`payload.makeShare !== false`、`payload.delayMin/delayMax`），
  // 但渲染端的 payload 里**一个都没有** → 界面上没有任何入口能改它们。
  // 这就是本轮修的东西：不是加功能，是把已有的功能的入口接上。
  const rd = stripComments(read(RENDERER));
  assert.match(rd, /makeShare: \$\("batchMakeShare"\)\.checked/, "勾选状态必须传给后端");
  assert.match(rd, /delayMin: Math\.max\(0\.5, Number\(\$\("batchDelayMin"\)\.value\) \|\| 1\)/);
  assert.match(rd, /delayMax: Math\.max\(0\.5, Number\(\$\("batchDelayMax"\)\.value\) \|\| 2\)/);
  // 启动日志也要说明本批是不是只转存（否则用户跑完才发现没有链接）
  assert.match(rd, /只转存不建分享/);
});

test("S2 界面上要有这三个控件（否则 renderer 取到 null 会当场抛）", () => {
  const html = read(INDEX_HTML);
  assert.match(html, /id="batchMakeShare"/, "要有「建分享链接」勾选框");
  assert.match(html, /id="batchDelayMin"/);
  assert.match(html, /id="batchDelayMax"/);
  // 默认值必须与后端一致：建分享=勾上、间隔 1~2 秒
  assert.match(html, /id="batchMakeShare" checked/);
  assert.match(html, /id="batchDelayMin" min="0\.5"[^>]*value="1"/);
  assert.match(html, /id="batchDelayMax" min="0\.5"[^>]*value="2"/);
  // 文案要说清代价与补救（不许只给一个开关不给后果）
  assert.match(html, /只补分享、不(重新转存|重传)/);
  assert.doesNotMatch(html, /\*\*/, "index.html 不渲染 markdown");
});

test("S3 后端：只转存必须**跳过问答行生成**，不能带着空链接往下走", () => {
  // 这是本轮修掉的**真 bug**：老路径 `if (!makeShare) return out` 之后，
  // 流程会继续生成问答行 → 用户拿到一张没有链接的表。
  const code = stripComments(read(BATCH_TRANSFER));
  // ⚠️ 定位必须用**只在每条分支里出现一次**的锚点。
  // 第一版用 `code.indexOf("if (!makeShare) {")` —— 它先匹配到第 372 行的**开工告知**分支，
  // 于是切片一路扫到第 650 行，圈进了几十个无关的 `continue;`，
  // 结果"把真正的 continue 删掉"这个突变**测试全绿**（守卫自己扫错了地方，突变替我抓出来的）。
  const at = code.indexOf("shareRetry.buildTransferOnlyEntry(");
  assert.ok(at > 0, "只转存分支必须调用 share-retry.js 那个纯函数");
  const end = code.indexOf("const share = await runShareStep", at);
  assert.ok(end > at, "runShareStep 必须在那之后");
  const body = code.slice(at, end);
  assert.match(body, /shareRetry\.buildTransferOnlyEntry\(/, "台账条目只能用 share-retry.js 那一个纯函数");
  // continue 必须落在"造完台账条目"与"建分享"之间 —— 漏了就会带着空链接去生成问答行
  assert.match(body, /continue;/, "必须 continue，否则流程会带着空链接继续生成问答行");
  assert.match(body, /transferredNoShare \+= 1;/, "要计数，否则收尾汇总不知道有多少条没链接");
  assert.match(body, /countDone\(\);/, "只转存也是「成功一条」，必须走同一个漏斗（进度/落表/ETA）");
  // 收尾汇总必须分模式说话：主动选的模式和百度拒的模式不是一回事
  const tail = code.slice(code.indexOf("=== 批量转存完成 ==="));
  assert.match(tail, /if \(!makeShare\) \{/);
  assert.match(tail, /本批是「只转存」模式/);
});

test("S4 开工日志要交代模式与间隔（用户得知道这批为什么不产出链接）", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /每条间隔 \$\{delayMin\}~\$\{delayMax\}s \| \$\{makeShare \? "建分享" : "只转存不建分享"\}/);
  assert.match(code, /if \(!makeShare\) \{[\s\S]*?只补分享、不重新转存/);
  // 压到下限要提醒（这不是纯赚：更容易撞降级窗口）
  assert.match(code, /if \(delayMax <= 0\.5\) \{/);
  assert.match(code, /更容易触发降级窗口/);
});
