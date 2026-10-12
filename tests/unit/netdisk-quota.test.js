"use strict";

/**
 * 网盘容量（/api/quota）的显示口径。
 *
 * 背景（2026-10-12 实测，别凭记忆改回去）：
 *   · 用户反馈「账号凭证里总容量和剩余显示不准」—— 界面上的数字其实是**添加账号那一刻的快照**，
 *     之后再没刷新过（"刷新账号"按钮绑的是只读本地存档的 loadAccounts，等于点了没查）。
 *   · 想改成实时查询时又撞上第二层：`/api/quota` **现在永远返回 errno=-6（用户未登录）**。
 *     我用对照实验确认过它不是"号掉了"：同一个 Cookie 打 `/api/list`、`/api/gettemplatevariable`
 *     都是 errno=0；参数写法换了 7 种、请求头加了 Accept/X-Requested-With、只带 BDUSS 不带 STOKEN
 *     全都还是 -6（三个号 × 3 轮稳定复现）。结论：**这个接口取不到容量，与登录态无关**。
 *   · 所以"看到 -6 就提示用户重新登录"是**骗人的** —— 会让人白白重登一遍，重登完照样取不到。
 *     -6 必须先用列目录验一次登录态再决定怎么说（describeQuotaFailure 的第二个参数就是干这个的）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const { describeQuotaFailure } = require("../../electron/src/netdisk/manager");

// ─────────── A. 失败原因不许说谎 ───────────

test("A1：errno=-6 但账号网盘是通的 → 说「接口不可用」，**绝不能**说登录已失效", () => {
  const text = describeQuotaFailure(-6, true);
  assert.match(text, /接口不可用/, text);
  assert.ok(!/登录已失效|未登录|重新登录/.test(text), "不能让用户白重登一次：" + text);
});

test("A2：errno=-6 且列目录也不通 → 才是真的登录失效", () => {
  assert.match(describeQuotaFailure(-6, false), /登录已失效/);
});

test("A3：其它 errno 各自说清", () => {
  assert.match(describeQuotaFailure(null, true), /无响应/);
  assert.match(describeQuotaFailure(2, true), /errno=2/);
  assert.match(describeQuotaFailure(0, true), /没有容量字段/);
  // 网盘不通这件事优先于 errno —— 号都掉了，报 errno 没意义
  assert.match(describeQuotaFailure(2, false), /登录已失效/);
});

// ─────────── B. 界面不能把旧值当实时值 ───────────

test("B1：渲染端不再是「a.totalGB || \"-\"」（它会把 0 显示成 -、又把旧快照当实时值）", () => {
  // ⚠️ 必须先剥注释：注释里会举例"以前这里写的是 a.totalGB || \"-\""，
  // 不剥的话守卫会咬自己的手（本仓库 round13 的 D5/D8 就自伤过一次）。
  const src = read("electron/renderer/netdisk-manager-view.js").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  assert.ok(!/totalGB\s*\|\|\s*"-"/.test(src), "还在用 `totalGB || \"-\"`：0 GB 会显示成 -，且旧值会被当实时值");
  assert.ok(/quotaOk\s*===\s*true/.test(src), "必须显式判 quotaOk===true 才显示数字（undefined=没查过，不能算实时）");
});

test("B2：「刷新账号」绑的是真去查网盘的那个通道，不是只读存档", () => {
  const src = read("electron/renderer/netdisk-manager-view.js");
  assert.match(src, /nmRefreshAccounts"\).addEventListener\([\s\S]{0,120}refreshAccounts/, "刷新按钮仍在调 loadAccounts（点了等于没查）");
  assert.match(src, /rpc\.invoke\("netdisk:accounts:refresh"\)/, "没有调用 netdisk:accounts:refresh");
});

test("B3：新通道在 ipc-channels 与 preload 白名单里都有（少一处就是点下去没反应）", () => {
  const { INVOKE_CHANNELS } = require("../../electron/src/ipc-channels");
  assert.ok(INVOKE_CHANNELS.includes("netdisk:accounts:refresh"), "ipc-channels.js 缺 netdisk:accounts:refresh");
  assert.ok(/"netdisk:accounts:refresh"/.test(read("electron/preload.js")), "preload 白名单缺 netdisk:accounts:refresh");
  assert.match(read("electron/app-context.js"), /ipcMain\.handle\("netdisk:accounts:refresh"/, "主进程缺 handler");
});

test("B4：刷新失败时把失败的号**点名**（静默失败是本仓库最高频的坑）", () => {
  const src = read("electron/renderer/netdisk-manager-view.js");
  assert.ok(/查不到网盘容量/.test(src), "刷新后没有汇总点名失败的账号");
});

// ─────────── C. 已知事实钉在注释里 ───────────

test("C1：/api/quota 已失效这件事必须写在代码注释里（否则下一个人又去调它）", () => {
  const src = read("electron/src/netdisk/manager.js");
  assert.ok(/errno\s*===\s*-6/.test(src) && /api\/list/.test(src), "manager.js 没记录 -6 的对照实验结论");
  assert.match(src, /接口不可用|取不到容量/, "没写清这个接口现在取不到容量");
});
