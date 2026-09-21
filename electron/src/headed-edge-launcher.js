"use strict";

/**
 * 有头 Edge（CDP）持久会话启动器 —— 供 panlay.com 等需要人工登录的站点使用。
 * 与 edge-launcher.js（无头+临时目录）的区别：
 *   - 有头窗口（用户要输手机验证码）
 *   - 持久 user-data-dir（登录态跨次复用，登录一次长期有效）
 *   - CDP 端口写入 运行缓存/panlay-cdp.txt，后续脚本直接复用已开浏览器
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { findEdge, findFreePort } = require("./edge-launcher");

const root = path.resolve(__dirname, "..", "..");
const cacheDir = path.join(root, "运行缓存");
const profileDir = path.join(cacheDir, "panlay-profile");
const portFile = path.join(cacheDir, "panlay-cdp.txt");

function fetchOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(timeoutMs, () => request.destroy());
  });
}

/** 已有可用会话则直接返回（不重复开浏览器）；否则拉起有头窗口。 */
async function launchHeadedEdge({ onLog } = {}) {
  // 1) 复用：端口文件存在且 CDP 存活
  if (fs.existsSync(portFile)) {
    const saved = fs.readFileSync(portFile, "utf8").trim();
    if (saved && (await fetchOk(`http://${saved}/json/version`))) {
      onLog?.(`复用已开浏览器：http://${saved}`);
      return { cdpUrl: `http://${saved}`, reused: true };
    }
  }

  // 2) 新起有头窗口（持久 profile）
  const exe = findEdge();
  if (!exe) throw new Error("没有找到 Edge 浏览器");
  fs.mkdirSync(profileDir, { recursive: true });
  const port = await findFreePort();
  // detached：Edge 独立于脚本进程存活（脚本退出/任务回收都不会带走浏览器，
  // 登录态的 session cookie 就始终活在浏览器里，供后续脚本经 CDP 复用）
  const child = spawn(exe, [
    "--no-first-run",
    "--disable-gpu",
    "--no-default-browser-check",
    "--window-size=1500,940",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "https://panlay.com",
  ], { stdio: "ignore", detached: true });
  child.unref();

  const cdpUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await fetchOk(`${cdpUrl}/json/version`);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready) {
    try { child.kill(); } catch { /* 已退出 */ }
    throw new Error("启动 Edge 超时（30 秒内 CDP 未就绪）");
  }
  fs.writeFileSync(portFile, `127.0.0.1:${port}`);
  onLog?.(`有头浏览器已启动：${cdpUrl}（profile=${profileDir}）`);

  // 有头+持久会话：不随脚本退出关闭，由用户或 panlay-close.js 收尾
  return { cdpUrl, reused: false, close: () => { try { child.kill(); } catch { /* 已退出 */ } } };
}

module.exports = { launchHeadedEdge, profileDir, portFile };
