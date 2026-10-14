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
 *
 * ⚠️ 2.0.48 起，"上次没成功"这件事**只有一份状态**：`lastCheckOk / lastCheckWhy / lastCheckAt`
 *（原来是渲染端自己攒的 `error` 字段，主进程不认它，界面一刷新就没了）。
 * 所以下面几条都从这三个字段读。
 */
test("C1 ★ 上次失败：提示条回到可重试形态，而且点一下真的会重试", () => {
  const s = updateBannerState({
    currentVersion: "2.0.46", availableVersion: "2.0.48",
    lastCheckOk: false, lastCheckWhy: "可能是网络问题（更新服务器连不上）",
  });
  assert.equal(s.visible, true);
  assert.equal(s.mode, "available");
  assert.match(s.text, /v2\.0\.48/);
  assert.match(s.text, /没成功/, "必须承认上次失败了，不能装作什么都没发生");
  assert.match(s.text, /点这里重试/);
  // 关键：这一刻点它**确实**会重试（缓存命中就直接 ready，没命中就重下；检查本身也会重试两种方式）——
  // 所以写"点这里重试"是真话，不是安慰话术。
  assert.equal(bannerAction(s.mode), "check");
});

test("C2 ★ 失败原因要截断：不能把一整段报错塞进提示条，也不能留半截括号", () => {
  const long = "x".repeat(200);
  const s = updateBannerState({ availableVersion: "9", lastCheckOk: false, lastCheckWhy: long });
  assert.ok(s.text.length < 160, `提示条被撑爆了（${s.text.length} 字）：${s.text}`);
  assert.match(s.text, /…/, "超长的原因要截断并留省略号");
  const line = updateInfoLine({ availableVersion: "9", lastCheckOk: false, lastCheckWhy: long });
  assert.ok(line.length < 160, `更新页那行也被撑爆了：${line}`);

  // 真实报错长这样（`describeUpdateError` 的输出），括号在**中段**：截断容易把它切成一半。
  // 半截括号看着像手滑；而调用处若再用括号把原因包起来，就成了 `（网络代理连不上（net::…`
  // 这种嵌套。两条都拿真实字符串钉住。
  const real = "网络代理连不上（net::ERR_PROXY_CONNECTION_FAILED），已尝试绕开代理但仍失败，请检查代理设置或稍后再试";
  const bannerText = updateBannerState({ availableVersion: "9", lastCheckOk: false, lastCheckWhy: real }).text;
  assert.ok(!/（[^）]*$/.test(bannerText), `提示条里有没闭合的括号：${bannerText}`);
  assert.ok(!/（[^（]*（/.test(bannerText), `提示条里括号套括号：${bannerText}`);
  assert.match(bannerText, /网络代理连不上/, bannerText);
});

test("C3 没查过（lastCheckOk=null）时不能凭空写出「失败」", () => {
  const s = updateBannerState({ currentVersion: "2.0.46", availableVersion: "2.0.48" });
  assert.ok(!/没成功|失败/.test(s.text), s.text);
  const line = updateInfoLine({ availableVersion: "2.0.48", lastCheckOk: null });
  assert.ok(!/没成功|失败/.test(line), line);
  assert.ok(!/上次检查/.test(line), "没查过就不该出现「上次检查」这一段");
});

test("C4 「软件更新」那行说明也要说出上次失败（否则用户只能自己猜）", () => {
  const line = updateInfoLine({ currentVersion: "2.0.46", availableVersion: "2.0.48", lastCheckOk: false, lastCheckWhy: "代理连不上" });
  assert.match(line, /没成功/);
  assert.match(line, /代理连不上/);
  // 失败原因优先级必须低于"正在下载"：又下起来了就该报进度，而不是还挂着旧错误
  const again = updateInfoLine({ availableVersion: "2.0.48", percent: 7, lastCheckOk: false, lastCheckWhy: "代理连不上" });
  assert.match(again, /正在下载/);
  assert.ok(!/代理连不上/.test(again), "正在下载时不该再挂着上次的失败原因");
});

test("C5 update:error 与 update:checked 都必须同时在 ipc-channels 与 preload 里", () => {
  const channels = read("electron/src/ipc-channels.js");
  const preload = read("electron/preload.js");
  for (const ch of ["update:error", "update:checked"]) {
    assert.match(channels, new RegExp(`LISTENER_CHANNELS\\s*=\\s*\\[[^\\]]*"${ch}"`), `契约里没有 ${ch}`);
    assert.match(preload, new RegExp(`listenerChannels\\s*=\\s*new Set\\(\\[[^\\]]*"${ch}"`),
      `preload 的 listenerChannels 没有 ${ch} —— 主进程发了、界面收不到，且两边都不报错`);
  }
});

