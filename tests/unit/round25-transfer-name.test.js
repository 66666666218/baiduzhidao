"use strict";

/**
 * 第 25 轮：用户问「批量转存，转存的名字为什么文件夹全是批量转存，我们应该是作品名对应的啊」。
 *
 * 查下来的根因是**一处接线漏了**，不是设计选择：
 *   `processOne(jar, { link, pwd, destParent, fallbackName, ... })` 的签名里
 *   一直有 `rawName`，但 `tasks/batch-transfer.js` 调用它时**从来没传**。
 *   于是 `folder = (destParent ? nameFromShare(data) : "") || fallbackName || "资源"`
 *   里的 `nameFromShare` 只能退回到"分享里的第一个文件"——
 *   而百度网盘的分享里，头一个文件**常常是广告 txt**
 *   （实测样本：`先存网盘再下载 在线解压查看.txt`、`每天都会有大量资源更新…txt`），
 *   结果就是满屏 `K7254.exe` 这种认不出来的名字。
 *
 * 修法：把资源表那一列原样传进转存链，并让命名按"可信度"依次退化 ——
 *   ① 抽得出的干净作品名（书名号 / 下划线这类明确标记）
 *   ② 分享里的真实文件/文件夹名
 *   ③ 序号兜底
 * ⚠️ **不许拿资源表原始标题兜底**：那是一整句提问，当目录名只会更糟。
 *
 * 本轮守卫全部**真调函数**（`extractWorkName` / `processOne` 的命名分支），不扫文本。
 */

const test = require("node:test");
const assert = require("node:assert");

const { extractWorkName } = require("../../electron/src/netdisk/qa-template-lib");
const protocol = require("../../electron/src/netdisk/protocol");

// --------------------------------------------- R 组：作品名抽取本身

test("R1 书名号是强标记 —— 抽出来的就是作品名", () => {
  const cases = [
    ["《混乱》小说TXT完整版,求百度网盘分享链接", "混乱"],
    ["求《神医圣手》小小羽小说txt完整版百度网盘链接", "神医圣手"],
    ["谁有《许地山春桃》电子书百度网盘?完整版", "许地山春桃"],
    ["求《原则》瑞·达利欧电子书pdf完整版免费网盘", "原则"],
    ["请问《龙凤》电子书有百度网盘资源吗?", "龙凤"],
  ];
  for (const [raw, want] of cases) {
    const got = extractWorkName(raw);
    assert.equal(got.name, want, `${raw} → 期望 ${want}，实得 ${got.name}`);
    assert.equal(got.how, "书名号", `${raw} 应走书名号分支`);
  }
});

test("R2 下划线把作品名和类别分开了 —— 取前半段", () => {
  const cases = [
    ["求分享中国式网游_游戏百度网盘完整版下载", "中国式网游"],
    ["求猩球崛起4_新世界高清完整版网盘链接获取", "猩球崛起4"],
    ["求分享狩猎模拟2_游戏百度网盘完整版下载", "狩猎模拟2"],
  ];
  for (const [raw, want] of cases) {
    const got = extractWorkName(raw);
    assert.equal(got.name, want, `${raw} → 期望 ${want}，实得 ${got.name}`);
    assert.equal(got.how, "下划线", `${raw} 应走下划线分支`);
  }
});

test("R3 泛需求抽不出作品名时返回空串（不许留残句）", () => {
  // 这类行本来就没有具体作品（"求英语小说百度网盘资源" 不是一个作品），
  // 硬洗只会得到「英语小说」这种更没用的名字 —— 宁可空着，让调用方退回分享真名。
  const vague = [
    "求英语小说百度网盘完整资源分享",
    "求全文免费小说百度网盘链接获取",
    "急需韩漫免费漫画在线观看下拉式网盘完整资源下载链接",
  ];
  for (const raw of vague) {
    const got = extractWorkName(raw);
    assert.equal(got.name, "", `${raw} 不该抽出作品名`);
    assert.equal(got.how, "抽不出");
  }
});

