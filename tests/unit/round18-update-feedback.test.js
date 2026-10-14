"use strict";

/**
 * 第 18 轮：**「点击检查更新并不能更新」**（用户 2026-10-14 反馈）的回归测试。
 *
 * 先摆事实：更新链路**没有坏**。我把用户机器上的更新缓存翻出来看，
 * `%LOCALAPPDATA%\zhidao-answer-studio-updater\pending\zhidao-answer-studio-2.0.45.exe`
 * 是**完整的 85,839,553 字节**，sha512 与 `latest.yml` 里的一字不差 —— 它其实下载成功了。
 * 是界面把它做成了"没反应"，三处叠加：
 *   ① 下载全程界面一个字都不说（进度只写运行日志，还是每 20% 才一行）。85MB 要下好几分钟。
 *   ② 用户是从**顶部提示条**点进去的，而那个条在点击瞬间就 `hidden = true` 了；
 *      下载完成只在「使用教程 → 软件更新」那一页改两个字，用户没在那页 → 干了什么完全不知道。
 *   ③ 这些文案当时用的是 `emit("task:log", …)`，只发渲染端的日志面板、**不进日志文件** ——
 *      于是用户把日志发给我时里面一个字都没有更新记录，我只能去翻下载缓存才知道它成功了。
 *
 * 所以这一轮的守卫分三块：规则本身（纯函数）、通道契约、以及"不许再沉默"的接线。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { updateBannerState, bannerAction, updateInfoLine } = require("../../electron/src/update-banner");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * 剥注释（保字符串）。⚠️ 必须先剥行注释、再剥块注释：
 * 被扫文件里若有 `// 脚本类工具（scripts/*.js）` 这种行注释含块注释起始符，
 * 先剥块注释会一路吃到下一个结束符，把中间的真实代码整段吞掉（本仓库踩过）。
 * 注释里想写块注释符号只能像上面这样用中文描述。
 */
function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 切出一段源码（按起止标记），用来只扫"更新"那一块。
 *
 * ⚠️ 起止标记都必须是**真实代码**里的字符串，不能落在注释里 —— `stripComments` 之后
 * 注释里的标记就不存在了，`indexOf` 返回 -1，切片会一路扫到文件末尾
 *（本文件第一次跑就是这么"通过"到结尾、把启动检查那三行也扫进来误报的）。
 * 所以这里对两个标记都要求找到，找不到直接抛 —— 守卫宁可当场炸，也不要静默扩大范围。
 */
