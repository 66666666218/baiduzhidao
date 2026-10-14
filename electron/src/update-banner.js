"use strict";

/**
 * 「顶部更新提示条显示什么、点了干什么」+「软件更新页那行说明文字」—— **唯一一份规则**。
 *
 * ── 为什么要有这个模块（2026-10-14 用户反馈「点击检查更新并不能更新」）──
 * 更新链路本身**没坏**：查到了 2.0.45、也开始下载了（实测下载缓存里确实出现了完整的
 * `zhidao-answer-studio-2.0.45.exe`，sha512 与 latest.yml 一字不差），是我这边的界面把它做成了"没反应"：
 *   ① **下载全程界面一个字都不说**：进度只写进运行日志（而且每 20% 才一行），
 *      用户点完「检查更新」/顶部提示条之后，界面上仍然只有「当前版本 v2.0.44」——
 *      下载 85MB 要好几分钟，看起来当然像"点了没用"。
 *   ② **下载完成之后提示条不回来**：用户是从顶部提示条点进去的，而那个条在点击时就 `hidden = true` 了；
 *      下载完成只在「使用教程 → 软件更新」那一页改两个字。用户压根没在那页，于是干了什么都不知道。
 *   ③ **更新过程不进日志文件**：这些文案之前用的是 `emit("task:log", …)`（只发渲染端的日志面板），
 *      而 `logger.log` 既进文件又进面板 —— 结果用户把日志发给我时，里面**一个字都没有更新记录**
 *      （我自己查这个问题时就是这样，只能去翻 electron-updater 的下载缓存才看清它其实成功了）。
 *
 * 所以：文案与"点了干什么"必须集中在一个能被单测直接打的纯函数里（`app-context.js`/`renderer.js`
 * 两边都 require/加载不动 electron，靠"扫文本"验证读不出逻辑 —— 这条教训上一轮刚写过）。
 *
 * 写法说明：这个文件同时被 **主进程/测试（CommonJS）** 和 **渲染端（`<script>` 全局）** 使用，
 * 所以用 UMD 那种双出口；渲染端拿到的是 `window.UpdateBanner`。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UpdateBanner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  /** 统一成"非空字符串"，避免出现 `vundefined` */
  const str = (value) => (value === undefined || value === null ? "" : String(value).trim());

  /** 字节 → MB（拿不到就给 0，别在界面里显示 NaN） */
  function mb(bytes) {
    const n = Number(bytes);
    return Number.isFinite(n) && n > 0 ? Math.round(n / 1048576) : 0;
  }

  /** 把进度夹到 0~100 的整数（拿不到就给 null，表示"还不知道进度"） */
  function percentOf(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /** 「36/82 MB」这种大小说明；两边都拿不到就不显示（宁可不显示也不显示 0/0） */
  function sizeText(state) {
    const done = mb(state.transferred);
    const total = mb(state.total);
    if (!total) return "";
    return `（${done}/${total} MB）`;
  }

  /**
   * 失败原因压成一小段。
   *
   * 渲染端拿到的已经是 `describeUpdateError()` 翻译过的人话，但完整原因可能很长
   *（比如带上路径与 URL），提示条塞不下，所以按长度截断，完整版在运行日志里。
   *
   * ⚠️ 两个坑（都是拿真实报错跑出来才看见的）：
   *   ① **截断可能把括号切成一半**：`网络代理连不上（net::ERR_PROXY_CONNECTE` —— 半截括号
   *      看着像手滑。所以截断后要退回到最后一个"括号配平"的位置。
   *   ② 所以调用处**不再用括号把原因包起来**（原因自己常常就带括号，套起来就是
   *      `（网络代理连不上（net::ERR_…）` 这种嵌套），改用「：」分隔。
   */
  function briefError(error) {
    const text = str(error).replace(/\s+/g, " ");
    if (!text) return "";
    if (text.length <= 40) return text;
    return `${text.slice(0, balancedCut(text, 40))}…`;
  }

  /**
   * 从左往右数括号，返回"到哪个位置为止括号是配平的"。
   * 多出来的右括号（`）`走在 `（` 前面）直接忽略，它们不会造成半截括号的观感。
   */
  function balancedCut(text, limit) {
    const OPEN = "（(【";
    const CLOSE = "）)】";
    const stack = [];
    for (let i = 0; i < limit; i += 1) {
      const ch = text[i];
      if (OPEN.includes(ch)) stack.push(i);
      else if (CLOSE.includes(ch)) stack.pop();
    }
    // 有没闭合的开括号 → 退到它前面，宁可少说几个字也不留半截括号
    return stack.length ? stack[0] : limit;
  }

  /**
   * 顶部提示条该显示什么。
   *
   * @param {object} state
   * @param {string} state.currentVersion 当前版本
   * @param {string} state.availableVersion 已发现有新版但还没下完（下载中也是它）
   * @param {boolean} [state.ready] 新版是否已下载完成（主进程的权威布尔值）
   * @param {string} [state.readyVersion] 已下载好的版本号（拿不到就给空，文案会自动省掉它）
   * @param {number} [state.percent] 下载百分比（没有就是还没开始下）
   * @param {number} [state.transferred] 已下载字节
   * @param {number} [state.total] 总字节
   * @param {string} [state.error] 上一次下载/检查失败的原因（渲染端收到 `update:error` 时记下来）
   * @returns {{visible:boolean, mode:"none"|"available"|"downloading"|"ready", text:string}}
   */
  function updateBannerState(state) {
    const s = state || {};
    const current = str(s.currentVersion);
    const available = str(s.availableVersion);
    const ready = str(s.readyVersion);

    // ① 已下载完成 —— 提示条必须**重新出现**，而且点一下就该装（不再让人去找别的页面）
    if (s.ready || ready) {
      return {
        visible: true,
        mode: "ready",
        // 版本号拿不到时省掉它，不要写出「新版 v 已下载完成」这种半截话
        text: `✅ 新版${ready ? ` v${ready}` : ""}已下载完成 —— 点这里立即重启并安装（也可以直接关掉软件，下次打开就是新版）`,
      };
    }

    const percent = percentOf(s.percent);
    // ② 下载中 —— 给进度。**整句里不许出现"点这里"**：这一刻点它什么也不会发生，
    //    写了"点这里"而点不动，就又是一次"界面在撒谎"。（所以这里说的是"会出现按钮"，不是"点这里"。）
    if (available && percent !== null) {
      return {
        visible: true,
        mode: "downloading",
        text: `⬇️ 新版本 v${available} 下载中 ${percent}%${sizeText(s)}… 下载完成后这里会出现「重启并安装」按钮`,
      };
    }

    // ③ 只查到有新版本，还没开始下。
    //    注意"上次失败过"也要走这一支：此时 percent 是空的、确实没在下，而**
    //    点一下确实会重试**（缓存命中就直接 ready，没命中就重下）—— 所以"点这里重试"是真话。
    if (available) {
      if (briefError(s.error)) {
        return {
          visible: true,
          mode: "available",
          text: `⚠️ 新版 v${available} 上次没下载成功：${briefError(s.error)} —— 点这里重试`,
        };
      }
      return {
        visible: true,
        mode: "available",
        text: `🔔 发现新版本 v${available}（当前 v${current || "?"}）—— 点这里下载并安装`,
      };
    }

    return { visible: false, mode: "none", text: "" };
  }

  /** 点提示条该干什么：查/下载、立刻安装、还是什么都不做（下载中） */
  function bannerAction(mode) {
    if (mode === "ready") return "install";
    if (mode === "available") return "check";
    return "none";
  }

  /**
   * 「软件更新」那一页的说明文字（原来只有 applyUpdateInfo/update:ready 两处各写一份，
   * 下载中那一整段时间是空白的）。
   *
   * `state.error` 是"上一次下载/检查失败的原因"（渲染端收到 `update:error` 时记下来的）。
   * 有它的时候必须说出来 —— 否则用户看到提示条从"下载中 42%"变回"发现新版本"，会以为
   * 是自己看错了，然后再点一次、再失败一次。报错要短（太长的原因留给运行日志）。
   */
  function updateInfoLine(state, extra) {
    const s = state || {};
    const e = extra || {};
    const current = str(s.currentVersion);
    const available = str(s.availableVersion);
    const ready = str(s.readyVersion);
    const base = `当前版本 v${current || "?"}`;

    if (e.supported === false) return `${base}（开发模式不支持在线更新）`;
    if (s.ready || ready) {
      return `新版${ready ? ` v${ready}` : ""}已下载完成：点右边「重启并安装新版」，或直接关闭软件（下次打开就是新版）`;
    }
    const percent = percentOf(s.percent);
    if (available && percent !== null) return `正在下载 v${available}：${percent}%${sizeText(s)}`;
    if (available) {
      const why = briefError(s.error);
      if (why) return `上次下载 v${available} 没成功：${why} —— 点「检查更新」重试`;
      return `发现新版本 v${available}，点「检查更新」开始下载（约 85MB）`;
    }
    return base;
  }

  return { updateBannerState, bannerAction, updateInfoLine };
});
