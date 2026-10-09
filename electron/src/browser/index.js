"use strict";

const { BitBrowserAdapter } = require("./bitbrowser");
const { openHeadless, closeHeadless, cookiesOf } = require("./headless");

/**
 * 指纹浏览器适配器接口：
 *   checkConnection(): Promise<{ok, status}>
 *   open(idOrName):    Promise<{id, cdpUrl}>   打开环境并返回 CDP 调试地址
 *   close(id):         Promise<unknown>
 * 新增 AdsPower / Hubstudio / 普通 Chrome 时实现同一接口即可，业务层零改动。
 */
function createAdapter({ apiUrl } = {}) {
  return new BitBrowserAdapter(apiUrl);
}

/**
 * BrowserPool：按环境名打开/关闭浏览器，支持同环境的重复 acquire 计数，
 * 避免轮换任务里反复 open/close 同一个窗口。
 */
class BrowserPool {
  /**
   * @param adapter 指纹浏览器适配器（比特）
   * @param credentialOf 可选：(envLabel) => { bduss, stoken } | null
   *        提供了、且该环境**存过凭据**时，就改用 headless Edge —— 不开比特窗口。
   *        这是「内存不够的机器也能跑」的关键：比特每个环境是一份完整 Chromium，
   *        headless Edge 小一个量级，而登录态用的是同一份 Cookie。
   */
  constructor(adapter, { credentialOf, mode = "bit" } = {}) {
    this.adapter = adapter;
    this.credentialOf = typeof credentialOf === "function" ? credentialOf : () => null;
    // "bit"（默认）永远走指纹浏览器；"headless" 才用系统 Edge 省内存。
    // **默认必须是 bit**：headless 各环境虽有自己的 user-data-dir，但设备指纹是同一份，
    // 等于把多账号隔离拆掉 —— 那种事只能由用户明确选择，不能悄悄发生。
    //
    // mode 可以是字符串，也可以是**函数**：用户在设置页改了「运行模式」不该要求重启软件，
    // 所以允许传 `() => config.load().browserMode`，每次 acquire 时现读。
    this.modeOf = typeof mode === "function" ? mode : () => (mode === "headless" ? "headless" : "bit");
    this.active = new Map(); // envLabel -> { id, cdpUrl, refCount, headless? }
  }

  async acquire(envLabel) {
    const existing = this.active.get(envLabel);
    if (existing) {
      existing.refCount += 1;
      return { envLabel, cdpUrl: existing.cdpUrl, id: existing.id, name: existing.name || "", reused: true };
    }
    // 存过凭据 → 走 headless Edge，**完全不开比特窗口**。
    // 失败则回落到比特（比如机器上没装 Edge），不让用户卡死。
    const cred = this.credentialOf(envLabel);
    if (this.modeOf() === "headless" && cred && cred.bduss) {
      try {
        const hl = await openHeadless({ envLabel });
        const handle = { id: hl.id, cdpUrl: hl.cdpUrl, name: envLabel, refCount: 1,
          headless: true, proc: hl.proc, userDataDir: hl.userDataDir };
        this.active.set(envLabel, handle);
        // 立刻把凭据注入成 Cookie。**必须跨域整份带** —— 只给 zhidao 域会 errno:3008。
        // 注入完只断开 CDP 连接、**不调 browser.close()**（那会把浏览器一起关掉）。
        const { chromium } = require("playwright-core");
        const b = await chromium.connectOverCDP(hl.cdpUrl);
        const ctx = b.contexts()[0] || (await b.newContext());
        await ctx.addCookies(cookiesOf(cred.bduss, cred.stoken));
        return { envLabel, cdpUrl: handle.cdpUrl, id: handle.id, name: envLabel, reused: false, headless: true };
      } catch (error) {
        console.warn(`[browser] ${envLabel} 启动 headless Edge 失败，回落到比特：${error.message}`);
      }
    }
    const opened = await this.adapter.open(envLabel);
    const handle = { id: opened.id, cdpUrl: opened.cdpUrl, name: opened.name || "", refCount: 1 };
    this.active.set(envLabel, handle);
    return { envLabel, cdpUrl: opened.cdpUrl, id: opened.id, name: handle.name, reused: false };
  }

  async release(envLabel, { close = true } = {}) {
    const handle = this.active.get(envLabel);
    if (!handle) return false;
    handle.refCount -= 1;
    if (handle.refCount > 0) return false;
    this.active.delete(envLabel);
    if (close) {
      if (handle.headless) await closeHeadless(handle).catch(() => {});
      else await this.adapter.close(handle.id).catch(() => {});
    }
    return true;
  }

  async closeAll() {
    for (const [envLabel] of this.active) {
      await this.release(envLabel, { close: true });
    }
  }
}

module.exports = { createAdapter, BrowserPool, BitBrowserAdapter };
