"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 白名单通道：渲染端只能调用这些方法
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
]);

const listenerChannels = new Set(["task:log", "task:progress", "task:item"]);

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
