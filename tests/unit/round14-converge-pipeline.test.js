"use strict";

/**
 * 第 14 轮：把「网盘管线」里**已经漂移**的三组共用零件收敛到单一实现。
 *
 * 为什么值得单独一轮：这三组都不是"简单的复制粘贴"，而是**行为不一致**的拷贝 ——
 * 也就是本仓库被坑过很多次的那种（`parseLinkCell` 四份拷贝，其中一份把提取码列永远读成空串，
 * 整表静默跳过、输出"成功 0 失败 0"）。本轮的实测结论：
 *
 *   ① **列识别**（哪一列是名称/链接/提取码）：**四处、三种算法** ——
 *      `tasks/batch-transfer.js` / `pan-transfer-batch.js` / `pan-transfer-ui.js` 只按**表头关键字**认，
 *      `pan-transfer-pipeline.js` 还会按**单元格内容**嗅探。同一个表格换脚本跑，可能解析出不同的列。
 *      → 收敛到 `netdisk/table-columns.js` 的 `detectColumns`，以最成熟那份为基准。
 *      顺带修掉一个真错：表头里有「资源链接」这种**同时命中名称与链接关键字**的列时，
 *      旧逻辑会把**这串 URL 当成资源名**（出题标题直接变成链接）。现在名称列绝不会等于链接列，
 *      并且真的没有名称列时返回 `nameDegraded` 让调用方**报警告**（不静默挑错列）。
 *
 *   ② **台账读写**（state.jsonl）：**五份**。它们唯一有意义的差异是**去重键**——
 *      转存类按 `srcLink`，`netdisk-share-existing.js` 按 `srcPath`（它不转存，是对网盘已有路径建分享）。
 *      这点差异很容易被后来的人"顺手统一"掉，从而**静默改变断点续跑语义**。
 *      → 收敛到 `netdisk/state-ledger.js`，把键做成**显式参数**。
 *
 *   ③ **4 位随机提取码**：三份，内容相同只是变量名不同。→ 收敛到 `netdisk/share.js` 的 `randomPwd`。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const { detectColumns } = require("../../electron/src/netdisk/table-columns");
const { loadLedger, appendLedger } = require("../../electron/src/netdisk/state-ledger");
const { randomPwd } = require("../../electron/src/netdisk/share");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "mock-site", "site", "docs", ".github", "运行缓存"]);
function walkJs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.name.endsWith(".js")) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}
const ALL_JS = walkJs(root, []);
const PROD_JS = ALL_JS.filter((f) => f.startsWith("electron/") || f.startsWith("scripts/"));

const FOUR_SITES = [
  "electron/src/tasks/batch-transfer.js",
  "scripts/pan-transfer-batch.js",
  "scripts/pan-transfer-ui.js",
  "scripts/pan-transfer-pipeline.js",
];

/** 已收敛到 readTableRows / readFirstSheet 的读表调用点 */
const READ_SITES = [
  "electron/src/tasks/batch-transfer.js",
  "electron/src/tasks/upload-batch.js",
  "scripts/mass-qa-template.js",
  "scripts/pan-to-qa.js",
  "scripts/pan-transfer-batch.js",
  "scripts/pan-transfer-pipeline.js",
  "scripts/pan-transfer-ui.js",
  "scripts/workbench-upload-per-account.js",
  "scripts/workbench-upload.js",
];

/** 允许自己 XLSX.readFile 的例外：它要把结果写回**同一个** workbook（见 E6） */
const READ_EXCEPTION = "scripts/workbench-generate.js";

// ─────────── A. detectColumns 的行为 ───────────

test("A1：标准表头（文件名/链接/提取码）", () => {
  const c = detectColumns([{ 文件名: "a.zip", 链接: "https://pan.baidu.com/s/1abc", 提取码: "8k2n" }]);
  assert.equal(c.nameKey, "文件名");
  assert.equal(c.linkKey, "链接");
  assert.equal(c.pwdKey, "提取码");
  assert.equal(c.nameDegraded, false);
});

test("A2：别名表头（标题/网盘链接/密码）也能认", () => {
  const c = detectColumns([{ 标题: "x", 网盘链接: "https://pan.baidu.com/s/1abc", 密码: "8k2n" }]);
  assert.equal(c.nameKey, "标题");
  assert.equal(c.linkKey, "网盘链接");
  assert.equal(c.pwdKey, "密码");
});