test("C6 ★ 两次都没成时，主进程必须显式推 update:error（只清自己的状态是不够的）", () => {
  const src = stripComments(read("electron/app-context.js"));
  const handler = section(src, 'autoUpdater.on("error"', "async function checkForUpdates(");
  assert.match(handler, /downloading = false/, "失败后主进程也要退出「下载中」状态");
  assert.match(handler, /checkRetryDepth > 0/, "重试序列里必须静音，否则一次失败会被播报好几遍");
  // 最终失败的那一次由 checkForUpdates 负责播报（它在重试序列外，且知道是第几次）
  const body = section(src, "async function checkForUpdates(", "async function withProxyMode");
  assert.match(body, /emit\("update:error",\s*\{/,
    "两次都没成时没有推 update:error —— 界面会永远停在「下载中 N%」（且不报错）");
  // 成与不成都要推 update:checked：只推失败那一边的话，用户点完检查更新、界面却停在
  // "当前版本 vX"（没有"上次检查 … 成功"），就又回到"我点了到底查了没"那个问题上
  assert.match(body, /emit\("update:checked",\s*\{\s*ok:\s*true/, "成功那一路没有推 update:checked");
  assert.match(body, /emit\("update:checked",\s*\{\s*ok:\s*false/, "失败那一路没有推 update:checked");
});

test("C7 ★ 渲染端要订阅 update:checked / update:error，并清掉 percent", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  const checked = section(src, 'rpc.on("update:checked"', 'rpc.on("update:error"');
  assert.match(checked, /lastCheckAt:/, "update:checked 要记下检查时刻");
  assert.match(checked, /lastCheckOk:/, "update:checked 要记下成败");
  const failed = section(src, 'rpc.on("update:error"', '$("updateBanner").addEventListener');
  assert.match(failed, /percent:\s*null/, "收到失败必须把 percent 清掉，否则提示条还停在「下载中 42%」");
  assert.match(failed, /renderUpdateUi\(\)/, "收到失败要重画界面");
});

test("C8 新进度 / 已就绪要把上一次的失败提示收掉（旧错误不能盖在新状态上）", () => {
  const src = stripComments(read("electron/renderer/renderer.js"));
  for (const [from, to] of [
    ['rpc.on("update:progress"', 'rpc.on("update:checked"'],
    ['rpc.on("update:ready"', 'rpc.on("update:available"'],
  ]) {
    assert.match(section(src, from, to), /lastCheckWhy:\s*""/, `${from} 这一段没有清掉 lastCheckWhy`);
  }
  // 手动点「检查更新」失败时，上一次的"下载中"也必须清掉
  const check = section(src, '$("checkUpdate").addEventListener', '$("installUpdate").addEventListener');
  assert.match(check, /percent:\s*null/, "检查失败后 percent 没清 → 界面会一直显示上次的下载进度");
  // 而且不要手写文案：失败原因由 update:checked 推过来，统一由 renderUpdateUi 画，
  // 手写一份只会把原因和时间丢掉（用户还得去翻日志）
  assert.ok(!/updateInfo"\)\.textContent = "检查失败/.test(check),
    "不要手写检查失败的文案 —— 原因与时刻要走 update:checked 推过来的那份状态");
});

// ------------------------------------------------------ D 组：一次检查要有答案（2.0.48 补）

/**
 * 用户 17:55 贴的日志：更新检查报 `net::ERR_CONNECTION_RESET`，**同一分钟里连百度知道的
 * 请求也在挂**（`⚠️ 搜索失败（跳过）… — fetch failed`）——整台机器的网络当时在抖。
 * 两件事要修：
 *   ① 一次失败就彻底放弃 → 现在"当前设置 → 临时直连"各试一次，启动那次失败还会 10 分钟后再试一次；
 *   ② 界面上**看不出来**失败过 → 现在记"上次检查 HH:MM 成功/没成功（原因）"，并随 update:info 复原。
 */
test("D1 ★ 启动时的自动检查失败后要自动再试一次，而且只再试一次", () => {
  const src = stripComments(read("electron/app-context.js"));
  assert.match(src, /function scheduleStartupCheck\(/, "启动检查要有个可自我重排的函数");
  const body = section(src, "function scheduleStartupCheck(", "scheduleStartupCheck({ first: true })");
  assert.match(body, /if\s*\(first\)/, "要区分第一次和重试，否则会无限重排下去");
  assert.match(body, /scheduleStartupCheck\(\{\s*first:\s*false\s*\}\)/, "第一次失败后要排一次重试");
  // 重试那一支里**不许**再排下一次 —— 网络真断了的时候，隔十分钟弹一次是骚扰
  const retryBranch = body.slice(body.indexOf("} else {"), body.indexOf("});"));
  assert.ok(!/scheduleStartupCheck\(/.test(retryBranch), "重试分支里不能再排重试，会无限循环");
  // 间隔常量可能写成算式（`10 * 60 * 1000`），所以求值而不是抠数字
  const rhs = src.match(/STARTUP_RETRY_DELAY_MS\s*=\s*([^;]+);/)[1];
  const ms = Function(`"use strict"; return (${rhs});`)();
  assert.ok(ms >= 60000, `重试间隔太短（${ms}ms，应在分钟级）`);
});

test("D2 ★ 一次失败不能报两遍（electron-updater 既 emit 又 throw，实测）", () => {
  const src = stripComments(read("electron/app-context.js"));
  const startup = section(src, "function scheduleStartupCheck(", "scheduleStartupCheck({ first: true })");
  // 启动那一路以前把原因又抄了一遍（`启动检查更新失败：…` + `原因摘要：…`），
  // 于是用户贴过来的日志里一次失败出现两遍，看着像坏了两次。
  assert.ok(!/原因摘要/.test(startup), "启动路径不该再重复报一遍原因 —— checkForUpdates 已经写过了");
  assert.match(startup, /describeUpdateError/, "启动路径只需要补一句「不影响使用 + 稍后会再试」");
});

test("D3 ★ update:info 要带 lastCheck，界面刷新后能复原「上次检查」", () => {
  const src = stripComments(read("electron/app-context.js"));
  assert.match(src, /lastCheck:\s*\{\s*at:\s*lastCheckAt/, "update:info 没带 lastCheck");
  const r = stripComments(read("electron/renderer/renderer.js"));
  assert.match(r, /i\.lastCheck/, "渲染端没从 update:info 里读 lastCheck");
  assert.match(r, /lastCheckAt:\s*check\.at/, "渲染端没复原检查时刻");
});

test("D4 「上次检查 HH:MM 成功/没成功」两种都要能显示出来", () => {
  assert.match(updateInfoLine({ currentVersion: "2.0.47", lastCheckAt: "17:58", lastCheckOk: true }),
    /上次检查 17:58 成功/);
  assert.match(updateInfoLine({ currentVersion: "2.0.47", lastCheckAt: "17:55", lastCheckOk: false, lastCheckWhy: "网络问题" }),
    /上次检查 17:55 没成功：网络问题/);
  // 关键：**没有新版本、也没在下载**的时候也要显示 —— 这正是"我点了检查更新，它到底查了没"的场景
  assert.match(updateInfoLine({ currentVersion: "2.0.47", lastCheckAt: "17:58", lastCheckOk: true }),
    /当前版本 v2\.0\.47/);
  // ⚠️ 原因自己就带括号（`可能是网络问题（更新服务器连不上）`），尾巴**不能**再用括号包它，
  // 否则就是括号套括号（之前正是这么显示的）
  const real = updateInfoLine({ currentVersion: "2.0.47", lastCheckAt: "17:55", lastCheckOk: false, lastCheckWhy: "可能是网络问题（更新服务器连不上）" });
  assert.ok(!/（[^（）]*（/.test(real), `括号套括号了：${real}`);
  assert.match(real, /更新服务器连不上/);
});

test("D5 ★ 取「时:分」不能用切下标（zh-CN 的月日不补零，只在每月 1~9 号出错）", () => {
  const { nowTimeText, nowText } = require("../../electron/src/config.js");
  assert.match(nowTimeText(), /^\d{1,2}:\d{2}$/, `nowTimeText 输出不像时刻：${nowTimeText()}`);
  // ⚠️ 这条规则只在**每月 1~9 号**才会出错（月日不补零 → 字符串短一位 → 下标整体错位），
  // 所以必须拿那一天来测，否则平时怎么跑都是绿的。nowTimeText(text) 就是为此留的口子。
  assert.equal(nowTimeText("2026/10/4 7:55:36"), "7:55", "月日不补零的那天取错了");
  assert.equal(nowTimeText("2026/10/14 17:55:36"), "17:55");
  // 小时不补零时也不能靠"取前 5 个字符"（`7:55:` 就是这么切出来的，写完自测当场踩到）
  assert.notEqual(nowTimeText("2026/10/4 7:55:36"), "7:55:", "又用 slice(0,5) 硬切了 —— 小时不补零时会多出一个冒号");
  // 传进来的根本不是时间 → 空串，不许把日期当时刻拼进文案
  assert.equal(nowTimeText("2026/10/4"), "");
  // 顺便把"切下标为什么错"钉在测试里：同一天，两种写法结果不同
  assert.notEqual(nowTimeText("2026/10/4 7:55:36"), "2026/10/4 7:55:36".slice(11, 16),
    "切下标的写法在月日不补零时应该给出错误结果 —— 如果这里相等了，说明假数据没起到作用");
  const src = read("electron/app-context.js");
  assert.ok(!/nowText\(\)\.slice\(11/.test(src), "又用 nowText().slice(11,16) 硬切时刻了");
  // 同时钉住 nowText 确实是那个"不补零"的格式，免得以后有人以为它补零而删掉这个口子
  assert.match(nowText(), /^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/, nowText());
});

// ------------------------------------------------------ E 组：文案不许括号套括号（2.0.48 补）

/**
 * 「把一句自带括号的话再套一层括号」这个坑，本仓库已经踩了**三次**：
 *   ① 提示条：`（网络代理连不上（net::ERR_PROXY_CONNECTION_FAILED）`
 *   ② 更新页那行：同上
 *   ③ 启动日志：`本次启动的自动检查没成功（可能是网络问题（更新服务器连不上））`
 * 三次都是同一个成因：`describeUpdateError()` 的输出**自己就带全角括号**
 *（它的文案就是 `可能是网络问题（更新服务器连不上）` / `系统代理连不上（…）`），
 * 调用处再包一层就套上了。所以改成机械检查：更新这一整块里，
 * **不许出现"用括号把 describeUpdateError/why/message 包起来"的写法**。
 */
test("E1 ★ 更新相关文案不许把 describeUpdateError 的输出再用括号包一层", () => {
  const src = stripComments(read("electron/app-context.js"));
  const patterns = [
    [/（\$\{describeUpdateError/, "（${describeUpdateError(...)}）"],
    [/（\$\{why\}/, "（${why}）"],
    [/（\$\{message\}/, "（${message}）"],
  ];
  for (const [re, shown] of patterns) {
    assert.ok(!re.test(src), `又出现括号套括号的写法：${shown} —— describeUpdateError 的文案自带括号，请改用「：」引出`);
  }
});

test("E2 describeUpdateError 的文案本身真的带括号（E1 这条规则的前提，别以后被改掉）", () => {
  // 如果哪天这些文案改成不带括号了，E1 那条规则就该重新考虑 —— 所以把前提钉住
  const { describeUpdateError } = require("../../electron/src/errors");
  assert.match(describeUpdateError("net::ERR_PROXY_CONNECTION_FAILED"), /（[^）]+）/,
    "代理错误的人话里带括号 —— 这正是调用处不能用括号包它的原因");
  assert.match(describeUpdateError("ETIMEDOUT"), /（[^）]+）/,
    "网络错误的人话里也带括号");
});

test("E3 源码里所有「上次检查」的尾巴都用「：」引出原因", () => {
  // ⚠️ 必须剥注释再扫：这个模块的 JSDoc 里**正当地**举了反面例子（`没成功（…）`），
  // 不剥的话守卫会咬自己的手（本仓库已经因为这点误报过 4 次）。
  const src = stripComments(read("electron/src/update-banner.js"));
  assert.match(src, /没成功\$\{why \? `：\$\{why\}`/, "lastCheckTail 应该用「：」引出原因");
  assert.ok(!/没成功（/.test(src), "lastCheckTail 又用括号包原因了");
});

// ------------------------------------------------------ F 组：发版门禁（2.0.48 补）

/**
 * 之前每轮发版我都是手敲一段 `node -e` 来核对 sha512/版本号/指纹，结果这一轮被 shell
 * 吃掉反斜杠吃了两次（`\s` 变成 `s`，脚本直接语法错误）。既然是**每轮必做**的固定动作，
 * 就该是个脚本、而且是能一键跑的门禁。
 */
test("F1 发版校验脚本要在，而且要挂在 npm scripts 上", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["verify:release"], "node scripts/verify-release.js",
    "npm run verify:release 必须存在 —— 这是每轮发版必做的三条硬校验");
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "verify-release.js")), "找不到 scripts/verify-release.js");
});

test("F2 发版校验脚本要真的查那三件事（sha512 / 版本号 / 三件套指纹）", () => {
  const src = read("scripts/verify-release.js");
  assert.match(src, /sha512/, "要核对 sha512 —— 对不上就是「发了但更新不了」且不报错");
  assert.match(src, /sha256/, "要打出三件套指纹，用来和 GitHub 的 assets[].digest 比对");
  assert.match(src, /pkg\.version/, "版本号要取自 package.json（不 bump 版本号客户端会认为已是最新）");
  assert.match(src, /latest\.yml/, "要读 latest.yml");
});

test("F3 发版校验脚本不许把仓库地址打出来（用户明确要求地址不外泄）", () => {
  const src = stripComments(read("scripts/verify-release.js"));
  assert.ok(!/github\.com\/[A-Za-z0-9]/.test(src),
    "脚本里不许出现真实的仓库坐标（提示性文字里写 <owner>/<repo> 这种占位是允许的）");
  assert.ok(!/66666666218/.test(src), "不许出现仓库所有者");
});
