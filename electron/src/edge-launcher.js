"use strict";

/**
 * 无头 Edge（CDP）启动器。
 * 注意：Edge 启动器进程可能立即退出（真正的浏览器在子进程树），
 * 所以不依赖子进程 stderr，而是轮询 /json/version 确认 CDP 就绪。
 * 供"一键自检"与 E2E 测试共用。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function fetchOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
  });
}

/**
 * 启动无头 Edge，返回 { cdpUrl, close() }；不可用（未装 Edge 等）时抛错。
 */
async function launchHeadlessEdge({ onLog } = {}) {
  const exe = findEdge();
  if (!exe) throw new Error("没有找到 Edge 浏览器（自检需要 Edge，正常答题使用比特浏览器不受影响）");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-edge-"));
  const port = await findFreePort();
  const child = spawn(exe, [
    "--headless=new",
    "--no-first-run",
    "--disable-gpu",
    "--no-default-browser-check",
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ], { stdio: "ignore", detached: false });

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
  onLog?.(`自检浏览器已启动：${cdpUrl}`);

  return {
    cdpUrl,
    close: () => {
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch { /* 进程可能已退出 */ }
      setTimeout(() => {
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 句柄延迟 */ }
      }, 1000);
    },
  };
}

module.exports = { launchHeadlessEdge, findEdge };
