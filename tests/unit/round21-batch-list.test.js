"use strict";

/**
 * 第 21 轮：用户第二次澄清 ——
 *   「我说的批量是你提取好链接之后按照一行一个链接来进行排序然后就能实现批量转存了，
 *     你能明白吗，还是不明白去GitHub再找找开源」
 *
 * 按他说的去查了开源。结论分两半：
 *
 * ① **「一行一个链接」我们本来就支持**，而且**入口是坏的**（本轮修的两个真缺陷）：
 *    · `tasks/batch-transfer.js` 里早就有 `/\.txt$/i` 那一支（每行一条链接）；
 *      可是文件选择框的 filters 只列 xlsx/xls/csv → **用户在界面上根本选不到 txt**。
 *    · 查同类开源项目 `hakureiholo/BaiduPanFilesTransfers` 的 README，它列的标准输入里
 *      「链接 + 空格 + 四位码」和 `share/init?surl=…` 两种形态，我们**一种都不认**：
 *      前者提取码读成空 → 整行被 "缺链接或提取码" 跳过（用户明明把码写在上面了）；
 *      后者连链接都读不出来。→ 本轮在 `pan-link.js` 里补齐（**只补这两种，别的一律不猜**）。
 *
 * ② **「一行一个链接」不会让它变快**，这是同行的自述：
 *    那个工具的 README 明确写着「如果想加快转存速度，可多开程序，分批同时转存。
 *    **总转存速度不要超过每分钟 60 条链接**」——也就是 1 条/秒上下，想更快只能多开/换 IP。
 *    百度官方开放平台确实有个批量接口 `POST /apaas/1.0/share/transfer`，但它的 `fsid_list`
 *    是**同一个分享内的文件 id 列表**（单次 500/3000/50000 个文件），**不是多个分享链接**，
 *    而且「此接口为付费接口」+ 需要 OAuth 授权 —— 普通账号的 Cookie 用不了。
 *    所以"把 11164 个链接合成一个请求"在百度这套接口里**不存在**。
 *
 * 另外从那个工具的 FAQ 里翻到一条**与用户当前这批直接相关的经验**（本轮加进提醒）：
 *    「转存次数到达 1000 上限」—— 连续转存 1000 个链接后，再多 1 个都会报错、报错码千奇百怪，
 *    甚至网页端都无法再转存；原因是**百度基于 IP 地址层面的封锁**，解法是**换出口 IP**。
 *    用户的批已经跑到 900 上下，所以现在就该把这道坎告诉他（而不是等他撞上）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { parseLinkCell } = require("../../electron/src/netdisk/pan-link");
const { shouldWarnIpBurst, ipBurstNotice, batchScaleNotice, IP_BURST_WARN_AT } = require("../../electron/src/netdisk/transfer-progress");
const { mergePickExtensions, TABLE_EXTENSIONS, LINK_LIST_EXTENSIONS } = require("../../electron/src/storage/excel");

const PAN_LINK = "electron/src/netdisk/pan-link.js";
const BATCH_TRANSFER = "electron/src/tasks/batch-transfer.js";
const APP_CONTEXT = "electron/app-context.js";
const RENDERER = "electron/renderer/renderer.js";
const INDEX_HTML = "electron/renderer/index.html";

function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}
const LINK = "https://pan.baidu.com/s/1nvBwS25lENYceUu3OMH4tg";

// --------------------------------------------- J 组：一行一个链接的解析（真调函数）

test("J1 链接后「空格 + 四位码」必须认（同类开源工具的 README 就是这么写的）", () => {
  assert.equal(parseLinkCell(`${LINK} 6img`).pwd, "6img");
  assert.equal(parseLinkCell(`${LINK} AB12`).pwd, "AB12", "提取码不许改大小写");
  assert.equal(parseLinkCell(`三体全集 ${LINK} 6img 完结`).pwd, "6img", "码夹在文案中间也要认");
  assert.equal(parseLinkCell(`${LINK}\t6img`).pwd, "6img", "制表符也算分隔");
  // 老形态一个都不能退化
  assert.equal(parseLinkCell(`${LINK}?pwd=6img`).pwd, "6img");
  assert.equal(parseLinkCell(`${LINK} 提取码:6img`).pwd, "6img");
  assert.equal(parseLinkCell(`${LINK} 密码：6img`).pwd, "6img");
  assert.equal(parseLinkCell(LINK).pwd, "", "真的没有码时就得是空，别硬塞一个");
});

test("J2 `share/init?surl=` 形态要能还原成规范的 /s/1<code>", () => {
  const r = parseLinkCell("https://pan.baidu.com/share/init?surl=W7U9g47xiDez_5ItgNIs0w abcd");
  assert.equal(r.link, "https://pan.baidu.com/s/1W7U9g47xiDez_5ItgNIs0w");
  assert.equal(r.pwd, "abcd");
  // 还原规则与 processOne 的 surl 运算是互逆的（fullCode 恒为 "1"+surl）——
  // 这条断言查的是 protocol.js（真正做 surl 运算的地方），跨文件钉住两个规则的一致性
  assert.match(stripComments(read("electron/src/netdisk/protocol.js")),
    /const surl = fullCode\.startsWith\("1"\) \? fullCode\.slice\(1\) : fullCode;/);
});

test("J3 不许把别的四位串误当成提取码（宁可不认，也不能猜错）", () => {
  // 两个链接时，后面那个的 "http" 是字母数字串，绝不能被吃掉
  assert.equal(parseLinkCell(`${LINK.replace("1nv", "1AAA")} https://pan.baidu.com/s/1BBB`).pwd, "");
  assert.equal(parseLinkCell("https://pan.baidu.com/s/1AAA 12345").pwd, "", "五位串不许被截成四位");
  assert.equal(parseLinkCell("https://pan.baidu.com/s/1AAA 三体全集").pwd, "");
  assert.equal(parseLinkCell("https://pan.baidu.com/s/1AAA").pwd, "");
});

// --------------------------------------------- K 组：入口（txt 一行一个链接）

test("K1 资源表的选择框必须能选 txt —— 功能在、入口不能没有", () => {
  // ⚠️ 这里**真调函数**，不扫文本。
  // 教训（2026-10-14）：先前 K1 断言的是 `["xlsx", "xls", "csv", ...extra]` 这行源码；
  // 把它突变写成 `extensions: ["xlsx"]`，**测试照样全绿** —— 扫文本只看接线、看不出逻辑。
  // 规则提到 `storage/excel.js` 的纯函数后，突变就是直接改变返回值，必须当场红。
  assert.deepEqual(mergePickExtensions(), ["xlsx", "xls", "csv"], "不追加时 = 表格三种");
  assert.deepEqual(mergePickExtensions(["txt"]), ["xlsx", "xls", "csv", "txt"]);
  // 大小写 / 带点 / 空串 / 重复都要归一化，别把 ".TXT" 混进 filters（Windows 上会选不中）
  assert.deepEqual(mergePickExtensions([".TXT", "txt", "", null, ".csv"]), ["xlsx", "xls", "csv", "txt"]);
  // 非数组（老调用方没传）不能炸
  assert.deepEqual(mergePickExtensions(undefined), TABLE_EXTENSIONS);
  assert.deepEqual(LINK_LIST_EXTENSIONS, ["txt"]);

  const ac = stripComments(read(APP_CONTEXT));
  assert.match(ac, /payload\.extensions/, "选择框要支持调用方追加类型");
  assert.match(ac, /excel\.mergePickExtensions\(extraList\)/, "合并规则只有一个家：storage/excel.js");
  assert.doesNotMatch(ac, /\["xlsx", "xls", "csv", \.\.\./, "不许在 app-context 里再抄一份合并逻辑");
  assert.match(ac, /extensions: exts/);
  const rd = stripComments(read(RENDERER));
  assert.match(rd, /"path:pick-open-table", \{ title: .*extensions: \["txt"\] \}/,
    "「选择资源表格」那个按钮必须真的把 txt 传下去，否则用户在界面上还是选不到");
});

test("K2 txt 分支必须仍然是「一行一个链接」", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /if \(\/\\\.txt\$\/i\.test\(filePath\)\)/);
  assert.match(code, /split\(\/\\r\?\\n\/\)/);
  assert.match(code, /__name: `链接\$\{i \+ 1\}`/);
  // txt 的行也必须过同一个 parseLinkCell（别在 txt 分支里另写一套抠码规则）
  assert.match(code, /parseLinkCell/);
});

test("K3 界面要把「txt 一行一个链接」和「为什么快不了」一起说清", () => {
  const html = read(INDEX_HTML);
  assert.match(html, /一行一个链接/);
  assert.match(html, /每行「链接 提取码」/);
  // 同类开源工具的原始口径要摆出来 —— 这是"不是我一家慢"的凭据
  assert.match(html, /总转存速度不要超过每分钟 60 条链接/);
  assert.match(html, /BaiduPanFilesTransfers/);
  assert.doesNotMatch(html, /\*\*/, "index.html 不渲染 markdown");
});

