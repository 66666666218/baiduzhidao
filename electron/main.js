"use strict";

const { app } = require("electron");
const { registerIpc, createWindow, smokeCheck, shutdown } = require("./app-context");
const { ipcMain, dialog, clipboard, shell } = require("electron");

// 稳定性：软件渲染 + 关闭 GPU 沙箱（与旧版一致，避免部分 Windows 环境白屏）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu-sandbox");

// 单实例锁：防止双开导致两个 Store 互相覆盖 JSON 数据
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = require("./app-context").getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

const smokeMode = process.argv.includes("--smoke");

app.whenReady().then(async () => {
  registerIpc(ipcMain, dialog, clipboard, shell);
  if (smokeMode) {
    // 冒烟模式：渲染端自检后自动退出，非 0 退出码表示自检失败
    try {
      const result = await smokeCheck();
      console.log("[smoke]", JSON.stringify(result));
      app.exit(result.bridgeOk && result.bankOk && result.rendererErrors.length === 0 ? 0 : 1);
    } catch (error) {
      console.error("[smoke] failed:", error);
      app.exit(1);
    }
    return;
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", shutdown);

app.on("activate", () => {
  createWindow();
});

process.on("uncaughtException", (error) => {
  console.error("[main] uncaughtException:", error);
  if (smokeMode) app.exit(1);
});
