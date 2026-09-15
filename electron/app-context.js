"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { Config, nowText } = require("./src/config");
const { Logger } = require("./src/log");
const { Store } = require("./src/storage/store");
const excel = require("./src/storage/excel");
const { createAdapter, BrowserPool } = require("./src/browser");
const { LlmClient } = require("./src/llm/client");
const { TaskManager } = require("./src/tasks/manager");
const { runCrawlTask } = require("./src/tasks/crawl");
const { runGenerateTask } = require("./src/tasks/generate");
const { runSubmitTask } = require("./src/tasks/submit");
const { runPassedCountTask } = require("./src/tasks/passed-count");
const { randomPickQuestions } = require("./src/tasks/random-pick");
const { EventBus } = require("./src/events/bus");

let mainWindow = null;
let clipboardApi = null; // registerIpc 时注入（供任务内剪贴板兜底）
let currentAutosavePath = ""; // 当前任务的 CSV 自动保存文件

// ---------- 单例服务 ----------

function defaultDataDir() {
  return path.join(app.getPath("appData"), "zhidao-answer-studio");
}

const dataDir = app.isPackaged ? defaultDataDir() : path.resolve(__dirname, "..", "运行缓存");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });

const config = new Config(dataDir);
const logger = new Logger(path.join(dataDir, "logs"));
const store = new Store(dataDir);
const llm = new LlmClient({
  concurrency: config.load().aiConcurrency,
  apiKey: config.load().aiApiKey,
  baseUrl: config.load().aiBaseUrl,
  model: config.load().aiModel,
  systemPrompt: config.load().systemPrompt,
  maxTokens: config.load().aiMaxTokens,
  temperature: config.load().aiTemperature,
  onUsage: (entry) => store.addUsage(entry),
});
const browserPool = new BrowserPool(createAdapter({ apiUrl: config.load().apiUrl }));
const eventBus = new EventBus();
const tasks = new TaskManager({ eventBus });
// 任务生命周期事件 → 日志（审计订阅在 v2.1-⑦ 扩展）
eventBus.on("task.*", ({ event, taskName, taskId, to, error, label }) => {
  if (event === "task.stateChanged") logger.log(`任务状态：${taskName} → ${to}`);
  else if (event === "task.paused") logger.log(`任务暂停：${taskName}（${label || "checkpoint"}）`);
  else if (event === "task.resumed") logger.log(`任务恢复：${taskName}`);
  else if (event === "task.failed") logger.log(`任务失败：${taskName} — ${error || ""}`);
  else if (event === "task.succeeded" || event === "task.cancelled") logger.log(`${event === "task.succeeded" ? "任务完成" : "任务取消"}：${taskName}`);
});

