"use strict";

/**
 * 第 11 轮：把散落在 CLI 脚本里的「网盘协议链 / 表单元格解析」收敛到主实现。
 *
 * 这一轮修的是**架构性的**问题，不是某个功能：`scripts/` 下有 3 个转存脚本各自
 * 复制了一份 `processOne` / `Jar` / `makeClient` / `parseLinkCell`。副本不会报错，
 * 它只会**静默做错事** —— 主实现里加进去的每一条实测修正（分享页限流的退避重试、
 * errno=2 回落顶层目录、errno=4 的路径拼装回落、info[0].errno 提升、
 * 0 字节占位过滤、建目录缓存、异步转存 pending、代理/超时）在副本里一条都没有。
 *
 * 已经因此真实踩到过的坑（不是假设）：
 *   · `scripts/pan-transfer-ui.js` 抄 `parseLinkCell` 时把拼接写成 `pwdKey ? "" : ""`，
 *     两个分支都是空串 → 提取码列永远读不到 → 整表被 `if (!cellPwd) continue` **静默跳过**，
 *     输出「成功 0 | 失败 0」且零日志。
 *
 * 所以这些守卫不只是"代码整洁"：它们防的是**再一次的静默错误**。
 * 谁要新增读资源表的入口，请 require `netdisk/pan-link`；谁要发网盘请求，
 * 请 require `netdisk/protocol`，别再抄。
 *
 * ⚠️ 测试自身的两个坑（已踩过，别再犯）：
 *   1) 检查 `require("..../pan-link")` 这类**字符串内容**时，不能先剥掉字符串 ——
 *      剥完路径就没了，断言永远失败。所以这里有两个 helper：
 *      `stripComments`（保字符串，查 require / 模板拼接用）与
 *      `stripStringsAndComments`（查"真的会执行"的代码、防注释误判用）。
 *   2) 不要用 `spawnSync(node, ["--check", f])` 做语法检查 —— 在本机沙箱里 spawn 同一个
 *      node.exe 会直接 EBUSY（status=null），于是"语法检查"变成随机失败。
 *      改用 `vm.Script` 编译（只编译不执行，足够发现语法错误）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

/** 只剥注释、**保留字符串**（查 require 路径、模板拼接这类"在字符串里"的东西要用它） */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // 字符串整体原样保留（含转义），这样里面的 // 不会被当成注释
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; }
        out += src[i];
        i += 1;
      }
      if (i < src.length) { out += src[i]; i += 1; }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (ch === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/** 剥掉字符串字面量与注释，只留"真的会执行"的代码（防注释里的字样误判） */
function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (ch === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      i += 1;
      out += " ";
      continue;
    }
    // 正则字面量：`/` 前面是运算符/括号/逗号这类位置时它是正则，不是除号
    if (ch === "/" && /(?:[=(,:;[!&|?{]|\breturn|\btypeof)\s*$/.test(out)) {
      i += 1;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i += 1;
      }
      i += 1;
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1; // 收尾标志 gimsuy
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const walkJs = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkJs(rel));
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
};
// 全仓源码（不含 node_modules / tests 自身 / dist 打包产物）
const ALL_SRC = [...walkJs("electron/src"), ...fs.readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".js")).map((f) => `scripts/${f}`)];

const SCRIPT_BATCH = "scripts/pan-transfer-batch.js";
const SCRIPT_UI = "scripts/pan-transfer-ui.js";
const SCRIPT_PIPELINE = "scripts/pan-transfer-pipeline.js";
const APP_TASK = "electron/src/tasks/batch-transfer.js";
const THE_THREE = [SCRIPT_BATCH, SCRIPT_UI, SCRIPT_PIPELINE];

// ─────────── A. 表单元格解析：一份实现 ───────────

