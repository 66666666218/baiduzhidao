"use strict";

const { BitBrowserAdapter } = require("./bitbrowser");

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
  constructor(adapter) {
    this.adapter = adapter;
    this.active = new Map(); // envLabel -> { id, cdpUrl, refCount }
  }

  async acquire(envLabel) {
    const existing = this.active.get(envLabel);
    if (existing) {
      existing.refCount += 1;
      return { envLabel, cdpUrl: existing.cdpUrl, id: existing.id, reused: true };
    }
    const opened = await this.adapter.open(envLabel);
    const handle = { id: opened.id, cdpUrl: opened.cdpUrl, refCount: 1 };
    this.active.set(envLabel, handle);
    return { envLabel, cdpUrl: opened.cdpUrl, id: opened.id, reused: false };
  }

  async release(envLabel, { close = true } = {}) {
    const handle = this.active.get(envLabel);
    if (!handle) return false;
    handle.refCount -= 1;
    if (handle.refCount > 0) return false;
    this.active.delete(envLabel);
    if (close) {
      await this.adapter.close(handle.id).catch(() => {});
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
