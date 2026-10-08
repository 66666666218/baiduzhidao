"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 白名单通道：渲染端只能调用这些方法。
//
// 为什么这份清单是**内联**的、而不是 require src/ipc-channels.js：
// 本窗口 sandbox:true（护着 31 条高权通道），沙箱化的 preload 只能 require
// electron 与少数内置模块，拿不到本地文件——试过，preload 直接加载失败、整页崩。
// 主进程侧的同一份清单在 src/ipc-channels.js（冒烟自检要用）。
// 两份必须一致，由 tests/unit/contract.test.js 契约①强制校验，改一份漏另一份会红。
const invokeChannels = new Set([
  "settings:get",
  "settings:save",
  "logs:recent",
  "logs:set-mask",
  "task:stop",
  "task:pause",
  "task:resume",
  "task:history",
  "task:running",
  "task:crawl",
  "task:generate",
  "task:submit",
  "task:passed-count",
  "task:batch-transfer",
  "task:batch-upload",
  "task:upload-by-topic",
  "task:auto-pipeline",
  "task:crawl-home",
  "task:search-resources",
  "netdisk:accounts:list",
  "netdisk:accounts:add",
  "netdisk:accounts:extract-from-window",
  "netdisk:accounts:remove",
  "netdisk:accounts:check",
  "netdisk:list",
  "netdisk:delete",
  "netdisk:records",
  "file:open",
  "file:reveal",
  "bit:check",
  "questions:random-pick",
  "answers:list",
  "answers:clear",
  "answers:export",
  "bank:stats",
  "bank:list",
  "bank:import",
  "bank:export",
  "clipboard:write",
  "link:open",
  "path:pick-save-xlsx",
  "path:pick-open-table",
  "path:pick-folder",
  "ai:usage",
  "app:data-dir",
  "app:open-data-dir",
  "app:selftest",
  "update:check",
  "update:install",
  "update:info",
]);

const listenerChannels = new Set(["task:log", "task:progress", "task:item", "update:ready", "update:available"]);

contextBridge.exposeInMainWorld("api", {
  invoke: (channel, payload) => {
    if (!invokeChannels.has(channel)) return Promise.reject(new Error(`未知通道：${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, callback) => {
    if (!listenerChannels.has(channel)) return () => {};
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