test("A1：parseLinkCell 在全仓只有一处定义（netdisk/pan-link.js）", () => {
  const defs = ALL_SRC.filter((f) => /function\s+parseLinkCell\s*\(/.test(stripStringsAndComments(read(f))));
  assert.deepEqual(defs, ["electron/src/netdisk/pan-link.js"],
    `parseLinkCell 被定义了 ${defs.length} 次（应恰好 1 次）：${defs.join(", ")}`);
});

test("A2：三个转存脚本与 batch-transfer 都从 pan-link require，不再自带实现", () => {
  for (const f of [...THE_THREE, APP_TASK]) {
    const code = stripComments(read(f));
    assert.ok(/require\(\s*["'][^"']*netdisk\/pan-link["']\s*\)/.test(code),
      `${f} 没有 require netdisk/pan-link`);
    assert.ok(/\bparseLinkCell\b/.test(code), `${f} 没有使用 parseLinkCell`);
  }
});

test("A3：parseLinkCell 能吃下资源表里实测出现过的 4 种写法", () => {
  const { parseLinkCell } = require("../../electron/src/netdisk/pan-link");
  // ① 链接自带 ?pwd=
  assert.deepEqual(parseLinkCell("https://pan.baidu.com/s/1AbCdEf?pwd=xy7z"),
    { link: "https://pan.baidu.com/s/1AbCdEf?pwd=xy7z", pwd: "xy7z" });
  // ② 「提取码:」标签（半角冒号 + 空格）
  assert.deepEqual(parseLinkCell("https://pan.baidu.com/s/1AbCdEf 提取码: xy7z"),
    { link: "https://pan.baidu.com/s/1AbCdEf", pwd: "xy7z" });
  // ③ 「密码：」标签（全角冒号）
  assert.deepEqual(parseLinkCell("链接 https://pan.baidu.com/s/1AbCdEf 密码：ab12"),
    { link: "https://pan.baidu.com/s/1AbCdEf", pwd: "ab12" });
  // ④ 「访问码」标签（码写在链接前面）
  assert.deepEqual(parseLinkCell("访问码：cd34 https://pan.baidu.com/s/1AbCdEf"),
    { link: "https://pan.baidu.com/s/1AbCdEf", pwd: "cd34" });
});

test("A4：提取码**原样返回、不做大小写转换**（大小写变了链接就打不开）", () => {
  const { parseLinkCell } = require("../../electron/src/netdisk/pan-link");
  const r = parseLinkCell("https://pan.baidu.com/s/1AbCdEf 提取码: XY7Z");
  assert.equal(r.pwd, "XY7Z", "提取码被改写了大小写，拼出来的 ?pwd= 打不开分享");
});

test("A5：没有链接 / 非字符串输入不炸；没写标签的裸码不当成提取码", () => {
  const { parseLinkCell } = require("../../electron/src/netdisk/pan-link");
  assert.deepEqual(parseLinkCell("这里没有分享链接"), { link: "", pwd: "" });
  // 裸的 4 位字符**不作数**：表格里到处是"4 位字母数字"，靠它猜码会拼出打不开的链接。
  // 提取码必须来自 ?pwd= 或「提取码/密码/访问码」标签。
  assert.deepEqual(parseLinkCell("随便一段文字 abcd"), { link: "", pwd: "" });
  assert.deepEqual(parseLinkCell(undefined), { link: "", pwd: "" });
  assert.deepEqual(parseLinkCell(null), { link: "", pwd: "" });
  assert.deepEqual(parseLinkCell(12345), { link: "", pwd: "" });
});

test("A6：pan-transfer-ui.js 不再有 `? \"\" : \"\"` 空转三元，且真的把提取码列拼进去了", () => {
  const code = stripComments(read(SCRIPT_UI));
  assert.ok(!/\?\s*""\s*:\s*""/.test(code),
    "还有 `? \"\" : \"\"` 空转三元 —— 这正是导致提取码列被忽略、整表静默跳过的写法");
  // 同一行里必须出现 pwdKey（说明提取码列的内容真的被拼进了待解析文本）
  const line = code.split("\n").find((l) => l.includes("parseLinkCell("));
  assert.ok(line, "在 pan-transfer-ui.js 里找不到 parseLinkCell( 的调用");
  assert.ok(/pwdKey/.test(line), `parseLinkCell 的输入没带提取码列：${line.trim().slice(0, 120)}`);
});

test("A7：三个脚本调用 parseLinkCell 时都把提取码列拼进了输入", () => {
  for (const f of THE_THREE) {
    const code = stripComments(read(f));
    const line = code.split("\n").find((l) => l.includes("parseLinkCell("));
    assert.ok(line && /pwdKey/.test(line), `${f} 的 parseLinkCell 输入没带提取码列：${(line || "").trim().slice(0, 120)}`);
  }
});

// ─────────── B. 协议链：一份实现 ───────────

test("B1：processOne 只定义在 protocol.js（脚本不得再有第二份）", () => {
  const defs = ALL_SRC.filter((f) => /function\s+processOne\s*\(/.test(stripStringsAndComments(read(f))));
  assert.deepEqual(defs, ["electron/src/netdisk/protocol.js"],
    `processOne 有 ${defs.length} 份实现：${defs.join(", ")}（副本收不到主实现的修正）`);
});

test("B2：Jar 与 makeClient 也只定义在 protocol.js", () => {
  for (const [name, re] of [["class Jar", /class\s+Jar\s*[({]/], ["function makeClient", /function\s+makeClient\s*[({]/]]) {
    const defs = ALL_SRC.filter((f) => re.test(stripStringsAndComments(read(f))));
    assert.deepEqual(defs, ["electron/src/netdisk/protocol.js"],
      `${name} 有 ${defs.length} 份定义：${defs.join(", ")}`);
  }
});

test("B3：protocol.js 导出 makeClient（脚本查空间要用，不能再各抄一份）", () => {
  const proto = require("../../electron/src/netdisk/protocol");
  assert.equal(typeof proto.makeClient, "function");
  assert.equal(typeof proto.Jar, "function");
  assert.equal(typeof proto.processOne, "function");
  // 导出的 makeClient 必须是 protocol 自己那份（带了 panFetch 的 UA/Cookie/代理/超时）
  assert.equal(proto.makeClient.length, 1, "makeClient 应只收 jar 一个参数");
});

test("B4：pan-transfer-batch.js 里没有裸 fetch(（全部经由 protocol 的封装）", () => {
  const code = stripStringsAndComments(read(SCRIPT_BATCH));
  const hits = code.match(/(^|[^.\w])fetch\s*\(/g) || [];
  assert.equal(hits.length, 0,
    `还有 ${hits.length} 处裸 fetch —— 那会漏掉代理（同一批操作两个 IP）或漏掉超时（永久吊住）`);
});

test("B5：pan-transfer-batch.js 从 protocol 取 processOne，并把 createdDirs 传进去", () => {
  const code = stripComments(read(SCRIPT_BATCH));
  assert.ok(/require\(\s*["'][^"']*netdisk\/protocol["']\s*\)/.test(code), "没有 require netdisk/protocol");
  assert.ok(/\bprocessOne\b/.test(code), "没有使用 processOne");
  assert.ok(/\bcreatedDirs\b/.test(code),
    "没有传 createdDirs：建目录缓存失效，每条都重跑「根 / 根-资源表」两层写请求（而写请求正是限流触发点）");
  assert.ok(/\bmakeClient\b/.test(code), "查空间没有用 protocol 导出的 makeClient");
});

test("B6：pan-transfer-batch.js 区分「异步转存 pending」与「转存失败」", () => {
  const raw = read(SCRIPT_BATCH);
  assert.ok(/\.pending\b/.test(raw), "没有处理 processOne 的 pending 返回");
  assert.ok(/status:\s*"pending"/.test(raw), "pending 条目没有单独记档（会被计成失败并进黑名单）");
  assert.ok(/异步转存/.test(raw), "没有把「百度在异步转存中」讲清楚");
});

test("B7：pan-transfer-batch.js 的分享走 runShareStep（分享失败 ≠ 整条失败）", () => {
  const code = stripStringsAndComments(read(SCRIPT_BATCH));
  assert.ok(/\brunShareStep\b/.test(code), "没有用 runShareStep：建分享失败会被当成整条转存失败");
  assert.ok(/shareFailed/.test(code), "没有判断 shareFailed —— 已落盘的文件会被反复重传（errno=4 死循环）");
  assert.ok(/status:\s*"share_failed"/.test(read(SCRIPT_BATCH)), "share_failed 没有单独记档");
  // 分享上限相关的状态必须都备齐，否则 runShareStep 的"撞上限就封账号"失效
  for (const id of ["shareBlocked", "sharesByEnv", "warnedSoft"]) {
    assert.ok(new RegExp(`\\b${id}\\b`).test(code), `${id} 没有传给 runShareStep`);
  }
});

test("B8：pan-transfer-batch.js 不再自己调 createShare 建分享（避免与 runShareStep 两套口径）", () => {
  const code = stripStringsAndComments(read(SCRIPT_BATCH));
  assert.ok(!/\bcreateShare\s*\(\s*\{/.test(code), "还在自己调 createShare —— 会绕过分享上限 / errno=115 的判定");
});

test("B9：pan-transfer-batch.js 对分享页限流有针对性处理（不是当成链接失效）", () => {
  const code = stripStringsAndComments(read(SCRIPT_BATCH));
  assert.ok(/sharePageLimited/.test(code),
    "没有处理 protocol 抛出的 sharePageLimited 标记：连续跑批时会把限流当成「链接失效」，白丢资源");
});

// ─────────── C. "选了却没跑成"必须留痕 ───────────

test("C1：脚本的跳过分支都有按原因的计数，不再只有一个笼统的 junk", () => {
  const batch = stripStringsAndComments(read(SCRIPT_BATCH));
  assert.ok(/drop\s*=\s*\{/.test(batch) && /\bnoLink\b/.test(batch) && /\bnoPwd\b/.test(batch) && /\bblacklist\b/.test(batch),
    "pan-transfer-batch.js 没有按原因分开统计被剔除的行");
  assert.ok(!/\bjunk\b/.test(batch), "还残留旧的笼统 junk 计数");

  const ui = read(SCRIPT_UI);
  assert.ok(/skipped\s*=\s*\{/.test(ui) && /noPwd/.test(ui) && /blacklist/.test(ui),
    "pan-transfer-ui.js 没有统计被跳过的行");
  assert.ok(/skippedTotal/.test(ui) && /跳过 \$\{skippedTotal\}/.test(ui),
    "pan-transfer-ui.js 没有把跳过数打出来");
});

test("C2：batch 脚本对「无提取码」的行会点名日志（限量，不刷屏）", () => {
  const raw = read(SCRIPT_BATCH);
  assert.ok(/无提取码/.test(raw), "「无提取码」没有出现在任何日志里");
  assert.ok(/drop\.noPwd\s*<=\s*5/.test(raw), "点名日志没有限量（会刷屏）");
});

// ─────────── D. 三个脚本都还能被解析 ───────────

test("D1：三个转存脚本与 pan-link/protocol 语法有效", () => {
  for (const f of [...THE_THREE, "electron/src/netdisk/pan-link.js", "electron/src/netdisk/protocol.js", APP_TASK]) {
    // 用 vm.Script 只编译不执行（不要去 spawnSync node --check：沙箱里会 EBUSY）
    assert.doesNotThrow(() => { new vm.Script(read(f), { filename: f }); }, `${f} 语法错误`);
  }
});