// --------------------------------------------- L 组：「1000 条 IP 坎」的提醒

test("L1 提醒判据是真函数：到阈值才喊，喊过就不再喊", () => {
  assert.equal(IP_BURST_WARN_AT, 900);
  assert.equal(shouldWarnIpBurst({ done: 899 }), false);
  assert.equal(shouldWarnIpBurst({ done: 900 }), true);
  assert.equal(shouldWarnIpBurst({ done: 5000 }), true);
  assert.equal(shouldWarnIpBurst({ done: 5000, announced: true }), false, "喊过就不能再喊");
  assert.equal(shouldWarnIpBurst({}), false);
  assert.equal(shouldWarnIpBurst({ done: NaN }), false);
});

test("L2 提醒要说出处、症状、动作，并点破「换账号 ≠ 换 IP」", () => {
  const same = ipBurstNotice({ done: 900, cc: 1, accounts: 2 });
  assert.match(same, /BaiduPanFilesTransfers/);          // 出处
  assert.match(same, /大约 1000 条/);                    // 症状
  assert.match(same, /换一个出口 IP/);
  assert.match(same, /账号代理/);
  assert.match(same, /不会自己停/);                      // 不替用户决定
  assert.match(same, /换账号没用/);                      // 同一个出口时最关键的提醒
  // 并行（cc>1）时不该再说"换账号没用"——那时每条链本来就有自己的出口
  const par = ipBurstNotice({ done: 900, cc: 3, accounts: 3 });
  assert.doesNotMatch(par, /换账号没用/);
  assert.doesNotMatch(par, /账号代理/);
});

