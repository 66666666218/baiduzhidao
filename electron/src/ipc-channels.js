"use strict";

/**
 * IPC 通道清单（主进程侧）。
 *
 * 谁在用：app-context.js 的冒烟自检——点按钮前把这些通道全部换成空实现，
 * 好让"处理器体内的错误"暴露出来，同时不产生任何真实副作用
 * （提交答案 / 上传资源 / 开文件夹 / 弹文件框 / 装更新）。
 *
 * 注意：preload.js 里有**同样一份内联清单**，不能改成 require 本模块——
 * 本窗口 sandbox:true，沙箱化的 preload 只能 require electron 与少数内置模块，
 * 引入本地文件会让 preload 直接加载失败、整页崩（已实测）。
 * 两份必须一致，由 tests/unit/contract.test.js 契约①-b 强制校验。
 */

const INVOKE_CHANNELS = [
  // 设置与日志
  "settings:get",
  "settings:save",
  "logs:recent",
  "logs:set-mask",

  // 任务控制
  "task:stop",
  "task:pause",
  "task:resume",
  "accounts:overview",
  "accounts:unblock",
  "task:history",
  "task:running",

  // 任务
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
  "task:check-published",

  // 网盘
  "netdisk:accounts:list",
  "netdisk:accounts:add",
  "netdisk:accounts:extract-from-window",
"auth:login-and-extract",
  "netdisk:accounts:remove",
  "netdisk:accounts:check",
  "netdisk:accounts:refresh",
  "netdisk:list",
  "netdisk:delete",
  "netdisk:empty-recycle",
  "netdisk:records",

  // 文件与外部
  "file:open",
  "file:reveal",
  "bit:check",

  // 题库 / 答案
  "questions:random-pick",
  "answers:list",
  "answers:clear",
  "answers:export",
  "bank:stats",
  "bank:list",
  "bank:import",
  "bank:export",

  // 杂项
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
];

/** 主进程 → 渲染端的单向推送通道 */
// `update:progress` 是后加的（2.0.46）：以前下载进度只写进运行日志（每 20% 一行），
// 界面全程一动不动 —— 用户点完「检查更新」看着"当前版本 v2.0.44"不变，就会得出"点了没用"。
// `update:error` 是 2.0.47 补的：主进程在 `autoUpdater.on("error")` 里清了 `downloading`，
// 但**界面用的是自己那份状态**，没人通知就永远停在"⬇️ 下载中 42%"（同样是"界面撒谎"）。
// ⚠️ 新增通道必须**同时**加在这里和 `preload.js` 的 listenerChannels（契约①-b），
// 只加一边的表现是：主进程发了、渲染端收不到，而且**不报错**。
const LISTENER_CHANNELS = ["task:log", "task:progress", "task:item", "update:ready", "update:available", "update:progress", "update:error"];

module.exports = { INVOKE_CHANNELS, LISTENER_CHANNELS };
