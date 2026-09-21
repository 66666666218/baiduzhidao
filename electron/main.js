"use strict";

const { app } = require("electron");
const { registerIpc, createWindow, smokeCheck, shutdown } = require("./app-context");
const { ipcMain, dialog, clipboard, shell } = require("electron");

// 稳定性：软件渲染 + 关闭 GPU 沙箱（与旧版一致，避免部分 Windows 环境白屏）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu-sandbox");

const smokeMode = process.argv.includes("--smoke");

// 单实例锁：防止双开导致两个 Store 互相覆盖 JSON 数据
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 必须是 app.exit：app.quit 只是安排退出，whenReady 回调照样会执行，
  // 第二个进程仍会挂上 IPC、开窗口，双进程互写同一份 JSON 的问题没解决。
  if (smokeMode) {
    // 冒烟模式抢不到锁时不能以 0 退出：那会让打包校验把"根本没自检"读成"自检通过"。
    console.error("[smoke] 未取得单实例锁：主程序正在运行，冒烟自检未执行。");
    app.exit(2);
  } else {
    app.exit(0);
  }
} else {
  app.on("second-instance", () => {
    const win = require("./app-context").getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  registerIpc(ipcMain, dialog, clipboard, shell);
  if (smokeMode) {
    // 冒烟模式：渲染端自检后自动退出，非 0 退出码表示自检失败
    let code = 1;
    try {
      const result = await smokeCheck();
      console.log("[smoke]", JSON.stringify(result));
      code = result.bridgeOk && result.bankOk && result.rendererErrors.length === 0 ? 0 : 1;
    } catch (error) {
      console.error("[smoke] failed:", error);
      code = 1;
    }
    // app.exit 不触发 before-quit：不手动 shutdown 的话，冒烟这一趟写下的数据
    // 还压在 500ms 防抖和审计队列里，而且给下一次运行留一把没释放的锁。
    try {
      shutdown();
    } catch (error) {
      console.error("[smoke] shutdown failed:", error);
    }
    app.exit(code);
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
