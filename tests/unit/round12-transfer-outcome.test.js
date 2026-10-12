"use strict";

/**
 * 第 12 轮：「一次 /share/transfer 响应意味着什么」—— 这条判断收敛成一个纯函数。
 *
 * 为什么值得单独一轮：同一个判断在本仓库里出现过**三份**，成熟度完全不同 ——
 *   · `netdisk/protocol.js`（纯协议，应用主路径）：6 条规则全有
 *   · `netdisk/transfer.js`（浏览器执行器，CLI 脚本用）：只有前 2 条
 *   · `scripts/pan-transfer-ui.js`（真 UI 点击，拦截 XHR）：**一条都没有**
 * 三份跑在完全不同的代码路径上，谁也不会提醒谁。落后的那份于是把三种
 * 「其实已经成功」的情况记成失败：
 *   ① `errno=4`（已转存过）→ 每次重跑都刷一遍假失败，而且**永远不可能变成功**；
 *   ② 大文件**异步转存**（errno=0 但没有 extra 路径）→ 报「未取得落盘路径」，
 *      计失败 + attempts+1 → 3 次后进黑名单，而文件其实正在正常转；
 *   ③ `info[0].errno` 里的真实错误被吞 → 真实原因被掩盖成「未取得落盘路径」。
 *
 * 本轮把它们统一到 `netdisk/transfer-outcome.js`，并**只**抽已经确证的规则。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const {
  normalizeTransferBody, describeTransferOutcome, CAPACITY_ERRNOS,
} = require("../../electron/src/netdisk/transfer-outcome");

const SCRIPT_UI = "scripts/pan-transfer-ui.js";
const SCRIPT_BATCH = "scripts/pan-transfer-batch.js";
const TRANSFER = "electron/src/netdisk/transfer.js";
const PROTOCOL = "electron/src/netdisk/protocol.js";
const OUTCOME = "electron/src/netdisk/transfer-outcome.js";

// ─────────── A. 归一化的正确性 ───────────

test("A1：errno=4（已转存过）→ dup=true，不是失败", () => {
  const o = normalizeTransferBody({ errno: 4, duplicated: { list: [{ path: "/x/a.mkv", fs_id: 1 }] } });
  assert.equal(o.dup, true);
  assert.equal(o.errno, 4);
  assert.deepEqual(o.dupPaths, ["/x/a.mkv"]);
  assert.deepEqual(o.dupFsIds, [1]);
});

test("A2：顶层 errno=0 但 info[0].errno=-9 → 提升到顶层，真实原因不被吞", () => {
  const o = normalizeTransferBody({ errno: 0, info: [{ errno: -9, path: "/a.mkv" }] });
  assert.equal(o.errno, -9, "要把 info 层的真实 errno 提上来");
  assert.equal(o.rawErrno, 0);
  assert.equal(o.infoErrno, -9);
  assert.equal(o.infoSucceeded, false);
  assert.deepEqual(o.infoPaths, ["/a.mkv"]);
});

test("A3：info[0].errno=0 → infoSucceeded，顶层非 0 也不许报错（这是真实成功）", () => {
  const o = normalizeTransferBody({ errno: 0, info: [{ errno: 0 }], extra: { list: [{ to: "/x/a.mkv" }] } });
  assert.equal(o.infoSucceeded, true);
  assert.equal(o.errno, 0);
  const o2 = normalizeTransferBody({ errno: 5, info: [{ errno: 0 }] });
  assert.equal(o2.errno, 5, "顶层非 0 时不做提升");
  assert.equal(o2.infoSucceeded, true, "但 info 明确说成功了，调用方据此不报错");
});

test("A4：顶层 errno=2 → 不被 info 层提升覆盖（回落分支必须保住）", () => {
  const o = normalizeTransferBody({ errno: 2, info: [{ errno: 2 }] });
  assert.equal(o.errno, 2);
  assert.equal(o.pathMissing, true);
  assert.equal(normalizeTransferBody({ errno: 2 }).pathMissing, true);
});

test("A5：errno=12 / -10 → capacityFull；**-9 不算**（端点相关，见模块注释）", () => {
  assert.equal(normalizeTransferBody({ errno: 12 }).capacityFull, true);
  assert.equal(normalizeTransferBody({ errno: -10 }).capacityFull, true);
  assert.deepEqual(CAPACITY_ERRNOS, [12, -10]);
  // -9 在 verify 端点里是「提取码错误」，在 transfer 端点里的含义没有确证；
  // 把它当容量会在多账号跑批时误停一个好账号 —— 宁可保守。
  for (const e of [-9, -6, -62, -65, -70, 115, 120]) {
    assert.equal(normalizeTransferBody({ errno: e }).capacityFull, false, `errno=${e} 不该算容量不足`);
  }
});

test("A6：show_msg 含「转存中/正在转存」→ pending（大文件异步转存，不是失败）", () => {
  assert.equal(normalizeTransferBody({ errno: 0, show_msg: "文件转存中，请稍后查看" }).pending, true);
  assert.equal(normalizeTransferBody({ errno: 0, show_msg: "正在转存" }).pending, true);
  assert.equal(normalizeTransferBody({ errno: 0, show_msg: "转存成功" }).pending, false);
  assert.equal(normalizeTransferBody({}).pending, false);
});

test("A7：畸形响应（没有 errno 字段）不能被当成成功", () => {
  const o = normalizeTransferBody({});
  assert.ok(Number.isNaN(o.errno), `没有 errno 时应保持 NaN（调用方会当错误抛出来），实际 ${o.errno}`);
  assert.equal(o.capacityFull, false);
  assert.equal(o.dup, false);
  assert.equal(o.pending, false);
  // 空 body / null 也不能炸
  assert.doesNotThrow(() => normalizeTransferBody(null));
  assert.doesNotThrow(() => normalizeTransferBody(undefined));
});

test("A8：落盘路径两种来源分开给，字段名兼容两种写法", () => {
  const o = normalizeTransferBody({
    errno: 0,
    extra: { list: [{ to: "/x/a.mkv" }, { to: "" }, {}] },
    duplicated: { list: [{ path: "/x/b.mkv" }] },
  });
  assert.deepEqual(o.extraPaths, ["/x/a.mkv"]);
  assert.deepEqual(o.dupPaths, ["/x/b.mkv"]);
  // extra 里的 fs_id 见过 fsid / fs_id 两种写法，都要认
  assert.deepEqual(normalizeTransferBody({ errno: 0, extra: { list: [{ fsid: 11 }, { fs_id: 12 }] } }).extraFsIds, [11, 12]);
});

test("A9：describeTransferOutcome 把人话讲出来（跑批无人值守，裸 errno 没人看得懂）", () => {
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: 0 })), /成功/);
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: 4 })), /已转存过/);
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: 0, show_msg: "文件转存中" })), /异步转存中/);
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: 12 })), /容量不足/);
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: -6 })), /登录已失效/);
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: -65 })), /风控/);
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: 2 })), /路径不存在/);
  assert.match(describeTransferOutcome(normalizeTransferBody({ errno: 999, show_msg: "未知" })), /errno=999/);
});

// ─────────── B. 三份拷贝收敛成一份 ───────────

test("B1：三处调用方都 require transfer-outcome，不再自己写判定", () => {
  for (const f of [PROTOCOL, TRANSFER, SCRIPT_UI]) {
    assert.ok(/require\([^)]*transfer-outcome/.test(read(f)), `${f} 没有 require transfer-outcome`);
    assert.ok(/\bnormalizeTransferBody\b/.test(read(f)), `${f} 没有用 normalizeTransferBody`);
  }
});

test("B2：transfer.js 里不再有自己那份 info 提升 + errno=4 判定", () => {
  const raw = read(TRANSFER);
  assert.ok(!/info 层 errno 提升/.test(raw), "transfer.js 还留着自己的 info 提升实现");
  assert.ok(!/const errno = Number\(r\.errno\)/.test(raw), "transfer.js 还留着自己的 errno 归一");
});

test("B3：protocol.js 里不再有自己那份 info 提升（tBody.errno 原地改写）", () => {
  const raw = read(PROTOCOL);
  assert.ok(!/tBody\.errno = Number\(/.test(raw), "protocol.js 还在原地改写 tBody.errno");
  assert.ok(!/Number\(tBody\.errno\) === 2/.test(raw), "protocol.js 还在自己写 errno=2 判定");
  assert.ok(!/tBody\.errno === 12/.test(raw), "protocol.js 还在自己写容量判定");
});

test("B4：pan-transfer-ui.js 不再用「errno !== 0 就抛」这种一刀切判定", () => {
  const raw = read(SCRIPT_UI);
  assert.ok(!/tBody\.errno !== 0/.test(raw), "UI 脚本还在用 `tBody.errno !== 0` 一刀切（errno=4 会被当失败）");
  assert.ok(/o\.dup\b/.test(raw), "UI 脚本没有处理 dup（已转存过）");
  assert.ok(/o\.pending\b/.test(raw), "UI 脚本没有处理 pending（异步转存）");
  assert.ok(/o\.capacityFull\b/.test(raw), "UI 脚本没有处理容量不足");
  assert.ok(/o\.infoSucceeded\b/.test(raw), "UI 脚本没有处理 info 层成功的形态");
});

test("B5：UI 脚本的 pending 条目单独记档、不计失败、不进黑名单", () => {
  const raw = read(SCRIPT_UI);
  assert.ok(/status:\s*"pending"/.test(raw), "pending 没有单独记档");
  assert.ok(/异步转存中/.test(raw), "没有把「百度在异步转存中」讲清楚");
  // pending 分支必须走 pace()（转存节奏是限流触发点，不能因为 continue 就跳过）
  const pendingBlock = raw.slice(raw.indexOf("if (o.pending)"), raw.indexOf("if (o.pending)") + 700);
  assert.ok(/await pace\(\)/.test(pendingBlock), "pending 分支没有走 pace()，会以全速继续撞下一批");
});

test("B6：UI 脚本的超时不再用 {errno:-1} 冒充响应（超时与「接口返回 -1」要能分辨）", () => {
  const raw = read(SCRIPT_UI);
  assert.ok(!/resolve\(\{\s*errno:\s*-1\s*\}\)/.test(raw), "还在用 {errno:-1} 表示超时");
  assert.ok(/__timedOut/.test(raw), "没有给超时打显式标记");
});

// ─────────── C. 分享也走 runShareStep（独立失败域） ───────────

test("C1：UI 脚本的建分享走 runShareStep，不再自己调 createShare", () => {
  const raw = read(SCRIPT_UI);
  assert.ok(/runShareStep/.test(raw), "UI 脚本没有用 runShareStep");
  assert.ok(!/createShare\(\{/.test(raw), "UI 脚本还在自己调 createShare（会绕过每日上限 / errno=115 判定）");
  assert.ok(/shareFailed/.test(raw), "没有判断 shareFailed（已落盘的文件会被反复重跑）");
  assert.ok(/status:\s*"share_failed"/.test(raw), "share_failed 没有单独记档");
  for (const id of ["shareBlocked", "sharesByEnv", "warnedSoft"]) {
    assert.ok(new RegExp(`\\b${id}\\b`).test(raw), `${id} 没有传给 runShareStep`);
  }
});

test("C2：两个脚本都按「账号级每日分享上限」提前告警", () => {
  for (const f of [SCRIPT_UI, SCRIPT_BATCH]) {
    const raw = read(f);
    assert.ok(/SHARE_DAILY_LIMIT/.test(raw), `${f} 没有用 SHARE_DAILY_LIMIT`);
    assert.ok(/软告警线/.test(raw), `${f} 没有提前告警（用户会在一堆"仅转存"里找不到原因）`);
  }
});

test("C3：容量不足在 UI 脚本里是「停」而不是「继续撞」", () => {
  const raw = read(SCRIPT_UI);
  const i = raw.indexOf("e.fatal");
  assert.ok(i > 0, "UI 脚本没有处理 e.fatal");
  assert.match(raw.slice(i, i + 200), /容量不足/, "e.fatal 分支没说清是容量不足");
});

// ─────────── E. pan-transfer-pipeline.js：文档与实现对齐（本轮审计发现的第二处） ───────────

const SCRIPT_PIPELINE = "scripts/pan-transfer-pipeline.js";

test("E1：pipeline 不再有那三份死代码（pool / waitGate / tripPause / updateState）", () => {
  const vm = require("node:vm");
  const src = read(SCRIPT_PIPELINE);
  const code = new vm.Script(src, { filename: SCRIPT_PIPELINE }) && src;
  // 只允许出现在解释性注释里
  for (const name of ["pool", "waitGate", "tripPause", "updateState"]) {
    const asCode = new RegExp(`(function|const|let)\\s+${name}\\b`).test(code);
    assert.equal(asCode, false, `${name} 还是活代码 —— 它是死函数，留着会让人以为这条路是并发的`);
  }
  assert.ok(!/await waitGate\(/.test(code), "waitGate 的调用还在（定义已删 → 一跑就 ReferenceError）");
  assert.ok(code.length > 0);
});

test("E2：pipeline 对已失效的并发参数**吼出来**，不静默忽略", () => {
  const src = read(SCRIPT_PIPELINE);
  // 这四个并发参数 + pace-ms 都没有读者，用户传了必须被点名
  assert.ok(/DEAD_FLAGS/.test(src), "没有失效参数清单");
  for (const k of ["cc-collect", "cc-transfer", "cc-confirm", "cc-share", "pace-ms"]) {
    assert.ok(src.includes(`"${k}"`), `失效参数清单里缺 ${k}`);
  }
  assert.ok(/忽略无效参数/.test(src), "没有把「忽略无效参数」打出来");
  assert.ok(/delay-min/.test(src) && /delay-max/.test(src), "没有指出真正生效的调速参数");
  // 参数解析出来但没人读 = 本仓库反复踩的"我设了但没生效"。cc 对象本身也不该再存在。
  assert.ok(!/const cc = \{/.test(src), "cc 对象还在（赋了值却没人读，正是本轮要消灭的形态）");
});

test("E3：pipeline 文件头不再宣称「并发」（与实现不一致就是撒谎）", () => {
  const src = read(SCRIPT_PIPELINE);
  // 旧标题的确切形态：`→ 【五阶段并发批处理】→`。允许在解释里**引用**旧说法（要打脸先要说清旧的是什么），
  // 但不许再作为"这个脚本是什么"的描述出现。
  assert.ok(!/【五阶段并发批处理】/.test(src), "文件头还在用旧标题把自己描述成并发批处理");
  assert.ok(!/并发 verify\+list|并发转存到自己网盘|并发确认落盘|并发创建自己的永久分享/.test(src),
    "五个阶段的描述里还有「并发」字样，与实际串行实现不符");
  assert.ok(/逐条走五阶段/.test(src), "没有改成如实的「逐条」描述");
  assert.ok(/串行/.test(src), "没有说明实际是串行执行");
  assert.ok(/执行模型/.test(src), "没有「执行模型」一节来纠正预期");
});

test("E4：pipeline 的导出以 state 全量为准，不再靠巧合", () => {
  const src = read(SCRIPT_PIPELINE);
  // 旧写法：先从 tasks 取（tasks 里永远没有 done，所以恒为空）再回落到 state —— 靠巧合能用，
  // 一旦上面过滤逻辑变动就会**静默截断**导出。
  assert.ok(!/doneRows\.length\)\s*doneRows\.push\(/.test(src),
    "还在用「tasks 为空再回落 state」的写法：它现在能用纯属巧合，改动上方便会静默截断导出");
  assert.match(src, /const doneRows = \[\.\.\.state\.values\(\)\]/, "导出应以 state 全量为准");
});

test("E5：pipeline 语法有效", () => {
  const vm = require("node:vm");
  assert.doesNotThrow(() => { new vm.Script(read(SCRIPT_PIPELINE), { filename: SCRIPT_PIPELINE }); });
});

// ─────────── G. 「赋了值却没人读」——本仓库最高频的静默失效形态 ───────────

test("G1：全仓（scripts + electron/src）没有「顶层绑定声明后无人读」的死绑定", () => {
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(rel));
      else if (e.name.endsWith(".js")) out.push(rel);
    }
    return out;
  };
  const files = [...walk("electron/src"), ...fs.readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".js")).map((f) => `scripts/${f}`)];
  const dead = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
      const name = m[1];
      const count = (src.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
      if (count <= 1) dead.push(`${f} -> ${name}`);
    }
  }
  // 这条守卫的价值：本轮就是靠它机械地扫出 4 处"参数/常量声明了但没有读者"——
  // `--cc-*` 四个并发参数、`--pace-ms`、`--dest-select`、`BANNED_EXT`。
  // 它们的共同后果都是**静默失效**：用户设了、程序不报错、但根本没生效。
  assert.deepEqual(dead, [], "这些顶层绑定声明后无人读（要么接线、要么删掉，别静默留着）：\n" + dead.join("\n"));
});

test("G2：pan-to-qa.js 的压缩包过滤真的接上了（BANNED_EXT 不再是被声明却没用的常量）", () => {
  const src = read("scripts/pan-to-qa.js");
  assert.ok(/BANNED_EXT\.test\(/.test(src), "BANNED_EXT 声明了却仍没人用 —— 压缩包会漏进问答");
  // 旧写法点号没转义、且只认"名称正好以 .zip 结尾"。
  // 用字面量搜索而不是正则字面量：`/.../i.test` 这种串嵌在正则字面量里会把外层正则提前闭合。
  assert.ok(!src.includes("/(zip|rar|7z)$/i.test"), "还在用那条漏判的正则");
});

test("G3：pan-transfer-ui.js 对没实现的 --dest-select 会点名（而不是静默忽略）", () => {
  const src = read(SCRIPT_UI);
  assert.ok(/忽略无效参数 --dest-select/.test(src), "没有对 --dest-select 告警");
  assert.ok(!/const destSelect =/.test(src), "destSelect 变量还在（解析了却没人读）");
  assert.ok(!/--dest-select=我的资源/.test(src), "用法说明里还在推荐这个无效参数");
});

// ─────────── H. 语法与加载 ───────────

test("H1：相关文件语法有效且能被 require", () => {
  const vm = require("node:vm");
  for (const f of [OUTCOME, PROTOCOL, TRANSFER, SCRIPT_UI, SCRIPT_BATCH]) {
    assert.doesNotThrow(() => { new vm.Script(read(f), { filename: f }); }, `${f} 语法错误`);
  }
  assert.doesNotThrow(() => require("../../electron/src/netdisk/transfer-outcome"));
  assert.doesNotThrow(() => require("../../electron/src/netdisk/transfer"));
  assert.doesNotThrow(() => require("../../electron/src/netdisk/protocol"));
});