function deps() {
  return {
    browserPool, store, config,
    log: (message, extra) => logger.log(message, extra),
    llm,
    copy: (text) => (clipboardApi ? clipboardApi.writeText(String(text || "")) : Promise.resolve()),
    autosavePath: currentAutosavePath,
  };
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

logger.onLog((text) => sendToRenderer("task:log", text));

// ---------- 任务包装 ----------

async function startTask(name, payload, runner) {
  // 每个任务一份 CSV 自动保存兜底（防表格占用/崩溃丢记录）
  const autosaveDir = path.join(dataDir, "autosave");
  fs.mkdirSync(autosaveDir, { recursive: true });
  const autosavePath = path.join(autosaveDir, `${name}_${stamp()}.csv`);
  currentAutosavePath = autosavePath;
  logger.log(`本轮自动保存文件：${autosavePath}`);
  try {
    const result = await tasks.start(name, payload, runner, {
      onLog: (message) => logger.log(message),
      onProgress: (progress) => sendToRenderer("task:progress", progress),
      onItem: (item) => sendToRenderer("task:item", item),
    });
    store.flushAll();
    return result;
  } catch (error) {
    // 失败也要给渲染端终止信号，否则 UI 永久停在运行态（按钮禁用无法恢复）
    sendToRenderer("task:progress", { done: 0, total: 0, status: "failed" });
    logger.log(`任务「${name}」失败：${error.message}`);
    throw error;
  }
}

// ---------- IPC 注册（在 main.js 中调用） ----------

function registerIpc(ipcMain, dialog, clipboard, shell) {
  clipboardApi = clipboard;
  const emit = (channel, payload) => sendToRenderer(channel, payload);

  // 设置
  ipcMain.handle("settings:get", () => config.load());
  ipcMain.handle("settings:save", (_event, patch) => {
    const saved = config.save(patch || {});
    llm.setConfig({
      apiKey: saved.aiApiKey,
      baseUrl: saved.aiBaseUrl,
      model: saved.aiModel,
      concurrency: saved.aiConcurrency,
      maxTokens: saved.aiMaxTokens,
      temperature: saved.aiTemperature,
      systemPrompt: saved.systemPrompt,
    });
    browserPool.adapter = createAdapter({ apiUrl: saved.apiUrl });
    logger.setEnvLabels((saved.bitEnvs || []).map((env) => env.label || env));
    tasks.updateLiveSettings(patch || {});
    return saved;
  });

  // 日志
  ipcMain.handle("logs:recent", () => logger.recentLines());
  ipcMain.handle("logs:set-mask", (_event, enabled) => {
    logger.setMask(enabled);
    return { ok: true };
  });

  // 任务控制
  ipcMain.handle("task:stop", () => tasks.stop());
  ipcMain.handle("task:running", () => ({ running: tasks.isRunning() }));

  // 比特浏览器
  ipcMain.handle("bit:check", async () => {
    return browserPool.adapter.checkConnection();
  });

  // 爬题
  ipcMain.handle("task:crawl", (_event, payload) => startTask("crawl", payload, (ctx) => runCrawlTask(ctx, deps())));

  // 随机抽题
  ipcMain.handle("questions:random-pick", async (_event, payload) => {
    const bank = store.loadBank();
    if (!bank.length) throw new Error("题库为空，请先爬题或导入题库表格。");
    const result = randomPickQuestions(bank, store.loadUsedKeys(), {
      categories: payload && payload.categories,
      count: (payload && payload.count) || config.load().randomCount,
    });
    if (!result.picked.length) throw new Error("当前分类下没有可抽的题目。");

    // 先确定输出路径（用户取消则直接返回，不消耗去重额度）
    let outputPath = String((payload && payload.outputPath) || config.load().randomOutputPath || "").trim().replace(/^"|"$/g, "");
    if (outputPath && fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
      outputPath = excel.uniqueFilePath(path.join(outputPath, `随机抽题_${result.picked.length}条_${stamp()}.xlsx`));
    } else if (outputPath && !excel.isTableFile(outputPath)) {
      outputPath = `${outputPath}.xlsx`;
    }
    if (!outputPath) {
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: "保存随机抽题表格",
        defaultPath: path.join(app.getPath("desktop"), `随机抽题_${result.picked.length}条_${stamp()}.xlsx`),
        filters: [{ name: "Excel 表格", extensions: ["xlsx"] }],
      });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      outputPath = choice.filePath;
    }

    // 表格成功落盘后才记去重额度：取消/写失败都不会白白消耗题目
    store.addUsedKeys(result.usedKeys);
    const savedPath = excel.writeWorkbookSafe(
      outputPath,
      result.picked.map(excel.answerToRow),
      "随机抽题",
      excel.ANSWER_HEADERS,
      (message) => emit("task:log", message)
    );
    // 记住最近一次抽题表格：生成/提交视图默认使用，减少手动选文件
    config.save({ lastPickFilePath: savedPath });
    return {
      canceled: false,
      filePath: savedPath,
      count: result.picked.length,
      total: result.total,
      remainingAfter: result.remainingAfter,
      resetRound: result.resetRound,
      results: result.picked,
    };
  });

  // AI 生成（未选表格时自动使用最近一次抽题表格）
  ipcMain.handle("task:generate", async (_event, payload) => {
    let rows = Array.isArray(payload && payload.results) ? payload.results : [];
    let filePath = String((payload && payload.filePath) || "").trim().replace(/^"|"$/g, "");
    if (!rows.length && !filePath) filePath = String(config.load().lastPickFilePath || "").trim();
    if (!rows.length && filePath && fs.existsSync(filePath)) {
      rows = excel.readTableRows(filePath).map(excel.importRowToAnswer);
    }
    if (!rows.length) {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: "选择题库表格",
        properties: ["openFile"],
        filters: [{ name: "表格文件", extensions: ["xlsx", "xls", "csv"] }],
      });
      if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };
      filePath = choice.filePaths[0];
      rows = excel.readTableRows(filePath).map(excel.importRowToAnswer);
    }
    return startTask("generate", { ...payload, results: rows }, (ctx) => runGenerateTask(ctx, deps()));
  });

  // 自动提交（支持直接给 filePath，由主进程读表格；未选时自动使用最近一次抽题表格）
  ipcMain.handle("task:submit", async (_event, payload) => {
    let rows = Array.isArray(payload && payload.results) ? payload.results : [];
    let filePath = String((payload && payload.filePath) || "").trim().replace(/^"|"$/g, "");
    if (!rows.length && !filePath) filePath = String(config.load().lastPickFilePath || "").trim();
    if (filePath && !fs.existsSync(filePath)) {
      throw new Error(`来源表格不存在：${filePath}（可能已被移动或删除），请重新选择。`);
    }
    if (!rows.length && filePath) {
      rows = excel.readTableRows(filePath).map(excel.importRowToAnswer);
    }
    return startTask("submit", { ...payload, results: rows }, (ctx) => runSubmitTask(ctx, deps()));
  });

  // 当天通过数
  ipcMain.handle("task:passed-count", (_event, payload) => startTask("passed-count", payload, (ctx) => runPassedCountTask(ctx, deps())));

  // 记录管理
  ipcMain.handle("answers:list", (_event, query) => {
    if (query && (query.keyword !== undefined || query.page || query.pageSize)) {
      return store.searchAnswers(query || {});
    }
    return { results: store.loadAnswers(), count: store.loadAnswers().length };
  });
  ipcMain.handle("bank:list", (_event, query) => store.searchBank(query || {}));
  ipcMain.handle("answers:clear", (_event, options) => ({ cleared: store.clearAnswers(options || {}) }));
  ipcMain.handle("answers:export", async (_event, payload) => {
    const keyword = String((payload && payload.keyword) || '').trim();
    const rows = Array.isArray(payload && payload.results) ? payload.results : (keyword ? store.searchAnswers({ keyword, pageSize: 1000000 }).rows : store.loadAnswers());
    const choice = await dialog.showSaveDialog(mainWindow, {
      title: "导出答案表格",
      defaultPath: path.join(app.getPath("desktop"), `答案记录_${new Date().toISOString().slice(0, 10)}.xlsx`),
      filters: [{ name: "Excel 表格", extensions: ["xlsx"] }],
    });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    excel.writeWorkbook(choice.filePath, rows.map(excel.answerToRow), "答案记录", excel.ANSWER_HEADERS);
    return { canceled: false, filePath: choice.filePath, count: rows.length, keyword: keyword || "" };
  });

  // 题库管理
  ipcMain.handle("bank:stats", () => {
    const bank = store.loadBank();
    const counts = {};
    for (const item of bank) {
      const key = item.category || "未分类";
      counts[key] = (counts[key] || 0) + 1;
    }
    // 随机抽题视角：已抽过（usedKeys 命中题库）与剩余可抽
    const usedKeys = new Set(store.loadUsedKeys());
    const keyOf = (item) => {
      const url = String(item.questionUrl || "").trim().toLowerCase();
      return url ? `url:${url}` : `title:${String(item.title || "").replace(/s+/g, "").toLowerCase()}`;
    };
    const usedCount = bank.filter((item) => usedKeys.has(keyOf(item))).length;
    return { total: bank.length, dir: dataDir, counts, usedCount, remainingCount: Math.max(0, bank.length - usedCount) };
  });
  ipcMain.handle("bank:import", async (_event, payload) => {
    let targetPath = String((payload && payload.filePath) || "").trim().replace(/^"|"$/g, "");
    if (!targetPath) {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: "选择题库表格或文件夹",
        properties: ["openFile", "openDirectory"],
        filters: [{ name: "表格文件", extensions: ["xlsx", "xls", "csv"] }],
      });
      if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };
      targetPath = choice.filePaths[0];
    }
    const tableFiles = excel.collectTableFiles(targetPath);
    if (!tableFiles.length) throw new Error(`这里没有可导入的表格：${targetPath}`);
    // 分类过滤：勾选了分类时，只导入文件名可识别为所选分类的表格（与 v1 行为一致）
    const selectedCategories = Array.isArray(payload && payload.categories) ? payload.categories.filter(Boolean) : [];
    const filteredFiles = selectedCategories.length
      ? tableFiles.filter((file) => {
          const category = detectCategory(file);
          return !category || selectedCategories.includes(category);
        })
      : tableFiles;
    if (!filteredFiles.length) throw new Error(`所选分类下没有可导入的表格（${selectedCategories.join("、")}）：${targetPath}`);
    let imported = 0;
    let updated = 0;
    for (const tableFile of filteredFiles) {
      const sourceCategory = detectCategory(tableFile);
      for (const row of excel.readTableRows(tableFile)) {
        const result = store.addBankQuestion(excel.importRowToQuestion(row, sourceCategory));
        if (result === "added") imported += 1;
        if (result === "updated") updated += 1;
      }
    }
    store.flush("bank");
    return { canceled: false, files: filteredFiles.length, imported, updated, total: store.bankSize() };
  });
  ipcMain.handle("bank:export", async () => {
    const bank = store.loadBank();
    if (!bank.length) throw new Error("题库为空。");
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: "选择题库导出文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };
    const targetDir = choice.filePaths[0];
    const xlsxPath = path.join(targetDir, `完整题库_${new Date().toISOString().slice(0, 10)}.xlsx`);
    excel.writeWorkbook(xlsxPath, bank.map(excel.bankToRow), "完整题库", excel.BANK_HEADERS);
    excel.writeBankTxt(path.join(targetDir, `完整题库_${new Date().toISOString().slice(0, 10)}.txt`), bank);
    return { canceled: false, xlsxPath, count: bank.length };
  });

  // 剪贴板与链接
  ipcMain.handle("clipboard:write", (_event, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });
  ipcMain.handle("link:open", async (_event, url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(target)) {
      throw new Error("只支持不含空白字符的 http/https 链接。");
    }
    await shell.openExternal(target);
    return { ok: true };
  });

  // 路径选择
  ipcMain.handle("path:pick-save-xlsx", async (_event, payload) => {
    const choice = await dialog.showSaveDialog(mainWindow, {
      title: (payload && payload.title) || "保存表格",
      defaultPath: (payload && payload.defaultPath) || path.join(app.getPath("desktop"), `导出_${stamp()}.xlsx`),
      filters: [{ name: "Excel 表格", extensions: ["xlsx"] }],
    });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    return { canceled: false, filePath: choice.filePath };
  });
  ipcMain.handle("path:pick-open-table", async (_event, payload) => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: (payload && payload.title) || "选择表格",
      properties: ["openFile"],
      filters: [{ name: "表格文件", extensions: ["xlsx", "xls", "csv"] }],
    });
    if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };
    return { canceled: false, filePath: choice.filePaths[0] };
  });
  ipcMain.handle("path:pick-folder", async (_event, payload) => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: (payload && payload.title) || "选择文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };
    return { canceled: false, filePath: choice.filePaths[0] };
  });

  // 一键自检（模拟站 + 无头 Edge，零配置验证整条链路）
  ipcMain.handle("app:selftest", async () => {
    tasks.assertIdle();
    const { runSelfTest } = require("./src/selftest");
    return runSelfTest({ onLog: (message) => logger.log(message) });
  });

  // AI 用量
  ipcMain.handle("ai:usage", () => store.getUsage());

  // 数据目录
  ipcMain.handle("app:data-dir", () => dataDir);
  ipcMain.handle("app:open-data-dir", async () => {
    const result = await shell.openPath(dataDir);
    if (result) throw new Error(result);
    return { ok: true, dataDir };
  });
}