test("A3：表头没写清楚时，按**内容**嗅探（这是 pipeline 那份强于另外三份的地方）", () => {
  const c = detectColumns([{ 备注: "x", 链接: "https://pan.baidu.com/s/1abc", 列3: "8k2n" }]);
  assert.equal(c.linkKey, "链接");
  assert.equal(c.pwdKey, "列3", "4 位字母数字的列应被认成提取码");
  assert.equal(c.nameKey, "备注");
});

test("A4：真错修复 —— 表头「资源链接」同时命中名称与链接关键字时，不能再把 URL 当资源名", () => {
  const c = detectColumns([{ 资源链接: "https://pan.baidu.com/s/1abc", 备注: "x" }]);
  assert.equal(c.linkKey, "资源链接");
  assert.notEqual(c.nameKey, c.linkKey, "名称列绝不能等于链接列");
  assert.equal(c.nameKey, "备注");
});

test("A5：没有名称列时返回 nameDegraded=true（让调用方报警告，而不是静默挑个错列）", () => {
  const c = detectColumns([{ 链接: "https://pan.baidu.com/s/1abc", 提取码: "8k2n" }]);
  assert.equal(c.nameDegraded, true);
  const ok = detectColumns([{ 名称: "a", 链接: "https://pan.baidu.com/s/1abc" }]);
  assert.equal(ok.nameDegraded, false);
});

test("A6：txt 模式（对象只有 __name/__link）也能正确识别", () => {
  const c = detectColumns([{ __name: "链接1", __link: "https://pan.baidu.com/s/1abc" }]);
  assert.equal(c.linkKey, "__link");
  assert.equal(c.nameKey, "__name");
  assert.equal(c.nameDegraded, false);
});

test("A7：入参兼容「行数组」与「单行对象」两种写法（四个调用点历史上两种都有）", () => {
  const rows = [{ 名称: "a", 链接: "https://pan.baidu.com/s/1abc", 提取码: "8k2n" }];
  const a = detectColumns(rows);
  const b = detectColumns(rows[0]);
  assert.deepEqual({ n: a.nameKey, l: a.linkKey, p: a.pwdKey }, { n: b.nameKey, l: b.linkKey, p: b.pwdKey });
});

test("A8：空输入不炸", () => {
  for (const bad of [[], [{}], undefined, null]) {
    const c = detectColumns(bad);
    assert.equal(typeof c.nameKey, "string");
    assert.equal(c.nameDegraded, true);
  }
});

// ─────────── B. 全仓只有一处定义 ───────────