test("R4 空/异常输入不炸", () => {
  for (const bad of ["", null, undefined, 0, {}, []]) {
    const got = extractWorkName(bad);
    assert.equal(got.name, "", `${JSON.stringify(bad)} 不该抽出作品名`);
  }
});

// --------------------------------------------- S 组：接线（根因所在）

test("S1 批量转存必须把资源表的作品名传给 processOne", () => {
  // 这条守的就是本轮的根因：`processOne` 的形参有 `rawName`，
  // 但批量转存调用处**少传了这一个字段**，于是命名链断在最前面的一环。
  // 用扫描而不是"跑一遍任务"来验：跑一遍要真转存，代价太高。
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "electron", "src", "tasks", "batch-transfer.js"),
    "utf8",
  );
  // 定位调用 processOne 的那一段（锚点唯一：只有一处 `processOne(jar, {`）
  const from = src.indexOf("await processOne(jar, {");
  assert.ok(from >= 0, "找不到 processOne 调用");
  const to = src.indexOf("});", from);
  assert.ok(to > from, "找不到 processOne 调用结尾");
  const block = src.slice(from, to);
  assert.match(block, /rawName,/, "processOne 调用处必须传 rawName（否则文件夹名会退回分享里的第一个文件）");
  assert.match(block, /destParent,/, "同时确认 destParent 仍然在传");
});

test("S2 命名优先级：作品名 > 分享真名 > 序号", () => {
  // 直接打 `planFolderName` 这个纯函数（命名规则唯一的家），不绕道跑整条协议链。
  assert.equal(protocol.planFolderName({
    rawName: "《混乱》小说TXT完整版,求百度网盘分享链接", shareName: "广告txt.txt", fallbackName: "00001",
  }), "混乱", "有书作品名时用作品名");

  assert.equal(protocol.planFolderName({
    rawName: "求英语小说百度网盘完整资源分享", shareName: "1000本英语小说合集", fallbackName: "00001",
  }), "1000本英语小说合集", "抽不出作品名时退回分享真名（不是残句）");

  assert.equal(protocol.planFolderName({
    rawName: "求英语小说百度网盘完整资源分享", shareName: "", fallbackName: "00001",
  }), "00001", "连分享真名都没有才用序号");

  assert.equal(protocol.planFolderName({
    rawName: "", shareName: "", fallbackName: "",
  }), "资源", "全空兜底");
});

test("S3 抽出来的名字要能直接当目录名（无非法字符、不过长）", () => {
  const evil = "《动作/冒险:动作片*第二部?》<全集>|\"蓝光\"";
  const got = extractWorkName(evil);
  assert.ok(got.name.length > 0, "这种输入仍应抽出内容");
  assert.doesNotMatch(got.name, /[/:*?"<>|]/, `名字不该含路径非法字符：${got.name}`);
  assert.ok(got.name.length <= 60, `名字不该超过 60 字：${got.name.length}`);
});

// --------------------------------------------- T 组：编译守卫（round13 D2）

test("T1 改动文件都能当脚本编译（模块顶层不许有 return）", () => {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..", "..");
  for (const rel of [
    "electron/src/netdisk/protocol.js",
    "electron/src/netdisk/qa-template-lib.js",
    "electron/src/tasks/batch-transfer.js",
  ]) {
    assert.doesNotThrow(
      () => new vm.Script(fs.readFileSync(path.join(ROOT, rel), "utf8"), { filename: rel }),
      `${rel} 必须能通过 vm.Script`,
    );
  }
});

test("T2 作品名抽取只在 qa-template-lib 一个地方定义（不许别处再抄一份）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..", "..");
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walk(p); }
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  walk(path.join(ROOT, "electron"));
  const hits = files.filter((f) => /function extractWorkName\b/.test(fs.readFileSync(f, "utf8")));
  assert.equal(hits.length, 1, `extractWorkName 只应定义一次，实得 ${hits.length} 处：${hits.join(", ")}`);
});
