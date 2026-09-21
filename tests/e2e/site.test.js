"use strict";

/**
 * 本地展示站（site/server.js）的端到端回归：
 * 静态页必须真的能渲染，畸形请求不能打死进程，演示接口不能被本机以外的页面触发。
 */

const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

const PORT = 28930 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, pathname, { headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, method, path: pathname, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.end(raw ? undefined : "");
  });
}

/** 直接写 socket，构造 http.client 发不出的畸形请求行 */
function sendRaw(text) {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(""));
    setTimeout(() => socket.destroy(), 3000);
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`站点进程已退出（code ${child.exitCode}）`);
    try {
      const res = await request("GET", "/api/stats");
      if (res.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("站点启动超时");
}

test("展示站：页面可用、源码不外泄、畸形请求不打死进程", async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "site", "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  await waitForServer(child);

  const home = await request("GET", "/");
  assert.equal(home.status, 200);
  assert.ok(home.body.startsWith("<!DOCTYPE html>"), "首页必须是可渲染的 HTML，而不是 Buffer 的 JSON 转储");
  assert.ok(home.body.includes("</html>"), "整页应完整");

  assert.equal((await request("GET", "/app.js")).status, 200, "页面脚本应可取");
  assert.equal((await request("GET", "/styles.css")).status, 200, "样式应可取");

  const leak = await request("GET", "/server.js");
  assert.equal(leak.status, 404, "站点自身源码不在可访问清单里");
  const traversal = await sendRaw("GET /%2e%2e%2fpackage.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  assert.match(traversal, /^HTTP\/1\.1 404/, "编码后的上级路径不应被读出");

  const evil = await request("POST", "/api/demo/generate", { headers: { Origin: "http://evil.example" } });
  assert.equal(evil.status, 403, "其它站点不得盲触发本机演示");

  const bad = await sendRaw("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  assert.match(bad, /400/, "畸形请求行应回 400");
  const after = await request("GET", "/api/stats");
  assert.equal(after.status, 200, "收到畸形请求后进程仍在工作");
  assert.equal(child.exitCode, null, `站点进程不应退出，stderr: ${stderr.slice(0, 300)}`);
});