test("B1：detectColumns 在全仓只有一处定义（netdisk/table-columns.js）", () => {
  const defs = PROD_JS.filter((f) => /function\s+detectColumns\s*\(|const\s+detectColumns\s*=/.test(read(f)));
  assert.deepEqual(defs, ["electron/src/netdisk/table-columns.js"]);
});

test("B2：列识别不再有任何内联拷贝（按关键字认列的那几行代码已绝迹）", () => {
  const bad = [];
  for (const f of PROD_JS) {
    if (f === "electron/src/netdisk/table-columns.js") continue;
    const src = read(f);
    if (/keys\.find\(\(k\)\s*=>\s*\/文件名\|名称\|标题\|资源\//.test(src)) bad.push(`${f}（旧内联列识别还在）`);
    if (/keys\.find\(\(k\)\s*=>\s*\/提取码\|密码\|访问码\//.test(src)) bad.push(`${f}（旧内联提取码列识别还在）`);
  }
  assert.deepEqual(bad, [], "这些文件还有内联的列识别拷贝：\n" + bad.join("\n"));
});

test("B3：四个调用点都改用 detectColumns，并且都对 nameDegraded 告警", () => {
  for (const f of FOUR_SITES) {
    const src = read(f);
    assert.ok(/require\(["'][^"']*netdisk\/table-columns["']\)/.test(src), `${f} 没有 require detectColumns`);
    assert.ok(/\bdetectColumns\s*\(/.test(src), `${f} 没有调用 detectColumns`);
    assert.ok(/\bnameDegraded\b/.test(src), `${f} 没有处理 nameDegraded（无名称列时会静默出错）`);
  }
});

test("B4：randomPwd 在全仓只有一处定义（netdisk/share.js），且字符集剔除了易混字符", () => {
  const defs = PROD_JS.filter((f) => /function\s+randomPwd\s*\(|const\s+randomPwd\s*=/.test(read(f)));
  assert.deepEqual(defs, ["electron/src/netdisk/share.js"]);
  const src = read("electron/src/netdisk/share.js");
  assert.ok(src.includes("abcdefghjkmnpqrstuvwxyz23456789"), "字符集应剔除 i/l/o/0/1");
});

test("B5：randomPwd 输出 4 位、只含允许字符、且确实随机", () => {
  const allowed = /^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/;
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const p = randomPwd();
    assert.match(p, allowed, `非法提取码：${p}`);
    for (const ch of ["i", "l", "o", "0", "1"]) {
      assert.ok(!p.includes(ch), `提取码不该出现易混字符 ${ch}：${p}`);
    }
    seen.add(p);
  }
  assert.ok(seen.size > 50, `200 次只生成了 ${seen.size} 种，随机性不足`);
});

test("B6：台账读写在全仓只有一处实现（netdisk/state-ledger.js）", () => {
  const defs = PROD_JS.filter((f) => /function\s+loadLedger\s*\(|function\s+appendLedger\s*\(/.test(read(f)));
  assert.deepEqual(defs, ["electron/src/netdisk/state-ledger.js"]);
});

test("B7：不再有整份的 loadState/saveState 拷贝（只允许一行别名转调 appendLedger）", () => {
  const bad = [];
  for (const f of PROD_JS) {
    const src = read(f);
    // 曾经的整份实现：一个叫 loadState/saveState 的**函数声明**
    if (/function\s+(loadState|saveState)\s*\(/.test(src)) bad.push(`${f}（还有整份函数声明）`);
    // 允许 `const saveState = (x) => appendLedger(...)` 这种一行别名；但出现 Map()/readFileSync 就是又抄了一份
    for (const m of src.matchAll(/const\s+(loadState|saveState)\s*=[^;]*;/g)) {
      if (/Map\(\)|readFileSync/.test(m[0])) bad.push(`${f}（${m[1]} 又抄了实现）`);
    }
  }
  assert.deepEqual(bad, [], "台账实现被重新拷贝了：\n" + bad.join("\n"));
});

test("B8：台账去重键是有意区分的 —— 转存类 srcLink，网盘已有资源 srcPath", () => {
  assert.match(read("scripts/netdisk-share-existing.js"), /loadLedger\(\s*stateFile\s*,\s*"srcPath"\s*\)/);
  assert.match(read("scripts/pan-transfer-batch.js"), /loadLedger\(\s*stateFile\s*,\s*"srcLink"\s*\)/);
  assert.match(read("electron/src/tasks/batch-transfer.js"), /loadLedger\(\s*stateFile\s*,\s*"srcLink"\s*\)/);
});

// ─────────── C. 台账行为（append-only / 后写覆盖 / 容错） ───────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-ledger-"));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

test("C1：文件不存在 → 空 Map（首次运行的正常路径，不能抛）", () => {
  const m = loadLedger(path.join(TMP, "不存在", "state.jsonl"), "srcLink");
  assert.equal(m.size, 0);
});

test("C2：append-only + 后写覆盖先写（pending → done 是同一 key 的两条事件）", () => {
  const f = path.join(TMP, "c2", "state.jsonl");
  appendLedger(f, { srcLink: "L1", status: "pending" });
  appendLedger(f, { srcLink: "L2", status: "pending" });
  appendLedger(f, { srcLink: "L1", status: "done", ownLink: "https://pan.baidu.com/s/own1" });
  const m = loadLedger(f, "srcLink");
  assert.equal(m.size, 2, "同一 key 多条事件只留最新一条");
  assert.equal(m.get("L1").status, "done");
  assert.equal(m.get("L2").status, "pending");
  // 确认是**追加**而不是重写：文件里应留有全部 3 行（断点续跑依赖这个历史）
  assert.equal(fs.readFileSync(f, "utf8").trim().split("\n").length, 3);
});

test("C3：单行损坏只跳这一行，不影响整份台账", () => {
  const f = path.join(TMP, "c3", "state.jsonl");
  appendLedger(f, { srcLink: "L1", status: "done" });
  fs.appendFileSync(f, "{这行坏掉了\n");
  appendLedger(f, { srcLink: "L2", status: "done" });
  const m = loadLedger(f, "srcLink");
  assert.deepEqual([...m.keys()].sort(), ["L1", "L2"]);
});

test("C4：keyField 决定去重键 —— 缺该字段的行会被忽略，换键后互不干扰", () => {
  const f = path.join(TMP, "c4", "state.jsonl");
  appendLedger(f, { srcLink: "L1", srcPath: "/a", status: "done" });
  appendLedger(f, { srcPath: "/b", status: "done" }); // 没有 srcLink
  const byLink = loadLedger(f, "srcLink");
  const byPath = loadLedger(f, "srcPath");
  assert.deepEqual([...byLink.keys()], ["L1"], "缺 srcLink 的那条按 srcLink 读不到");
  assert.deepEqual([...byPath.keys()].sort(), ["/a", "/b"]);
});

test("C5：appendLedger 会自动建父目录", () => {
  const f = path.join(TMP, "多层", "深", "state.jsonl");
  appendLedger(f, { srcLink: "L1" });
  assert.ok(fs.existsSync(f));
});

// ─────────── D. 语法 ───────────

test("D1：本轮新增/改动的文件语法正确（vm.Script，不起子进程）", () => {
  const files = [
    "electron/src/netdisk/table-columns.js",
    "electron/src/netdisk/state-ledger.js",
    "electron/src/netdisk/share.js",
    ...FOUR_SITES,
    "scripts/netdisk-share-existing.js",
    "electron/src/storage/excel.js",
    ...READ_SITES,
    "scripts/workbench-generate.js",
  ];
  for (const f of files) {
    assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), `${f} 语法错误`);
  }
});

// ─────────── E. 读表收敛（storage/excel.js 是唯一入口） ───────────

const excel = require("../../electron/src/storage/excel");
const XLSX = require("xlsx");

const XLS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-xlsx-"));
test.after(() => { try { fs.rmSync(XLS_TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

/** 造一张「提取码是数字单元格、显示成 0023」的表 —— Excel 自动转数字就是这个形态 */
function makeCodedTable() {
  const file = path.join(XLS_TMP, `t-${Date.now()}.xlsx`);
  const ws = XLSX.utils.aoa_to_sheet([["名称", "链接", "提取码"], ["a.zip", "https://pan.baidu.com/s/1abc", 1]]);
  ws.C2 = { t: "n", v: 23, z: "0000", w: "0023" }; // 值 23、格式 0000 → 表格里显示 0023
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "资源");
  XLSX.writeFile(wb, file);
  return file;
}

test("E1：实证 —— raw:false 保住「看着像数字」的提取码，默认 raw 会把它变成数字（丢前导零）", () => {
  const file = makeCodedTable();
  const safe = excel.readTableRows(file, { raw: false })[0]["提取码"];
  const unsafe = excel.readTableRows(file)[0]["提取码"];
  assert.equal(safe, "0023", "raw:false 必须拿到显示的文本 0023");
  assert.equal(typeof safe, "string");
  assert.equal(unsafe, 23, "默认 raw 拿到的是数字 23 —— 这正是资源表不能用的原因");
  assert.equal(typeof unsafe, "number");
});

test("E2：不传 raw 时保持历史默认（那 12 处应用内核调用行为不变）", () => {
  const file = makeCodedTable();
  assert.equal(typeof excel.readTableRows(file)[0]["提取码"], "number");
  assert.equal(typeof excel.readTableRows(file, {})[0]["提取码"], "number");
  assert.equal(typeof excel.readTableRows(file, { raw: true })[0]["提取码"], "number");
});

test("E3：readFirstSheet 一次读盘同时给出表名与行", () => {
  const file = makeCodedTable();
  const { sheetName, rows } = excel.readFirstSheet(file, { raw: false });
  assert.equal(sheetName, "资源");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["提取码"], "0023");
});

test("E4：表存在但没有数据行 —— 返回空数组，不是 undefined/报错", () => {
  const file = path.join(XLS_TMP, "header-only.xlsx");
  const ws = XLSX.utils.json_to_sheet([], { header: ["名称", "链接", "提取码"] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "资源");
  XLSX.writeFile(wb, file);
  assert.deepEqual(excel.readTableRows(file), []);
  assert.deepEqual(excel.readTableRows(file, { raw: false }), []);
  assert.deepEqual(excel.readFirstSheet(file), { sheetName: "资源", rows: [] });
});

// ⚠️ 这里不测「无表工作簿」的端到端：实测 XLSX.writeFile 对空 book 一律抛 `Workbook is empty`
// （xlsx/csv/ods/html/biff8 全试过），磁盘上根本造不出这种文件，夹具自身就会先失败。
// 所以把「选第一张表」拎成纯函数（excel.firstSheetName）单点验证这个守卫。
test("E5：SheetNames 为空时不炸（老写法会在 sheet_to_json(undefined) 处 TypeError）", () => {
  assert.equal(excel.firstSheetName({ SheetNames: [], Sheets: {} }), "");
  assert.equal(excel.firstSheetName({}), "");
  assert.equal(excel.firstSheetName(null), "");
  assert.equal(excel.firstSheetName({ SheetNames: ["资源", "第二张"], Sheets: {} }), "资源");
  // 守卫本身：SheetNames[0] 是空串也要退化成 ""，而不是把空串当表名去 Sheets 里取
  assert.equal(excel.firstSheetName({ SheetNames: [""] }), "");
});

test("E6：全仓只有 storage/excel.js 与那个已标注的例外还在 XLSX.readFile", () => {
  const bad = [];
  for (const f of PROD_JS) {
    const code = read(f).replace(/^\s*\/\/.*$/gm, ""); // 去掉行注释（注释里会举例 `XLSX.readFile`）
    if (!/XLSX\.readFile\s*\(/.test(code)) continue;
    if (f === "electron/src/storage/excel.js" || f === READ_EXCEPTION) continue;
    bad.push(f);
  }
  assert.deepEqual(bad, [], "这些文件还在自己 XLSX.readFile，应改用 readTableRows/readFirstSheet：\n" + bad.join("\n"));
});

test("E7：那个例外必须在代码里写明为什么（防止后来的人又默默抄回去）", () => {
  const src = read(READ_EXCEPTION);
  assert.ok(/有意|例外/.test(src), `${READ_EXCEPTION} 应注明自己是"有意不走 excel.js"的例外`);
  assert.ok(/sheet_add_json|saveTable\(wb/.test(src), "理由应说明它要把结果写回同一个 workbook");
});

test("E8：收敛后的调用点都真的 require 了 storage/excel，且用的是 readTableRows/readFirstSheet", () => {
  for (const f of READ_SITES) {
    const src = read(f);
    assert.ok(/require\(["'][^"']*storage\/excel["']\)/.test(src), `${f} 没有 require storage/excel`);
    assert.ok(/excel\.(readTableRows|readFirstSheet)\s*\(/.test(src), `${f} 没有调用 excel.readTableRows/readFirstSheet`);
  }
});

test("E9：读资源表的几处都显式传了 raw:false（提取码列不能按数字读）", () => {
  const resourceReaders = [
    "electron/src/tasks/batch-transfer.js",
    "scripts/pan-transfer-batch.js",
    "scripts/pan-transfer-ui.js",
    "scripts/pan-transfer-pipeline.js",
    "scripts/mass-qa-template.js",
    "scripts/pan-to-qa.js",
  ];
  for (const f of resourceReaders) {
    assert.match(read(f), /excel\.(readTableRows|readFirstSheet)\([^)]*raw:\s*false/, `${f} 读资源表必须传 raw:false`);
  }
});

// ─────────── F. share_failed 的「只补分享、不重传」 ───────────
//
// 转存成功 ≠ 分享成功。以前重跑时只认 `status==="done" && ownLink` 才算完成，
// 于是 share_failed 的行**每一轮都被重新转存一遍**：转存接口必然回 errno=4 走复用，
// 白白多一次请求、多占一次风控窗口；被永久禁止二次分享（errno=115）的更是永远重试。
// 「该怎么处理」的判断收敛到 netdisk/share-retry.js，三条链路共用。

const { planShareRetry, shareRetryFields, SHARE_RETRY_MAX } = require("../../electron/src/netdisk/share-retry");
const SHARE_SITES = [
  "electron/src/tasks/batch-transfer.js",
  "scripts/pan-transfer-batch.js",
  "scripts/pan-transfer-ui.js",
];

test("F1：没有历史记录 → 走完整转存", () => {
  assert.equal(planShareRetry(undefined).action, "transfer");
  assert.equal(planShareRetry(null).action, "transfer");
  assert.equal(planShareRetry({}).action, "transfer");
});

test("F2：不是 share_failed 的历史 → 走完整转存（不越权改语义）", () => {
  assert.equal(planShareRetry({ status: "failed" }).action, "transfer");
  assert.equal(planShareRetry({ status: "pending" }).action, "transfer");
  assert.equal(planShareRetry({ status: "done", ownLink: "" }).action, "transfer");
});

test("F3：share_failed 且有落盘路径 → 只补分享，**不再转存**", () => {
  const r = planShareRetry({ status: "share_failed", toPaths: ["/我的资源/a.zip"] });
  assert.equal(r.action, "share-only");
  assert.deepEqual(r.toPaths, ["/我的资源/a.zip"]);
  assert.equal(r.shareAttempts, 0);
});

test("F4：share_failed 但没留下落盘路径 → 只能重传一次把路径拿回来", () => {
  const r = planShareRetry({ status: "share_failed", toPaths: [] });
  assert.equal(r.action, "transfer");
  assert.match(r.reason, /落盘路径/);
  assert.equal(planShareRetry({ status: "share_failed" }).action, "transfer", "toPaths 字段缺失时也不能炸");
});

test("F5：补分享次数用尽 → 彻底跳过（给得出人能看懂的理由）", () => {
  const r = planShareRetry({ status: "share_failed", toPaths: ["/a.zip"], shareAttempts: SHARE_RETRY_MAX });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /补分享 \d+ 次仍失败/);
  // 次数用尽之前仍然给机会
  assert.equal(planShareRetry({ status: "share_failed", toPaths: ["/a.zip"], shareAttempts: SHARE_RETRY_MAX - 1 }).action, "share-only");
});

test("F6：百度永久禁止二次分享 → 立刻跳过，一次都不再试", () => {
  const r = planShareRetry({ status: "share_failed", toPaths: ["/a.zip"], shareForbidden: true });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /永久禁止/);
  // 哪怕是"还没试过"的也直接跳过 —— 换号、等明天都不会变
  assert.equal(planShareRetry({ status: "failed", shareForbidden: true }).action, "skip");
});

test("F7：toPaths 里的空串/脏数据被滤掉（空数组不算「有路径」）", () => {
  assert.deepEqual(planShareRetry({ status: "share_failed", toPaths: ["/a.zip", "", "  ", null, 42] }).toPaths, ["/a.zip"]);
  assert.equal(planShareRetry({ status: "share_failed", toPaths: ["", "  "] }).action, "transfer");
  assert.equal(planShareRetry({ status: "share_failed", toPaths: "/a.zip" }).action, "transfer", "toPaths 不是数组时也不能当真");
});

test("F8：shareRetryFields —— 次数递增，且把永久禁止落到台账里（供下一轮判 skip）", () => {
  assert.deepEqual(shareRetryFields({ shareAttempts: 0 }, {}), { shareAttempts: 1 });
  assert.deepEqual(shareRetryFields({ shareAttempts: 2 }, { shareForbidden: false }), { shareAttempts: 3 });
  assert.deepEqual(shareRetryFields({ shareAttempts: 0 }, { shareForbidden: true }), { shareAttempts: 1, shareForbidden: true });
  assert.deepEqual(shareRetryFields(undefined, undefined), { shareAttempts: 1 }, "没有历史时也不能炸");
});

test("F9：三条链路都真的 require 并调用了 planShareRetry（少一条就是「该省的请求没省」）", () => {
  for (const f of SHARE_SITES) {
    const src = read(f);
    assert.match(src, /require\(["'][^"']*netdisk\/share-retry["']\)/, `${f} 没有 require share-retry`);
    assert.match(src, /planShareRetry\s*\(/, `${f} 没有调用 planShareRetry`);
    assert.match(src, /retry\.action\s*===\s*"share-only"/, `${f} 没有 share-only 分支（会白白重传）`);
    assert.match(src, /retry\.action\s*===\s*"skip"/, `${f} 没有 skip 分支（永久禁止的资源会永远重试）`);
  }
});

test("F10：三条链路写回台账时都带上 shareRetryFields（否则下一轮判不出次数/禁止）", () => {
  for (const f of SHARE_SITES) {
    assert.match(read(f), /shareRetryFields\s*\(/, `${f} 的 share_failed 条目没有计数字段`);
  }
});