test("L3 大批量的开工告知里就要有这条坎（等跑到 900 条才说，前面几百条已经白跑了）", () => {
  const big = batchScaleNotice({ total: 11164, accounts: 2, cc: 1, shareDailyLimit: 300 }).join("\n");
  assert.match(big, /大约 1000 条/);
  const small = batchScaleNotice({ total: 100, accounts: 1, cc: 1, shareDailyLimit: 300 }).join("\n");
  assert.doesNotMatch(small, /大约 1000 条/, "小批量提这个只会让人困惑");
});

test("L4 任务里的接线：挂在 countDone（唯一漏斗）且只置一次位", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /let ipBurstAnnounced = false;/);
  assert.match(code, /progress\.shouldWarnIpBurst\(\{ done, announced: ipBurstAnnounced \}\)/);
  assert.match(code, /ipBurstAnnounced = true;/);
  const done = code.slice(code.indexOf("function countDone()"));
  const body = done.slice(0, done.indexOf("ipBurstAnnounced = true;"));
  assert.ok(body.includes("shouldWarnIpBurst"), "这段必须落在 countDone 里，否则新增成功路径会漏");
  // 依此断言"不自动停"
  assert.doesNotMatch(body, /fatalStop = true/);
});

// --------------------------------------------- M 组：跳过的那两类必须留痕+汇总

test("M1 两类跳过要分开计数（动作不同：一个是表选错了，一个是要补提取码）", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /let skippedNoLink = 0, skippedNoPwd = 0;/);
  assert.match(code, /if \(link\) skippedNoPwd \+= 1; else skippedNoLink \+= 1;/);
  // 单行文案要给出正确写法，不能只说"缺链接或提取码"
  assert.match(code, /只有链接、没有提取码/);
  assert.match(code, /链接 提取码:abcd/);
});

test("M2 收尾必须汇总（一万行的表里，单行日志等于没有）", () => {
  const code = stripComments(read(BATCH_TRANSFER));
  assert.match(code, /if \(skippedNoLink \|\| skippedNoPwd\) \{/);
  assert.match(code, /被跳过 —— 都没计入失败/);
  // 免密分享的现状要诚实说明（不许假装支持）
  assert.match(code, /免密分享.*目前也会落进第二类|没提取码的\*\*免密分享\*\*目前也会落进第二类/);
});

// --------------------------------------------- N 组：验突变的那把尺子本身

const MUTATION_SCRIPT = "scripts/mutation-check.js";

test("N1 突变脚本必须用 shell 重定向拿输出，不许在进程里 spawnSync 抓 stdout", () => {
  // 为什么单独立一条（2026-10-14 血的教训）：本项目的核心纪律是"守卫必须用注入突变验"，
  // 而这个脚本就是那把尺子。可它最初若写成 `spawnSync(node, ["--test"]).stdout`，
  // **沙箱禁止带管道的子进程** → stdout 恒为空 → 每次都说"红了 0 项" → 得出
  // "守卫不敏感"的**反向结论**（本轮真的发生了一次）。尺子坏了，后面所有结论都是假的。
  const src = stripComments(fs.readFileSync(path.join(ROOT, MUTATION_SCRIPT), "utf8"));
  assert.match(src, /2>&1/, "必须把子进程输出重定向到文件再读");
  assert.match(src, /execFileSync/);
  assert.doesNotMatch(src, /spawnSync/, "spawnSync 抓 stdout 在本沙箱里恒为空");
  // 退出码 1（有用例红）是我们要的结果，必须被吞掉而不是让脚本自己崩
  assert.match(src, /catch \(_e\)/, "node --test 失败时退出码非 0，要吞掉");
  // 还原必须核对字节，否则"验完"反而把仓库改坏了
  assert.match(src, /back !== original/);
});

test("N2 突变脚本拒绝含糊的替换（找不到 / 命中多处都当场退出）", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, MUTATION_SCRIPT), "utf8"));
  // 盲目的全局 split/join 会顺带改掉兄弟字符串 —— 必须要求"恰好命中一次"
  assert.match(src, /const hits = mutated\.split\(from\)\.length - 1;/);
  assert.match(src, /hits === 0/);
  assert.match(src, /hits > 1/);
});