function section(src, from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `源码里找不到起始标记（它是不是写在注释里了？）：${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `源码里找不到结束标记（它是不是写在注释里了？）：${to}`);
  return src.slice(start, end);
}

// ------------------------------------------------------ A 组：规则本身

test("A1 什么都没查到：提示条不显示（不能挂一条空提示在那儿）", () => {
  const s = updateBannerState({ currentVersion: "2.0.45" });
  assert.equal(s.visible, false);
  assert.equal(s.mode, "none");
});

test("A2 查到新版本：显示「点这里下载」，并带上当前版本", () => {
  const s = updateBannerState({ currentVersion: "2.0.45", availableVersion: "2.0.46" });
  assert.equal(s.visible, true);
  assert.equal(s.mode, "available");
  assert.match(s.text, /v2\.0\.46/);
  assert.match(s.text, /v2\.0\.45/);
  assert.match(s.text, /点这里下载/);
  assert.equal(bannerAction(s.mode), "check");
});

test("A3 ★ 下载中：必须报出百分比与体积，而且**不许写「点这里」**", () => {
  const s = updateBannerState({
    currentVersion: "2.0.45", availableVersion: "2.0.46",
    percent: 42, transferred: 36 * 1048576, total: 82 * 1048576,
  });
  assert.equal(s.visible, true);
  assert.equal(s.mode, "downloading");
  assert.match(s.text, /下载中 42%/);
  assert.match(s.text, /36\/82 MB/);
  // 这一刻点它什么也不会发生。写了"点这里"却点不动，就是又一次"界面在撒谎"。
  assert.ok(!/点这里/.test(s.text), `下载中的文案不能出现"点这里"：${s.text}`);
  assert.equal(bannerAction(s.mode), "none", "下载中点提示条不该触发任何动作");
});

test("A4 ★ 下载完成：提示条必须重新出现，且文案直接给「点这里立即重启并安装」", () => {
  const s = updateBannerState({ currentVersion: "2.0.45", ready: true, readyVersion: "2.0.46" });
  assert.equal(s.visible, true, "用户是从提示条点进去下载的，下完不回来 = 他不知道发生了什么");
  assert.equal(s.mode, "ready");
  assert.match(s.text, /v2\.0\.46/);
  assert.match(s.text, /已下载完成/);
  assert.match(s.text, /点这里立即重启并安装/);
  assert.match(s.text, /关掉软件/, "必须把「关掉软件也会自动装」这条兜底告诉用户");
  assert.equal(bannerAction(s.mode), "install");
});

test("A5 ready 但没有版本号时，不能写出「新版 v 已下载完成」这种半截话", () => {
  const s = updateBannerState({ currentVersion: "2.0.45", ready: true });
  assert.equal(s.mode, "ready");
  assert.ok(!/v\s*已下载/.test(s.text), s.text);
  assert.ok(!/undefined|NaN/.test(s.text), s.text);
});

test("A6 百分比要夹在 0~100，且非数字不能当成「正在下载」", () => {
  assert.match(updateBannerState({ availableVersion: "9", percent: 150 }).text, /100%/);
  assert.match(updateBannerState({ availableVersion: "9", percent: -5 }).text, /0%/);
  // 拿不到百分比 → 退回"查到新版本"那一档，而不是显示"下载中 NaN%"
  const nan = updateBannerState({ availableVersion: "9", percent: Number.NaN });
  assert.equal(nan.mode, "available");
  assert.ok(!/NaN/.test(nan.text));
});

test("A7 提示条动作只认三种：ready→install / available→check / 其余→none", () => {
  assert.equal(bannerAction("ready"), "install");
  assert.equal(bannerAction("available"), "check");
  assert.equal(bannerAction("downloading"), "none");
  assert.equal(bannerAction("none"), "none");
  assert.equal(bannerAction(undefined), "none");
});

test("A8 「软件更新」那行说明文字：开发模式/已就绪/下载中/有新版本 各说各的话", () => {
  assert.match(updateInfoLine({ currentVersion: "2.0.45" }, { supported: false }), /开发模式不支持在线更新/);
  assert.match(updateInfoLine({ ready: true, readyVersion: "2.0.46" }), /已下载完成/);
  assert.match(updateInfoLine({ availableVersion: "2.0.46", percent: 7, total: 82 * 1048576 }), /正在下载 v2\.0\.46：7%/);
  assert.match(updateInfoLine({ availableVersion: "2.0.46" }), /点「检查更新」开始下载/);
  assert.equal(updateInfoLine({ currentVersion: "2.0.45" }), "当前版本 v2.0.45");
});

// ------------------------------------------------------ B 组：通道与接线

test("A9 ★ 渲染端（没有 CommonJS 的环境）必须能拿到全局 UpdateBanner，且规则和主进程那份一致", () => {
  const src = read("electron/src/update-banner.js");
  // 这个文件用 UMD 双出口：主进程/测试走 module.exports，渲染端走全局。
  // 分支写错的后果是**静默的**：window.UpdateBanner 是 undefined，渲染端一读就 TypeError，
  // 而主进程那边完全正常 —— 所以这里真的在"没有 module 的沙箱"里跑一遍。
  const sandbox = { self: {} };
  vm.runInNewContext(src, sandbox);
  const global = sandbox.self.UpdateBanner;
  assert.equal(typeof global, "object", "UMD 没挂到全局 —— index.html 里那个 <script> 等于没加");
  assert.equal(typeof global.updateBannerState, "function");
  assert.equal(typeof global.bannerAction, "function");
  assert.equal(typeof global.updateInfoLine, "function");
  // 与 CommonJS 那份是同一套规则（不是两处各写一份）
  assert.deepEqual(
    global.updateBannerState({ availableVersion: "9", percent: 12 }),
    updateBannerState({ availableVersion: "9", percent: 12 })
  );
});

test("B1 update:progress 必须同时在 ipc-channels 与 preload 里（漏一边 = 主进程发、界面收不到且不报错）", () => {
  const channels = read("electron/src/ipc-channels.js");
  const preload = read("electron/preload.js");
  assert.match(channels, /LISTENER_CHANNELS\s*=\s*\[[^\]]*"update:progress"/,
    "契约里没有 update:progress");
  assert.match(preload, /listenerChannels\s*=\s*new Set\(\[[^\]]*"update:progress"/,
    "preload 的 listenerChannels 没有 update:progress —— 渲染端会收不到进度（且不报错）");
});

test("B2 ★ 更新过程的文案必须进日志文件（不许再用只发渲染端的 emit）", () => {
  const src = stripComments(read("electron/app-context.js"));
  // 区段一直盖到 `app:data-dir` 注册处，把「启动静默检查失败」那三行也包进来 ——
  // 它们和下载日志是同一类问题（只在界面显示、不进文件，用户报问题时等于没有线索）。
  const block = section(src, "let updateReady = false", "ipcMain.handle(\"app:data-dir\"");
  assert.ok(!/emit\("task:log"/.test(block),
    "更新这一块又用回了 emit(\"task:log\", …)：它只进渲染端的日志面板、不进日志文件 —— "
    + "用户把日志发过来时里面一个字都没有更新记录（本轮就是这么瞎猜了半天的）");
  assert.match(block, /logger\.log\(/, "更新文案必须走 logger.log（既进文件又进面板）");
});

test("B3 主进程要把进度推给界面，并在 update:info 里给出已下载的版本号", () => {
  const src = read("electron/app-context.js");
  assert.match(src, /emit\("update:progress",\s*\{/, "没有把下载进度推给界面，那界面就还是全程空白");
  assert.match(src, /readyVersion:\s*updateReadyVersion/,
    "update:info 只给布尔值 ready 的话，界面没法说清「哪个版本已下载好」");
  assert.match(src, /downloading,/, "update:info 要能复原「正在下载」这个状态（界面刷新后会用到）");
});

test("B4 ★ 提示条点了要按规则走：ready 时直接安装，不能又去「检查更新」一次", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  assert.match(src, /U\.updateBannerState\(/, "提示条文案必须来自共享规则模块，不能在渲染端手抄一份");
  assert.match(src, /U\.bannerAction\(/, "点了干什么必须来自共享规则模块");
  const handler = section(src, '$("updateBanner").addEventListener', '$("checkUpdate").addEventListener');
  assert.match(handler, /action === "install"[\s\S]{0,200}installUpdate/, 
    "ready 状态下点提示条必须走安装（以前是「再检查一次更新」，用户点了会觉得毫无反应）");
  assert.match(src, /rpc\.on\("update:progress"/, "渲染端没订阅 update:progress");
});

test("B5 index.html 必须先加载 update-banner.js（顺序反了 window.UpdateBanner 是 undefined，整个渲染端会崩）", () => {
  const html = read("electron/renderer/index.html");
  const iBanner = html.indexOf("src=\"../src/update-banner.js\"");
  const iRenderer = html.indexOf("src=\"renderer.js\"");
  assert.ok(iBanner > 0, "index.html 没有挂 src/update-banner.js");
  assert.ok(iBanner < iRenderer, "update-banner.js 必须排在 renderer.js 之前");
});

// ------------------------------------------------------ C 组：失败也要说话（2.0.47 补）

/**
 * 2.0.46 修完"下载中没有任何反馈"之后，**同一个病换了张脸**冒出来：
 * 主进程在 `autoUpdater.on("error")` 里把 `downloading` 清了，但界面用的是自己那份
 * `updateState` —— 只有收到推送才会重画。于是下载到 42% 撞上代理断掉之后，
 * 提示条会**永远**停在「⬇️ 下载中 42%」，一动不动，而且不报错。
 * 用户的环境（开着系统代理）恰恰最容易撞上这条路径。
 */
test("C1 ★ 上次失败：提示条回到可重试形态，而且点一下真的会重试", () => {
  const s = updateBannerState({ currentVersion: "2.0.45", availableVersion: "2.0.46", error: "下载超时" });
  assert.equal(s.visible, true);
  assert.equal(s.mode, "available");
  assert.match(s.text, /v2\.0\.46/);
  assert.match(s.text, /没下载成功/, "必须承认上次失败了，不能装作什么都没发生");
  assert.match(s.text, /下载超时/, "要带上原因，否则用户只能反复重试");
  assert.match(s.text, /点这里重试/);
  // 关键：这一刻点它**确实**会重试（缓存命中就直接 ready，没命中就重下）——
  // 所以写"点这里重试"是真话，不是安慰话术。
  assert.equal(bannerAction(s.mode), "check");
});

test("C2 ★ 失败原因要截断：不能把一整段报错塞进提示条，也不能留半截括号", () => {
  const long = "x".repeat(200);
  const s = updateBannerState({ availableVersion: "9", error: long });
  assert.ok(s.text.length < 140, `提示条被撑爆了（${s.text.length} 字）：${s.text}`);
  assert.match(s.text, /…/, "超长的原因要截断并留省略号");
  const line = updateInfoLine({ availableVersion: "9", error: long });
  assert.ok(line.length < 140, `更新页那行也被撑爆了：${line}`);

  // 真实报错长这样（`describeUpdateError` 的输出），括号在**中段**：截断容易把它切成一半。
  // 半截括号看着像手滑；而调用处若再用括号把原因包起来，就成了 `（网络代理连不上（net::…`
  // 这种嵌套。两条都拿真实字符串钉住。
  const real = "网络代理连不上（net::ERR_PROXY_CONNECTION_FAILED），已尝试绕开代理但仍失败，请检查代理设置或稍后再试";
  const bannerText = updateBannerState({ availableVersion: "9", error: real }).text;
  assert.ok(!/（[^）]*$/.test(bannerText), `提示条里有没闭合的括号：${bannerText}`);
  assert.ok(!/（[^（]*（/.test(bannerText), `提示条里括号套括号：${bannerText}`);
  assert.match(bannerText, /网络代理连不上/, bannerText);
});

test("C3 没有 error 时不能凭空写出「没下载成功」", () => {
  const s = updateBannerState({ currentVersion: "2.0.45", availableVersion: "2.0.46" });
  assert.ok(!/没下载成功|失败/.test(s.text), s.text);
  assert.ok(!/失败/.test(updateInfoLine({ availableVersion: "2.0.46" })));
});

test("C4 「软件更新」那行说明也要说出上次失败（否则用户只能自己猜）", () => {
  const line = updateInfoLine({ currentVersion: "2.0.45", availableVersion: "2.0.46", error: "代理连不上" });
  assert.match(line, /没成功/);
  assert.match(line, /代理连不上/);
  assert.match(line, /重试/);
  // 失败原因优先级必须低于"正在下载"：又下起来了就该报进度，而不是还挂着旧错误
  const again = updateInfoLine({ availableVersion: "2.0.46", percent: 7, error: "代理连不上" });
  assert.match(again, /正在下载/);
});

test("C5 update:error 必须同时在 ipc-channels 与 preload 里（漏一边 = 主进程发了界面收不到且不报错）", () => {
  const channels = read("electron/src/ipc-channels.js");
  const preload = read("electron/preload.js");
  assert.match(channels, /LISTENER_CHANNELS\s*=\s*\[[^\]]*"update:error"/,
    "契约里没有 update:error");
  assert.match(preload, /listenerChannels\s*=\s*new Set\(\[[^\]]*"update:error"/,
    "preload 的 listenerChannels 没有 update:error —— 界面会永远停在某个下载百分比上（且不报错）");
});

test("C6 ★ 主进程失败时必须显式推 update:error，只清自己的状态是不够的", () => {
  const src = stripComments(read("electron/app-context.js"));
  // 区段 = 从 error 分支开始，到下一个真实代码标记（检查更新函数）为止。
  const handler = section(src, "autoUpdater.on(\"error\"", "async function checkForUpdates({ download })");
  assert.match(handler, /emit\("update:error",\s*\{/,
    "error 分支只改了主进程的 downloading/downloadPercent，没通知界面 —— "
    + "界面用的是自己那份 updateState，会永远停在「下载中 N%」");
  assert.match(handler, /downloading = false/, "失败后主进程也要退出「下载中」状态");
});

test("C7 渲染端要订阅 update:error，并清掉 percent（只改文案不清状态 = 下次还会接着显示旧百分比）", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  const handler = section(src, 'rpc.on("update:error"', '$("updateBanner").addEventListener');
  assert.match(handler, /percent:\s*null/, "收到失败必须把 percent 清掉，否则提示条还停在「下载中 42%」");
  assert.match(handler, /renderUpdateUi\(\)/, "收到失败要重画界面");
});

test("C8 新进度/新版本/已就绪都要把上一次的失败提示收掉（旧错误不能盖在新状态上）", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  const zones = [
    ['rpc.on("update:ready"', 'rpc.on("update:available"'],
    ['rpc.on("update:available"', 'rpc.on("update:progress"'],
    ['rpc.on("update:progress"', 'rpc.on("update:error"'],
  ];
  for (const [from, to] of zones) {
    assert.match(section(src, from, to), /error:\s*""/, `${from} 这一段没有清掉 error`);
  }
  // 手动点「检查更新」失败时，上一次的"下载中"也必须清掉
  const check = section(src, '$("checkUpdate").addEventListener', '$("installUpdate").addEventListener');
  assert.match(check, /percent:\s*null/, "检查失败后 percent 没清 → 界面会一直显示上次的下载进度");
});
