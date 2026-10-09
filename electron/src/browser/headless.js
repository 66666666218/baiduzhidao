"use strict";

/**
 * Headless Edge 适配器（「无比特模式」的底座）。
 *
 * 为什么要它：比特浏览器每开一个环境就是一份完整 Chromium（几百 MB），
 * 内存紧的机器开不动；而**只需要登录态**的场景（拿 Cookie 跑纯协议、或提交回答）
 * 完全可以用系统自带的 Edge 跑 headless。
 *
 * 做法和比特一样是「启动浏览器 + 暴露 CDP」——这样上层（BrowserPool 及各任务）
 * 只认 `cdpUrl`，**一行都不用改**，只是把"启动哪个浏览器"换掉。
 *
 * 为什么不用纯协议代替：实测过 —— 提交回答（POST /msubmit/answer）纯 HTTP
 * 会被 errno:4 挡回来，逐个排除 header 后判定是 TLS/HTTP2 指纹校验。
 * headless 是真浏览器内核，天然没有这个问题。
 *
 * ⚠️ 代价（要如实告知用户）：所有账号共用同一份 Edge 指纹，**账号间隔离性不如比特**。
 * 所以每个环境仍给独立的 user-data-dir（隔离 Cookie/缓存/存储），
 * 但设备指纹是同一个 —— 多账号运营介意的话还是用比特。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

/** 常见安装位置（按顺序探测） */
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

/** 找到可用的 Edge；找不到返回空串 */
function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return "";
}

/** 探测 CDP 是否就绪 */
async function waitForCdp(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((s) => setTimeout(s, 400));
  }
  return false;
}

/**
 * 启动一个 headless Edge 并返回 CDP 地址。
 * @returns {Promise<{id, cdpUrl, name, proc, userDataDir, driverPath}>}
 */
async function openHeadless({ envLabel = "", port = 0, width = 1366, height = 900 } = {}) {
  const exe = findEdge();
  if (!exe) throw new Error("没找到系统 Edge（msedge.exe）。请安装 Edge，或在设置里改用比特浏览器模式。");

  // 每个环境独立的临时 profile：隔离 Cookie/cache，避免账号间串数据
  const safe = String(envLabel || "env").replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 30);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `zdhl-${safe}-`));
  const realPort = port || 19200 + Math.floor(Math.random() * 700);

  const args = [
    "--headless=new",
    `--remote-debugging-port=${realPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    "--lang=zh-CN",
    "about:blank",
  ];
  const proc = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  const ok = await waitForCdp(realPort);
  if (!ok) {
    try { proc.kill(); } catch { /* 忽略 */ }
    throw new Error("headless Edge 启动超时（CDP 端口没起来）");
  }
  return {
    id: `headless-${realPort}`,
    cdpUrl: `http://127.0.0.1:${realPort}`,
    name: envLabel,
    proc,
    userDataDir,
    driverPath: "",
  };
}

/** 关掉并清理临时 profile */
async function closeHeadless(handle) {
  if (!handle) return;
  try { handle.proc?.kill(); } catch { /* 忽略 */ }
  // 给进程一点时间退出再删目录，否则文件被占用删不掉
  await new Promise((s) => setTimeout(s, 300));
  try { if (handle.userDataDir) fs.rmSync(handle.userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/** 把「网盘管理」里存的凭据注入成 Cookie（跨域整份带 —— 只给 zhidao 域会 errno:3008） */
function cookiesOf(bduss, stoken) {
  const list = [];
  const add = (domain) => {
    if (bduss) list.push({ name: "BDUSS", value: bduss, domain, path: "/" });
    if (stoken) list.push({ name: "STOKEN", value: stoken, domain, path: "/" });
  };
  // 百度全域 Cookie 必须整份带上，否则知道侧接口会判"未登录"
  add(".baidu.com");
  add(".zhidao.baidu.com");
  add(".pan.baidu.com");
  return list;
}

module.exports = { findEdge, openHeadless, closeHeadless, cookiesOf, EDGE_CANDIDATES };