function detectCategory(filePath) {
  const name = path.basename(String(filePath || ""));
  if (name.includes("情感")) return "情感类";
  if (name.includes("教育")) return "教育类";
  if (name.includes("综合")) return "综合类";
  return "";
}

function stamp() {
  return nowText().replace(/[/: ]/g, "-").slice(0, 16);
}

function createWindow({ smoke = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 680,
    autoHideMenuBar: true,
    backgroundColor: "#f5f7fb",
    title: "百度知道答题助手 v2",
    show: !smoke,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

/** 冒烟自检：渲染端脚本无错误 + preload 桥可用 + 初始化完成 */
async function smokeCheck() {
  const window = createWindow({ smoke: true });
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const bridgeOk = await window.webContents.executeJavaScript("typeof window.api === 'object' && typeof window.api.invoke === 'function'");
  const bankOk = await window.webContents.executeJavaScript("document.getElementById('bankStats') && document.getElementById('bankStats').textContent.length >= 0");
  const result = { bridgeOk, bankOk, rendererErrors: errors };
  window.destroy();
  return result;
}

/** 进程退出前落盘所有防抖中的数据 */
function shutdown() {
  try {
    store.flushAll();
  } catch (error) {
    console.error("[shutdown] flush failed:", error);
  }
}

function getMainWindow() {
  return mainWindow;
}

module.exports = { registerIpc, createWindow, dataDir, smokeCheck, shutdown, getMainWindow };
