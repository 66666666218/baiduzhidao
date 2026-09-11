"use strict";

// 自检 CLI：不开桌面应用即可验证整条引擎链路。
// 用法：node scripts/selftest-cli.js

const path = require("path");
const { runSelfTest } = require("../electron/src/selftest");

(async () => {
  console.log("=== 百度知道答题助手 v2 · 一键自检（CLI）===");
  const result = await runSelfTest({ onLog: (message) => console.log(message) });
  console.log("---");
  for (const step of result.steps) {
    console.log(`${step.ok ? "✅" : "❌"} ${step.name}（${step.ms}ms）${step.detail ? `：${step.detail}` : ""}`);
  }
  console.log(result.ok ? "=== 自检全部通过 ===" : "=== 自检未通过 ===");
  process.exit(result.ok ? 0 : 1);
})().catch((error) => {
  console.error("自检异常：", error);
  process.exit(1);
});
