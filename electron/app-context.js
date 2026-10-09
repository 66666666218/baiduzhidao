"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { Config, nowText, CATEGORIES } = require("./src/config");
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
const { runBatchTransferTask } = require("./src/tasks/batch-transfer");
const { runBatchUploadTask, runTopicUploadTask } = require("./src/tasks/upload-batch");
const searchCrawler = require("./src/netdisk/search-crawler");
const workbench = require("./src/netdisk/workbench");
const { randomPickQuestions } = require("./src/tasks/random-pick");
const { EventBus } = require("./src/events/bus");
const { AuditLogger } = require("./src/audit/logger");
const { INVOKE_CHANNELS } = require("./src/ipc-channels");
const { describeUpdateError, describeError } = require("./src/errors");
const { resolveNetdiskRoles } = require("./src/domain/account-topic");
// 查收录 / 权益检查要开窗口取 Cookie（runCheckPublishedTask），这里必须导入。
// 之前漏了它，直接把「查收录」「账号总览」打成一跑就 ReferenceError: chromium is not defined，
// 而日志只显示「查收录失败」，完全看不出是少了一行 import。
const { chromium } = require("playwright-core");

let mainWindow = null;
let clipboardApi = null; // registerIpc 时注入（供任务内剪贴板兜底）
let currentAutosavePath = ""; // 当前任务的 CSV 自动保存文件
let autosaveSeq = 0; // 同一分钟内连起两个任务时区分自动保存文件
// 一键全自动的"停止"旗标：TaskManager.stop 只能停当前任务，而编排在阶段之间还要
// 决定"下一阶段是否该开始"。没有这个旗标，用户点了停止，编排仍会把后续阶段依次拉起来。
let autoPipelineAborted = false;

// ---------- 单例服务 ----------

function defaultDataDir() {
  return path.join(app.getPath("appData"), "zhidao-answer-studio");
}

// 数据目录：① 环境变量 ZHIDAO_DATA_DIR 优先 —— 用来把软件指到一个**干净目录**，
//              模拟"换了一台新电脑"跑测试（否则永远只能用开发态那份带着历史数据的 运行缓存）；
//            ② 打包版写用户数据目录 %APPDATA%\zhidao-answer-studio；
//            ③ 开发态用仓库里的 运行缓存。
const dataDir = process.env.ZHIDAO_DATA_DIR
  ? path.resolve(process.env.ZHIDAO_DATA_DIR)
  : (app.isPackaged ? defaultDataDir() : path.resolve(__dirname, "..", "运行缓存"));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });

const config = new Config(dataDir);
const logger = new Logger(path.join(dataDir, "logs"));
const store = new Store(dataDir, { owner: "gui" });
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
const auditLogger = new AuditLogger({ auditDir: path.join(dataDir, "audit"), eventBus });
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
    dataDir,   // 与「打开数据目录」/批量转存输出一致的基准目录
    log: (message, extra) => logger.log(message, extra),
    llm,
    copy: (text) => (clipboardApi ? clipboardApi.writeText(String(text || "")) : Promise.resolve()),
    autosavePath: currentAutosavePath,
    emitEvent: (event, payload) => eventBus.emit(event, payload),
  };
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

logger.onLog((text) => sendToRenderer("task:log", text));
// 构建标识：日志首行即可辨识版本（排查"装的旧包"问题）
logger.log("软件构建版本：2026-09-28-F（修复：资源名取网盘真实文件名/转存文件夹带资源名）");

// ---------- 任务包装 ----------

async function startTask(name, payload, runner) {
  // 互斥检查必须在这里、且在下面的 try 之前做：
  // 放进 tasks.start 的异常里统一处理，会给"用户连点两次"这种启动拒绝也广播一次
  // status:"failed"，把仍在正常运行的上一个任务的进度条改成"失败"并重新启用按钮。
  tasks.assertIdle();
  // 脚本类工具（scripts/*.js）会另起一个 Store 写同一份 JSON，两边各持内存缓存整份覆写。
  // 主程序这边只警告不拦停：拦在 GUI 上会让人以为软件坏了，脚本那边则直接拒绝启动。
  const foreignWriter = store.detectForeignWriter();
  if (foreignWriter) {
    logger.log(`⚠️ 检测到另一个写入者（${foreignWriter.owner} · 进程 ${foreignWriter.pid}，${Math.round(foreignWriter.idleMs / 1000)} 秒前还在活动）正在写同一份数据目录，` +
      "两边会互相覆盖题库/记录。请先关掉它（命令行工具或主程序）再继续。");
  }
  // 每个任务一份 CSV 自动保存兜底（防表格占用/崩溃丢记录）
  const autosaveDir = path.join(dataDir, "autosave");
  fs.mkdirSync(autosaveDir, { recursive: true });
  // stamp() 只到分钟，同一分钟内起两次同名任务会共用一个 CSV，上一轮的记录会混进这一轮
  const autosavePath = path.join(autosaveDir, `${name}_${stamp()}_${++autosaveSeq}.csv`);
  currentAutosavePath = autosavePath;
  logger.log(`本轮自动保存文件：${autosavePath}`);
  try {
    const result = await tasks.start(name, payload, runner, {
      onLog: (message) => logger.log(message),
      onProgress: (progress) => sendToRenderer("task:progress", progress),
      onItem: (item) => {
      sendToRenderer("task:item", item);
      if (item && item.answer && item.status === "已生成回答") eventBus.emit("answer.generated", { questionId: item.questionUrl || item.title, model: config.load().aiModel, decision: item.quality || "" });
      if (item && item.status === "已提交") eventBus.emit("submission.succeeded", { questionId: item.questionUrl || item.title, account: item.bitEnv, confirmed: item.confirmed });
      if (item && String(item.status || "").startsWith("提交失败")) eventBus.emit("submission.failed", { questionId: item.questionUrl || item.title, account: item.bitEnv, reason: item.status });
    },
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

// ---------- 任务实现 ----------

/**
 * 搜资源：纯协议搜百度知道（无浏览器、无需 Cookie）→ 产出资源表，直接喂批量转存。
 *
 * 抽成具名函数是为了让「一键全自动」编排也能调同一个实现，而不是抄第二遍。
 */
async function runSearchResourcesTask(ctx, deps) {
  const { log } = deps;
  const settings = config.load();
  const explicit = (Array.isArray(ctx.payload.keywords) ? ctx.payload.keywords : [])
    .map((x) => String(x || "").trim()).filter(Boolean);

  let terms;
  if (explicit.length) {
    terms = explicit.map((term) => ({ topic: "", term }));
  } else {
    // 用「账号绑定的题材」决定搜什么：哪个账号负责哪类资源，就搜哪类。
    // 传了 bitEnvs 就只看这些账号绑的题材（一键全自动可以只挑几个号跑），
    // 否则用设置页里全部账号的题材。
    const topicMap = settings.accountTopics || {};
    const picked = (Array.isArray(ctx.payload.bitEnvs) ? ctx.payload.bitEnvs : [])
      .map((e) => (e && typeof e === "object" ? e.label ?? e.name : e))
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    const topics = picked.length
      ? picked.map((name) => topicMap[name]).filter(Boolean)
      : Object.values(topicMap);
    if (!topics.length) {
      throw new Error(picked.length
        ? "选中的账号都还没绑定题材：请到设置页「账号题材绑定」给它们配上，或直接指定搜索关键词。"
        : "没有账号绑定题材：请到设置页「账号题材绑定」配置，或直接指定搜索关键词。");
    }
    const built = searchCrawler.buildTopicSearchTerms(topics, settings.searchKeywords);
    if (built.uncovered.length) log(`⚠️ 这些题材没配搜索词，本次不搜：${built.uncovered.join("、")}`);
    if (!built.terms.length) throw new Error("这些题材都没有配搜索词，请到设置页「搜索词」里给它们配上。");
    terms = built.terms;
  }

  log(`按题材搜索（${terms.length} 个词）：${terms.map((t) => (t.topic ? `${t.topic}→${t.term}` : t.term)).join("、")}`);
  const result = await searchCrawler.crawlSearchResources({
    keywords: terms.map((t) => t.term),
    pages: Number(ctx.payload.pages) || settings.searchPages,
    limit: Number(ctx.payload.limit) || 0,
    onLog: log,
    onProgress: (p) => ctx.report({ done: p.done, total: p.total, status: "running" }),
    shouldStop: () => ctx.shouldStop(),
  });

  // 列顺序有讲究：batch-transfer 靠列名猜「名称列/链接列/提取码列」，
  // 名称列必须在最前面，否则它可能把别的列当成资源名。
  const rows = result.rows.map((r) => ({
    资源名: r.name,
    链接: r.link,
    提取码: r.pwd,
    问题链接: r.questionUrl,
    来源关键词: r.source,
  }));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const outputPath = path.join(dataDir, "搜资源", `搜资源_${stamp}.xlsx`);
  const savedPath = excel.writeWorkbookSafe(outputPath, rows, "搜资源", ["资源名", "链接", "提取码", "问题链接", "来源关键词"], log);
  log(`搜资源产出 ${rows.length} 条：${savedPath}`);
  return { count: rows.length, stats: result.stats, outputPath: savedPath };
}

/**
 * 查收录：核对上传到答主工作台的问答**是否真的被收录**。
 *
 * 为什么需要单独一步：上传接口返回 200 只代表**平台收下了**，之后平台还要异步审核，
 * 审核结果只体现在工作台的「上传记录」里（`qa/api/bulkqa/tasks`）。
 * 三件事是三回事：接口 200 → 审核通过 → 真的出现在回答里。
 *
 * 做法和转存一致：从浏览器取一次 Cookie，之后全程纯协议（不再操作页面）。
 */
/**
 * 从「网盘管理」存的账号里取 Cookie（按比特环境名匹配）。
 *
 * 为什么按名字匹配：账号是用户在「网盘管理 → 添加账号」里自己命名加进去的，
 * 想让它在查收录/权益检查里生效，名字必须和比特环境名一致——
 * 跟「账号题材绑定」是同一条规矩（差一个字就不生效）。
 *
 * 实测：只带 BDUSS 就能调通工作台接口（BDUSS 是百度全域 Cookie），
 * 所以存过的账号不必为每次查收录再开一次浏览器。
 *
 * 返回 "" 表示没存 → 调用方回落到开窗口取。
 */
function storedCookieOf(envLabel, log) {
  try {
    const { credentialOf } = require("./src/netdisk/manager");
    const cred = credentialOf(dataDir, envLabel);
    if (!cred) return "";
    const parts = [`BDUSS=${cred.bduss}`];
    if (cred.stoken) parts.push(`STOKEN=${cred.stoken}`);
    log(`查收录：${envLabel} 用已保存的 Cookie（不开窗口）`);
    return parts.join("; ");
  } catch (e) {
    log(`（读取已保存的 Cookie 失败，回落到开窗口：${e.message}）`);
    return "";
  }
}

async function runCheckPublishedTask(ctx, deps) {
  const { browserPool, log } = deps;
  const settings = config.load();
  const requested = (Array.isArray(ctx.payload.bitEnvs) ? ctx.payload.bitEnvs : [])
    .map((e) => (e && typeof e === "object" ? e.label ?? e.name : e))
    .map((x) => String(x || "").trim()).filter(Boolean);
  const bitEnvs = requested.length ? requested : (settings.bitEnvs || []).map((e) => e.label || e).filter(Boolean);
  if (!bitEnvs.length) throw new Error("请先填写比特浏览器环境名称。");
  const pageSize = Math.min(100, Math.max(1, Number(ctx.payload.pageSize) || 20));
  // 逐条被拒原因默认开：只看「失败 N 条」等于只能猜原因，结果文件里原因是明写的
  const withReasons = ctx.payload.withReasons !== false;
  const reasonTaskLimit = Math.min(50, Math.max(1, Number(ctx.payload.reasonTaskLimit) || 5));

  const accounts = [];
  const rows = [];
  const failedRows = [];
  for (const envLabel of bitEnvs) {
    if (ctx.shouldStop()) break;
    let browser = null;
    try {
      // 取登录态：**优先用「网盘管理」里存好的 Cookie，没存才开窗口**。
      // 实测：只带 BDUSS 就能调通工作台接口（BDUSS 是百度全域 Cookie），
      // 所以存过的账号不必为每次查收录/权益检查再开一次浏览器。
      let cookieStr = storedCookieOf(envLabel, log);
      if (!cookieStr) {
        log(`查收录：打开比特环境 ${envLabel}（未存 Cookie，开窗口取登录态）`);
        const handle = await browserPool.acquire(envLabel);
        browser = await chromium.connectOverCDP(handle.cdpUrl);
        const context = browser.contexts()[0] || (await browser.newContext());
        const cookies = await context.cookies(workbench.WB_HOST);
        const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
        if (!bduss) {
          log(`⚠️ ${envLabel} 未登录百度账号，跳过（查收录需要登录态）。`);
          accounts.push({ envLabel, ok: false, hasPermission: null, error: "未登录百度账号" });
          continue;
        }
        cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }

      let info = { name: "", remainingQuota: NaN, banned: false, banDays: -1 };
      try {
        info = workbench.pickUserInfo(await workbench.fetchWorkbenchJson("/qa/api/bulkqa/userinfo", cookieStr));
      } catch (e) {
        log(`（账号信息查询失败，不影响查收录：${e.message}）`);
      }
      const quotaText = Number.isFinite(info.remainingQuota) ? info.remainingQuota : "未知";
      log(`【${envLabel}】账号 ${info.name || "(未取到)"}｜剩余额度 ${quotaText}`);
      if (info.banned) {
        // 工作台自己会报封禁状态——这是判断"这个号还能不能用"最直接的依据
        log(`🚫 该账号被封禁${info.banDays > 0 ? ` ${info.banDays} 天` : ""}，本账号后续上传/转存都会失败，建议先换号。`);
      }

      const resp = await workbench.fetchWorkbenchJson(`/qa/api/bulkqa/tasks?page=1&pageSize=${pageSize}`, cookieStr);
      const tasks = workbench.pickTaskList(resp);
      if (!tasks.length) {
        log(`⚠️ ${envLabel} 没取到上传记录——接口结构可能变了，或该账号还没上传过。`);
        accounts.push({ envLabel, ok: false, hasPermission: null, error: "没有取到上传记录" });
        continue;
      }
      const summary = workbench.summarizeTasks(tasks);
      log(`最近 ${summary.taskCount} 个上传任务（${summary.lastAt || "?"} 起）：共 ${summary.totalRows} 条 → `
        + `收录 ${summary.successRows} 条，被拒 ${summary.failedRows} 条，扣额度 ${summary.usedQuota}`);
      for (const task of tasks.slice(0, 8)) {
        log(`  · ${workbench.formatTask(task)}`);
        rows.push({
          环境: envLabel,
          账号: info.name || "",
          任务名: task.taskName || "",
          创建时间: workbench.formatTime(task.createdAt),
          总数: Number(task.totalCount) || 0,
          已收录: Number(task.successCount) || 0,
          被拒: Number(task.failCount) || 0,
          扣额度: Number(task.usedTotal) || 0,
        });
      }
      accounts.push({
        envLabel,
        ok: true,
        name: info.name,
        // 「批量发布权益」：工作台 userinfo 里的 hasPermission（实测 true/false）。
        // 没这个权益的账号上传会被拒，所以网盘链要据此跳号。
        // 查询失败时给 null（未知），调用方按"不拦"处理——不能因为查不到就误封账号。
        hasPermission: info.hasPermission === undefined ? null : info.hasPermission,
        remainingQuota: Number.isFinite(info.remainingQuota) ? info.remainingQuota : null,
        taskTotal: workbench.pickTaskTotal(resp),
        summary,
      });
      ctx.emitItem({ title: `${envLabel} 查收录`, status: `收录 ${summary.successRows} / 被拒 ${summary.failedRows}`, bitEnv: envLabel });

      // 逐条被拒原因：只对「有失败」的任务拉结果文件（每个文件可能几百行，不能全量拉）
      if (withReasons && summary.failedRows > 0) {
        const suspects = tasks.filter((t) => Number(t.failCount) > 0).slice(0, reasonTaskLimit);
        for (const task of suspects) {
          if (ctx.shouldStop()) break;
          try {
            const buf = await workbench.fetchTaskResult(task.id, cookieStr);
            const tmp = path.join(dataDir, "查收录", `.result_${task.id}.xlsx`);
            fs.mkdirSync(path.dirname(tmp), { recursive: true });
            fs.writeFileSync(tmp, buf);
            let rows = [];
            try {
              rows = excel.readTableRows(tmp);
            } finally {
              fs.rmSync(tmp, { force: true });
            }
            const failed = workbench.pickFailedRows(rows);
            for (const row of failed) {
              failedRows.push({
                环境: envLabel,
                任务名: task.taskName || "",
                任务时间: workbench.formatTime(task.createdAt),
                qid: row.qid,
                问题: row.title,
                失败原因: row.reason,
                答案带链接: row.hasLink ? "是" : "否",
                问题链接: row.questionUrl,
              });
            }
          } catch (e) {
            log(`（任务 ${task.id} 的结果文件取不到：${e.message}）`);
          }
        }
      }
    } catch (error) {
      log(`⚠️ ${envLabel} 查收录失败：${describeError(error)}`);
      accounts.push({ envLabel, ok: false, hasPermission: null, error: error.message });
    } finally {
      await browser?.close?.().catch(() => {});
      await browserPool.release(envLabel, { close: settings.closeAfter }).catch(() => {});
    }
    ctx.report({ done: accounts.length, total: bitEnvs.length, status: "running" });
  }

  const okAccounts = accounts.filter((a) => a.ok);
  const failedRowsTotal = okAccounts.reduce((sum, a) => sum + a.summary.failedRows, 0);
  if (failedRowsTotal > 0) {
    log(`⚠️ 合计有 ${failedRowsTotal} 条被平台拒收。`);
    if (failedRows.length) {
      // 原因是从结果文件里读出来的，不是猜的——这正是加这个功能的理由
      const reasons = workbench.countReasons(failedRows);
      log(`被拒原因分布：${reasons.map((r) => `${r.reason} ${r.count} 条`).join("、")}`);
      for (const row of failedRows.slice(0, 8)) {
        log(`  · [${row.失败原因}] ${String(row.问题).slice(0, 42)}`);
      }
      if (failedRows.length > 8) log(`  …还有 ${failedRows.length - 8} 条，见导出的「被拒明细」表。`);
    } else if (withReasons) {
      log("（结果文件没取到，本轮只有条数。可在界面「上传记录」里点该任务的下载按钮手动核对。）");
    }
  }
  const stopped = ctx.shouldStop();
  ctx.report({ done: accounts.length, total: bitEnvs.length, status: stopped ? "stopped" : "done" });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  let outputPath = "";
  if (rows.length) {
    outputPath = path.join(dataDir, "查收录", `收录核对_${stamp}.xlsx`);
    outputPath = excel.writeWorkbookSafe(
      outputPath, rows, "收录核对",
      ["环境", "账号", "任务名", "创建时间", "总数", "已收录", "被拒", "扣额度"], log
    );
    log(`收录明细已导出：${outputPath}`);
  }
  let failedPath = "";
  if (failedRows.length) {
    failedPath = path.join(dataDir, "查收录", `被拒明细_${stamp}.xlsx`);
    failedPath = excel.writeWorkbookSafe(
      failedPath, failedRows, "被拒明细",
      ["环境", "任务名", "任务时间", "qid", "问题", "失败原因", "答案带链接", "问题链接"], log
    );
    log(`被拒明细已导出：${failedPath}`);
  }
  return { stopped, accounts, outputPath, failedPath, failedRows: failedRows.length, checked: okAccounts.length };
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
  ipcMain.handle("task:stop", () => {
    autoPipelineAborted = true; // 手动停止时一并中止一键全自动的后续阶段
    return tasks.stop();
  });
  ipcMain.handle("task:pause", () => tasks.pause());
  ipcMain.handle("task:resume", () => tasks.resume());
  ipcMain.handle("task:history", () => ({ current: tasks.currentState(), history: tasks.historyList() }));
  ipcMain.handle("task:running", () => ({ running: tasks.isRunning() }));

  // 比特浏览器
  ipcMain.handle("bit:check", async () => {
    return browserPool.adapter.checkConnection();
  });

  // 爬题
  ipcMain.handle("task:crawl", (_event, payload) => startTask("crawl", payload, (ctx) => runCrawlTask(ctx, deps())));

  // 随机抽题
  // 抽成具名函数：一键全自动编排要复用同一段逻辑，不能把它抄第二遍
  const pickQuestions = async (payload) => {
    const bank = store.loadBank();
    if (!bank.length) throw new Error("题库为空，请先爬题或导入题库表格。");
    // 已提交的题以 answers 台账为准永久出池：此前只靠 usedKeys 去重，
    // 重开轮（题库抽满一轮自动清空）或题库重爬导致键失配时，答过的题会被再次抽中。
    // 另外把"已生成过回答"的题一并出池（skipGenerated 默认开）：生成记录比提交记录
    // 更容易留存（换机/手动提交/批量上传等任何答题方式，只要在软件里生成过就有标记），
    // 这是防重复答题的主要防线；"已提交"是强标记，双保险。
    const pickKeyOf = (item) => {
      const url = String(item.questionUrl || "").trim().toLowerCase();
      return url ? `url:${url}` : `title:${String(item.title || "").replace(/\s+/g, "").toLowerCase()}`;
    };
    // 默认开：显式传 false（勾选框取消）才允许重抽已生成过的题
    const skipGenerated = !(payload && payload.skipGenerated === false);
    const submittedKeys = new Set(
      store.loadAnswers()
        .filter((a) => a && (a.status === "已提交" || (skipGenerated && String(a.answer || "").trim())))
        .map(pickKeyOf)
        .filter(Boolean)
    );
    const result = randomPickQuestions(bank, store.loadUsedKeys(), {
      categories: payload && payload.categories,
      count: (payload && payload.count) || config.load().randomCount,
      strategy: payload && payload.strategy,
      excludeKeys: submittedKeys,
    });
    if (!result.picked.length) {
      if (result.excludedSubmitted > 0) throw new Error("当前分类下的题目均已答过（已提交或已生成过回答），没有可抽的新题（可先爬题扩充题库）。");
      throw new Error("当前分类下没有可抽的题目。");
    }
    if (result.excludedSubmitted > 0) emit("task:log", `去重：已排除 ${result.excludedSubmitted} 条答过的题目（已提交/已生成过回答），不会重复作答`);

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
    const savedPath = excel.writeWorkbookSafe(
      outputPath,
      result.picked.map(excel.answerToRow),
      "随机抽题",
      excel.ANSWER_HEADERS,
      (message) => emit("task:log", message)
    );
    store.addUsedKeys(result.usedKeys);
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
  };
  ipcMain.handle("questions:random-pick", (_event, payload) => pickQuestions(payload));

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
  ipcMain.handle("task:batch-transfer", (_event, payload) => startTask("batch-transfer", payload, (ctx) => runBatchTransferTask(ctx, deps())));
  // 主页找资源：答主主页 → 网盘资源表格（纯协议爬取，只取资源链接与问题地址，回答内容不落盘）
  const homeCrawler = require("./src/netdisk/home-crawler");
  ipcMain.handle("task:crawl-home", (_event, payload) => startTask("crawl-home", payload, async (ctx) => {
    const { log } = deps();
    const homepages = (Array.isArray(ctx.payload.homepages) ? ctx.payload.homepages : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    if (!homepages.length) throw new Error("请填写至少一个答主主页地址（usercenter 链接，每行一个）");
    // 0 是合法值（UI 承诺"0=不兜底"），只有缺省/非法输入才回退默认 50
    const enrichRaw = Number(ctx.payload.enrichLimit);
    const enrichLimit = Number.isFinite(enrichRaw) && enrichRaw >= 0 ? enrichRaw : 50;
    const result = await homeCrawler.crawlHomeResources({
      homepages,
      limit: Number(ctx.payload.limit) || 0,
      enrichLimit,
      onLog: log,
      onPage: (p) => ctx.report({ done: p.accumulated, total: p.total, status: "running" }),
      shouldStop: () => ctx.shouldStop(),
    });
    const rows = result.rows.map((r) => ({ 资源名: r.name, 链接: r.link, 提取码: r.pwd, 问题链接: r.questionUrl }));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const outputPath = path.join(dataDir, "主页找资源", `主页资源_${stamp}.xlsx`);
    const savedPath = excel.writeWorkbookSafe(outputPath, rows, "主页资源", ["资源名", "链接", "提取码", "问题链接"], log);
    return { count: rows.length, stats: result.stats, outputPath: savedPath };
  }));
  ipcMain.handle("task:search-resources", (_event, payload) => startTask("search-resources", payload, (ctx) => runSearchResourcesTask(ctx, deps())));
  // 查收录：核对上传到工作台的问答是否真的被收录（平台异步审核，上传 200 ≠ 被收录）
  ipcMain.handle("task:check-published", (_event, payload) => startTask("check-published", payload, (ctx) => runCheckPublishedTask(ctx, deps())));

  ipcMain.handle("file:open", async (_event, payload) => {
    const target = String(payload && payload.filePath || "").replace(/^"|"$/g, "");
    if (!target || !fs.existsSync(target)) return { ok: false, error: "文件不存在" };
    const err = await shell.openPath(target);
    return { ok: !err, error: err || "" };
  });
  ipcMain.handle("file:reveal", async (_event, payload) => {
    const target = String(payload && payload.filePath || "").replace(/^"|"$/g, "");
    if (!target || !fs.existsSync(target)) return { ok: false, error: "文件不存在" };
    shell.showItemInFolder(target);
    return { ok: true };
  });
  // 网盘管理（纯 Cookie 协议）
  const manager = require("./src/netdisk/manager");
  ipcMain.handle("netdisk:accounts:list", () => manager.loadAccounts(dataDir));
  ipcMain.handle("netdisk:accounts:add", async (_e, acc) => {
    const name = String(acc && acc.name || "").trim();
    const bduss = String(acc && acc.bduss || "").trim();
    if (!name || !bduss) throw new Error("名称与 BDUSS 必填");
    const stoken = String(acc && acc.stoken || "").trim();
    const account = { name, bduss, stoken, addedAt: new Date().toISOString() };
    const check = await manager.quota(account).catch(() => ({ valid: false }));
    if (!check.valid) throw new Error("凭证无效（BDUSS 失效或格式错误）");
    const accounts = manager.loadAccounts(dataDir).filter((a) => a.name !== name);
    accounts.push({ ...account, totalGB: check.totalGB, freeGB: check.freeGB });
    manager.saveAccounts(dataDir, accounts);
    return check;
  });
  ipcMain.handle("netdisk:accounts:extract-from-window", async (_e, p) => {
    const env = String(p && p.bitEnv || "").trim();
    if (!env) throw new Error("请填写比特窗口名");
    const h = await browserPool.acquire(env);
    const b = await chromium.connectOverCDP(h.cdpUrl);
    const context = b.contexts()[0];
    // 先读网盘域；没有就退回知道域——**BDUSS 是百度全域 Cookie**，
    // 两个域哪个有都能用（查收录走的是知道域，账号可能只登录了知道没登网盘）。
    let cs = await context.cookies("https://pan.baidu.com");
    let bd = (cs.find((c) => c.name === "BDUSS") || {}).value || "";
    if (!bd) {
      cs = await context.cookies("https://zhidao.baidu.com");
      bd = (cs.find((c) => c.name === "BDUSS") || {}).value || "";
    }
    await browserPool.release(env, { close: false });
    await b.close().catch(() => {});
    if (!bd) throw new Error(`窗口 ${env} 没有百度登录态（网盘和知道都没登录）`);
    return { bduss: bd, stoken: (cs.find((c) => c.name === "STOKEN") || {}).value || "" };
  });
  ipcMain.handle("netdisk:accounts:remove", (_e, p) => {
    const name = String(p && p.name || "");
    const rest = manager.loadAccounts(dataDir).filter((a) => a.name !== name);
    manager.saveAccounts(dataDir, rest);
    return { removed: rest.length };
  });
  ipcMain.handle("netdisk:accounts:check", async (_e, p) => {
    const name = String(p && p.name || "");
    const acc = manager.loadAccounts(dataDir).find((a) => a.name === name);
    if (!acc) throw new Error("账号不存在");
    return manager.quota(acc);
  });
  ipcMain.handle("netdisk:list", async (_e, p) => {
    const name = String(p && p.name || "");
    const acc = manager.loadAccounts(dataDir).find((a) => a.name === name);
    if (!acc) throw new Error("账号不存在");
    return manager.listDir(acc, String(p && p.dir || "/"));
  });
  ipcMain.handle("netdisk:delete", async (_e, p) => {
    const name = String(p && p.name || "");
    const acc = manager.loadAccounts(dataDir).find((a) => a.name === name);
    if (!acc) throw new Error("账号不存在");
    const paths = Array.isArray(p && p.paths) ? p.paths : [];
    if (!paths.length) throw new Error("未选择要删除的项");
    return manager.deleteItems(acc, paths);
  });
  ipcMain.handle("netdisk:records", () => manager.transferRecords(dataDir));
  ipcMain.handle("task:batch-upload", (_event, payload) => startTask("batch-upload", payload, (ctx) => runBatchUploadTask(ctx, deps())));
  // 按题材分账号上传：把上传专用表按分类规则拆成各账号的份，逐个账号投递
  ipcMain.handle("task:upload-by-topic", (_event, payload) => startTask("upload-by-topic", payload, (ctx) => runTopicUploadTask(ctx, deps())));

  /**
   * 一键全自动：把「爬题 → 抽题 → 生成 → 提交 → 按题材上传」串成一条链。
   *
   * 为什么在主进程按阶段串行调 startTask，而不是包成一个大任务：
   * TaskManager 是单任务互斥的（运行中再 start 会抛错）。分阶段串行，每个阶段
   * 各自是一个正常任务，进度/暂停/停止/日志语义完全不变；阶段之间检查中止旗标。
   *
   * 任何阶段抛错即停（后续不再执行），前面已完成的成果保留。
   * stages 数组可挑选参与阶段，未选的跳过。
   */
  ipcMain.handle("task:auto-pipeline", async (_event, payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    const enabled = new Set(
      Array.isArray(p.stages) && p.stages.length ? p.stages : ["crawl", "pick", "generate", "submit", "transfer", "upload"]
    );
    const settings = config.load();
    // 本次参与的账号：调用方显式指定优先（一键全自动页可以只挑几个号跑），默认用设置页的全部
    const requestedEnvs = (Array.isArray(p.bitEnvs) ? p.bitEnvs : [])
      .map((env) => (env && typeof env === "object" ? env.label ?? env.name : env))
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    const bitEnvs = requestedEnvs.length
      ? requestedEnvs
      : (settings.bitEnvs || []).map((env) => env.label || env).filter(Boolean);
    const report = [];
    let failure = null;
    let pickFile = "";
    // 上传专用表：优先用转存阶段的产出，其次用调用方指定的现成表
    let uploadTable = String(p.uploadTablePath || "").trim();
    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

    autoPipelineAborted = false;

    /**
     * 进度脉冲：让界面立刻进入「运行中」。
     *
     * 为什么必须有：暂停/停止按钮只在收到 task:progress 事件后才启用，而各阶段
     * 往往要跑很久才第一次上报（爬题是在**整页爬完**才 report——此前要开浏览器、
     * 导航、等待，几十秒）。这段时间界面是死的、暂停点不动，看起来像卡死了。
     */
    const pulse = () => sendToRenderer("task:progress", { done: 0, total: 0, status: "running" });

    const runStage = async (name, label, fn) => {
      if (autoPipelineAborted) {
        report.push({ stage: name, label, ok: false, skipped: true, error: "已停止" });
        return null;
      }
      emit("task:log", `══════ 一键全自动 · ${label} ══════`);
      pulse();
      try {
        const result = await fn();
        report.push({ stage: name, label, ok: true });
        emit("task:log", `──── ${label} 完成 ────`);
        return result;
      } catch (error) {
        report.push({ stage: name, label, ok: false, error: error.message });
        emit("task:log", `⚠️ ${label} 失败，后续阶段不再执行：${error.message}`);
        failure = error;
        return null;
      }
    };

    try {
      if (!bitEnvs.length) throw new Error("请先在设置页「比特环境名称」填写账号。");

      // 1) 爬题：逐分类各跑一次（爬题是只读的，用一个账号即可）
      if (enabled.has("crawl")) {
        const categories = Array.isArray(p.categories) && p.categories.length ? p.categories : CATEGORIES;
        await runStage("crawl", `爬题（${categories.join("、")}）`, async () => {
          let added = 0;
          for (const category of categories) {
            if (autoPipelineAborted || failure) break;
            const result = await startTask(
              "crawl",
              {
                bitEnvs,
                category,
                crawlStartPage: settings.crawlStartPage,
                maxQuestions: settings.maxQuestions,
                // 续爬：暂停/停止后重跑时从上次那页接着走，而不是从头再扫一遍。
                // 已入库的题本来就会自动跳过，所以从头扫不会重复入库、但会白白多花几十分钟。
                resume: true,
              },
              (ctx) => runCrawlTask(ctx, deps())
            );
            added += Number(result && result.count) || 0;
          }
          return { added };
        });
      }

      // 2) 抽题：输出路径必须显式给（不能弹保存对话框，否则无人值守会卡死）
      if (enabled.has("pick") && !failure) {
        await runStage("pick", "抽题", async () => {
          const outDir = path.join(dataDir, "一键跑批");
          const result = await pickQuestions({
            categories: p.categories,
            count: Number(p.pickCount) || settings.randomCount,
            outputPath: path.join(outDir, `抽题_${stamp()}.xlsx`),
            skipGenerated: true,
          });
          if (result.canceled) throw new Error("抽题被取消");
          pickFile = result.filePath;
          return result;
        });
      }

      // 3) 生成答案
      if (enabled.has("generate") && !failure && pickFile) {
        await runStage("generate", "生成答案", async () => {
          const rows = excel.readTableRows(pickFile).map(excel.importRowToAnswer);
          return startTask("generate", {
            // filePath 必须传：生成任务**只在给了 filePath 时才把答案写回表格**
            //（见 generate.js 的 if (!filePath) return）。少传这一个字段的表现是——
            // 生成阶段"成功"、答案只存在内存里，紧接着的提交阶段重读表格发现没有回答，
            // 报「表格里有题目链接但没有回答内容」，看起来像是生成没干活。
            filePath: pickFile,
            results: rows,
            aiApiKey: settings.aiApiKey,
            aiBaseUrl: settings.aiBaseUrl,
            aiModel: settings.aiModel,
            aiConcurrency: settings.aiConcurrency,
            aiDailyTokenBudget: settings.aiDailyTokenBudget || 0,
            titleTemplate: settings.titleTemplate,
            introTemplate: settings.introTemplate,
          }, (ctx) => runGenerateTask(ctx, deps()));
        });
      }

      // 4) 提交（纯文本答案 → 全账号宽松轮询，用于积累通过数/额度）
      if (enabled.has("submit") && !failure && pickFile) {
        await runStage("submit", "自动提交", async () => {
          const rows = excel.readTableRows(pickFile).map(excel.importRowToAnswer);
          return startTask("submit", {
            filePath: pickFile,
            results: rows,
            bitEnvs,
            submitLimit: settings.submitLimit,
            accountDailyLimit: settings.accountDailyLimit,
            dailyAnswerLimit: settings.dailyAnswerLimit,
            forceResubmit: false,
            checkCompletedEnvs: true,
            accountTopics: settings.accountTopics,
            linkRouting: settings.linkRouting,
          }, (ctx) => runSubmitTask(ctx, deps()));
        });
      }

      // 网盘链的**账号分工**：转存归转存、上传归上传，两者可以不是同一批号。
      // 现实里常见「A 的网盘还有空间但没有批量发布权益，B 有权益但网盘已经满了」，
      // 分开之后 A 把资源转进自己盘并建好永久分享，B 只管把问答表传上工作台
      //（分享链接是公开的，谁上传都行）。两边都留空就回落到「本次参与的账号」。
      const roles = resolveNetdiskRoles(bitEnvs, p);
      const transferEnvs = roles.transferEnvs;
      const uploadEnvsConfigured = roles.uploadEnvs;
      // 上传账号在权益门之后会被收窄，但**搜资源**要按用户配的那批来（题材绑定挂在它们身上），
      // 所以配置值单独留一份。
      let uploadEnvs = uploadEnvsConfigured;

      // 权益门只针对**上传账号**：批量发布权益管的是"能不能把表传上工作台"，
      // 跟"资源能不能转进网盘"无关（后者看的是网盘空间）。也只在真要跑上传阶段时才查，
      // 免得白开一轮浏览器。
      if (!failure && !autoPipelineAborted && enabled.has("upload")) {
        const checked = await runStage("checkPermission", "确认批量发布权益", () =>
          startTask("check-published", { bitEnvs: uploadEnvsConfigured, withReasons: false }, (c) => runCheckPublishedTask(c, deps()))
        );
        if (checked && Array.isArray(checked.accounts) && checked.accounts.length) {
          // hasPermission 为 null 表示"没查到"，按不拦处理——不能因为查不到就误封账号。
          // 只看 hasPermission，**不看 ok**：ok=false 有三种成因（未登录 / 没取到上传记录 /
          // 查询抛错），它们在"有没有批量发布权益"这件事上都是**未知**，不是"没有"。
          // 以前写成 `a.ok && a.hasPermission !== false`，等于把"未知"一律当成"没有"，
          // 从没上传过的新账号和查询报错的账号全被判「没有权益」，网盘链整段跳过。
          const allowed = checked.accounts.filter((a) => a.hasPermission !== false).map((a) => a.envLabel);
          const denied = uploadEnvsConfigured.filter((e) => !allowed.includes(e));
          if (denied.length) emit("task:log", `⚠️ 这些上传账号没有「批量发布权益」或未登录，上传阶段会跳过：${denied.join("、")}`);
          uploadEnvs = allowed;
          if (!allowed.length) emit("task:log", "没有上传账号具备「批量发布权益」，上传阶段跳过（转存仍按转存账号执行）。");
        }
      }

      // 5) 网盘转存：脚本套模板生成问答行（qa-template-lib），产出即上传专用表
      if (enabled.has("transfer") && !failure && transferEnvs.length) {
        let transferTable = String(p.transferTablePath || "").trim();
        // 没给资源表 → 按账号绑定的题材自动搜一批（纯协议搜百度知道，不需要浏览器）
        if (!transferTable || !fs.existsSync(transferTable)) {
          emit("task:log", "没有指定资源表，改为按账号绑定的题材自动搜资源…");
          const searched = await runStage("search", "搜资源（按账号题材）", () =>
            startTask("search-resources", {
              bitEnvs: uploadEnvsConfigured,
              pages: Number(p.searchPages) || 0,
              limit: Number(p.searchRowLimit) || 0,
            }, (c) => runSearchResourcesTask(c, deps()))
          );
          if (searched && searched.outputPath && fs.existsSync(searched.outputPath)) transferTable = searched.outputPath;
        }
        if (!transferTable || !fs.existsSync(transferTable)) {
          emit("task:log", "跳过「网盘转存」：没有可用的资源表。");
          report.push({ stage: "transfer", label: "网盘转存", ok: false, skipped: true, error: "未指定资源表，自动搜索也没产出" });
        } else {
          await runStage("transfer", "网盘转存（套模板生成问答）", async () => {
            const result = await startTask("batch-transfer", {
              filePath: transferTable,
              bitEnvs: transferEnvs,
              destDir: String(p.transferDestDir || "").trim() || "/来自资源批量转存",
              outName: String(p.transferOutName || "").trim(),
              perEnv: Number(p.transferPerEnv) || 50,
              cc: Number(p.transferCc) || 4,
              delayMin: Number(p.transferDelayMin) || 1,
              delayMax: Number(p.transferDelayMax) || 2,
              makeShare: true,
            }, (ctx) => runBatchTransferTask(ctx, deps()));
            // 转存产出的上传专用表直接喂给下一阶段，不用人工再选一次文件
            if (result && result.outputPath) {
              uploadTable = result.outputPath;
              emit("task:log", `转存产出上传专用表：${uploadTable}（${result.count} 条）`);
            }
            return result;
          });
        }
      }

      // 6) 按题材分账号上传（用转存产出，或调用方指定的现成表）
      if (enabled.has("upload") && !failure && uploadEnvs.length) {
        if (!uploadTable || !fs.existsSync(uploadTable)) {
          emit("task:log", "跳过「按题材上传」：没有可用的上传专用表（请先跑转存，或指定一张现成的表）。");
          report.push({ stage: "upload", label: "按题材上传", ok: false, skipped: true, error: "未指定上传专用表" });
        } else {
          const uploaded = await runStage("upload", "按题材上传", () =>
            startTask("upload-by-topic", {
              filePath: uploadTable,
              bitEnvs: uploadEnvs,
              accountTopics: settings.accountTopics,
              topicRules: settings.topicRules,
              batchRows: Number(p.batchRows) || 500,
              maxBatches: Number(p.maxBatches) || 999,
            }, (ctx) => runTopicUploadTask(ctx, deps()))
          );
          // 上传完顺手核对收录。上传接口返回 200 只代表**平台收下了**，
          // 平台还要异步审核，收录结果要单独查——不查的话"上传成功"是句空话。
          if (uploaded && !failure && !autoPipelineAborted) {
            await runStage("checkPublished", "查收录（核对是否被收录）", () =>
              startTask("check-published", { bitEnvs }, (c) => runCheckPublishedTask(c, deps()))
            );
          }
        }
      }
    } finally {
      autoPipelineAborted = false;
    }

    const okCount = report.filter((r) => r.ok).length;
    const tail = autoPipelineAborted ? "（已手动停止）" : failure ? `（在「${report.find((r) => !r.ok && !r.skipped)?.label}」中断）` : "";
    emit("task:log", `══════ 一键全自动结束：${okCount}/${report.length} 个阶段成功 ${tail} ══════`);
    return { ok: !failure && !autoPipelineAborted, stopped: autoPipelineAborted, stages: report, pickFile };
  });

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
    // 用带兜底的写法：目标文件正被 Excel/WPS 打开时直写会 EBUSY，
    // 渲染端这条链路没有 catch，用户只会看到"点了没反应"，以为已经导出了。
    const savedPath = excel.writeWorkbookSafe(choice.filePath, rows.map(excel.answerToRow), "答案记录", excel.ANSWER_HEADERS,
      (message) => logger.log(message));
    return { canceled: false, filePath: savedPath, count: rows.length, keyword: keyword || "" };
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
    // 必须与 random-pick.js 的 keyOf 完全一致，否则"已抽"永远匹配不上：
    // 这里曾写成 /s+/g（漏了反斜杠，剥掉的是字母 s 而不是空白字符），剩余可抽数长期虚高。
    const keyOf = (item) => {
      const url = String(item.questionUrl || "").trim().toLowerCase();
      return url ? `url:${url}` : `title:${String(item.title || "").replace(/\s+/g, "").toLowerCase()}`;
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

  // 软件更新（GitHub Releases；仅打包版可用，开发模式直接拒绝）
  // 下载有 20%~100% 节流日志；下载完成后退出软件即自动安装（也可在界面点「重启并安装」）。
  // 国内直连 GitHub 不稳定，失败时日志会给出发布页链接，可用浏览器手动下载兜底。
  const RELEASES_URL = "https://github.com/66666666218/baiduzhidao/releases/latest";
  let updateReady = false; // 新版已下载完成
  let updateAvailable = ""; // 已知有新版的版本号（尚未下载）
  let wantDownload = false; // 本次检查是否顺带下载
  let lastProgressLog = 0;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => emit("task:log", "检查更新中…"));
    autoUpdater.on("update-available", (info) => {
      updateAvailable = info.version;
      // 结构化推送：界面顶部的更新提示靠这个，不靠解析下面的日志文本
      emit("update:available", { version: info.version, current: app.getVersion() });
      emit("task:log", wantDownload
        ? `发现新版本 v${info.version}，开始下载（约 85MB）…`
        : `发现新版本 v${info.version}（当前 v${app.getVersion()}），点界面顶部的提示即可下载安装。`);
    });
    autoUpdater.on("update-not-available", (info) => {
      updateAvailable = "";
      emit("task:log", `已是最新版本（v${info.version}），无需更新。`);
    });
    autoUpdater.on("download-progress", (p) => {
      if (p.percent - lastProgressLog >= 20 || p.percent >= 100) {
        lastProgressLog = p.percent;
        emit("task:log", `新版本下载中：${Math.round(p.percent)}%（${(p.transferred / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)} MB）`);
      }
    });
    autoUpdater.on("update-downloaded", (info) => {
      updateReady = true;
      updateAvailable = "";
      // 主动推给界面。此前界面是靠匹配下面这行日志文本来启用「重启并安装新版」按钮的，
      // 改一个字按钮就永远不亮且不报错——状态必须走结构化事件，不能走日志文本。
      emit("update:ready", { version: info.version });
      emit("task:log", `✅ 新版本 v${info.version} 下载完成。重启软件即自动安装；也可在「使用教程 → 软件更新」点「重启并安装新版」立即完成。`);
    });
    autoUpdater.on("error", (e) => {
      emit("task:log", `⚠️ 更新失败：${e.message}`);
      emit("task:log", `可改用手动更新：浏览器打开发布页 ${RELEASES_URL} 下载最新安装包直接安装（答题数据不受影响）。`);
    });
  } catch (e) {
    logger.log(`更新模块初始化失败（不影响其他功能）：${e.message}`);
  }

  /**
   * 检查更新。
   * download=true 顺带下载（用户主动点「检查更新」）；
   * download=false 只查不下载（启动静默检查用）。
   *
   * 必须按调用设置 autoDownload：它是全局开关，一直开着的话启动静默检查
   * 会在用户毫不知情的情况下把 85MB 下下来。
   */
  async function checkForUpdates({ download }) {
    if (!app.isPackaged) throw new Error("开发模式不支持在线检查更新（仅打包版可用）。");
    const { autoUpdater } = require("electron-updater");
    wantDownload = Boolean(download);
    autoUpdater.autoDownload = wantDownload;
    lastProgressLog = 0;
    await autoUpdater.checkForUpdates();
    return { currentVersion: app.getVersion() };
  }

  ipcMain.handle("update:check", () => checkForUpdates({ download: true }));
  ipcMain.handle("update:install", () => {
    if (!updateReady) throw new Error("新版尚未下载完成，请先「检查更新」并等待下载完成。");
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
  ipcMain.handle("update:info", () => ({
    version: app.getVersion(),
    supported: Boolean(app.isPackaged),
    ready: updateReady, // 新版是否已下载好（界面据此启用「重启并安装新版」）
    available: updateAvailable, // 有新版但还没下载时的版本号（界面据此显示顶部提示）
    releasesUrl: RELEASES_URL,
  }));

  // 启动静默检查：只查不下载，有新版就在界面顶部提示，由用户决定要不要下。
  // 延后 20 秒是避开启动时的初始化与自检，别去抢带宽和主线程。
  // 开发模式（app.isPackaged=false）会直接抛错被吞掉，不会发请求。
  setTimeout(() => {
    checkForUpdates({ download: false }).catch((e) => {
      // 只说"失败"没用：这一条最常见的两种成因是「线上根本没发布过」和「国内连不上 GitHub」，
      // 两者要处理的事完全不同。原始错误串（如 HttpError 404）用户看不懂，所以补一句人话。
      const raw = String((e && e.message) || e).slice(0, 120);
      emit("task:log", `启动检查更新失败（不影响使用）：${describeUpdateError(raw)}。原始错误：${raw}`);
      emit("task:log", `可稍后在「使用教程 → 软件更新」手动重试，或用浏览器打开发布页 ${RELEASES_URL} 手动下载。`);
    });
  }, 20000).unref?.();

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

/** file: URL 是否正好指向本程序的某个本地页面（忽略 hash，带查询即拒绝） */
function isSameLocalPage(url, filePath) {
  if (!/^file:/i.test(String(url || ""))) return false;
  try {
    const parsed = new URL(url);
    if (parsed.search) return false;
    // Windows 下 pathname 形如 "/D:/code/.../index.html"，要先去掉开头的斜杠再归一化
    const onDisk = decodeURIComponent(parsed.pathname).replace(/^\/+([A-Za-z]:)/, "$1");
    return path.normalize(onDisk).toLowerCase() === path.normalize(filePath).toLowerCase();
  } catch {
    return false;
  }
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
      // 显式写死：这个窗口挂了 31 条高权 IPC 通道（任意路径读写、打开数据目录…），
      // Electron 默认值随大版本会变，写清楚防升级后静默放开。
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  // 渲染层只加载本地文件：任何跳外站/开新窗口的行为都不是本程序的功能，
  // 一旦放行就等于把 window.api 交到远端页面手里。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logger.log(`已拦截新窗口请求：${url}`);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    // 只看 file: 前缀不够：临时目录/下载目录里随便一份 HTML 都能把主窗口导航过去，
    // 那个页面照样挂着 window.api 的全部通道。只放行我们自己这一页。
    if (!isSameLocalPage(url, path.join(__dirname, "renderer", "index.html"))) {
      event.preventDefault();
      logger.log(`已拦截页面跳转：${url}`);
    }
  });
  // 本程序不需要任何受限权限（地理/摄像头/剪贴板写入/通知…），Electron 的默认放行策略随版本会变，写死拒绝。
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    logger.log(`已拒绝权限请求：${permission}`);
    callback(false);
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

/**
 * 冒烟点按钮时各通道返回的"空结果"形状。
 *
 * 默认是 {}，但少数处理器会直接解引用返回值（list.forEach / result.steps.filter /
 * result.stats.xxx），空对象会把它们噎住——那是**桩数据的假阳性**，不是真 bug。
 * 假阳性一旦混进来，这个守卫很快就会没人看，所以宁可在这里补形状。
 * 新增通道报假阳性时，往这里加一行即可。
 */
const SMOKE_RESULT_SHAPES = {
  "netdisk:accounts:list": [],
  "app:selftest": { ok: true, steps: [] },
  "task:crawl-home": { stopped: false, count: 0, stats: {}, outputPath: "" },
  "task:search-resources": { count: 0, stats: {}, outputPath: "" },
  "task:check-published": { accounts: [], checked: 0, outputPath: "", failedPath: "", failedRows: 0 },
};

/** 冒烟自检：渲染端脚本无错误 + preload 桥可用 + 初始化完成 + 点遍按钮无处理器错误 */
async function smokeCheck() {
  const window = createWindow({ smoke: true });
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  // 加载失败时 did-finish-load 永远不来，打包冒烟会无限挂住 CI；
  // 这里用超时兜底，让 --smoke 无论如何都以非 0 退出并说明原因。
  const loaded = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 20000);
    window.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve("ok"); });
    window.webContents.once("did-fail-load", (_e, code, description) => { clearTimeout(timer); resolve(`fail:${code} ${description}`); });
  });
  if (loaded !== "ok") errors.push(`页面加载未完成（${loaded}）`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const bridgeOk = await window.webContents.executeJavaScript("typeof window.api === 'object' && typeof window.api.invoke === 'function'");
  const bankOk = await window.webContents.executeJavaScript("document.getElementById('bankStats') && document.getElementById('bankStats').textContent.length >= 0");

  // 把全部 IPC 通道换成空实现，然后点遍所有按钮。
  //
  // 为什么要这样：加载期错误由上面的 console-message 能收，但**事件处理器体内**的错误
  //（典型是引用了不存在的变量）只有点下去才炸——冒烟一直全绿也发现不了。
  // 换掉 handler 之后真实副作用一个都不会发生：提交答案、上传资源、开文件夹、
  // 弹文件框、装更新全部被截断，所以 confirm 一律放行也是安全的。
  const { ipcMain } = require("electron");
  for (const channel of INVOKE_CHANNELS) {
    try { ipcMain.removeHandler(channel); } catch { /* 本来就没注册 */ }
    ipcMain.handle(channel, () => (SMOKE_RESULT_SHAPES[channel] ?? {}));
  }
  const probe = await window.webContents.executeJavaScript(`(async () => {
    const collected = [];
    window.addEventListener("error", (e) => collected.push("error: " + (e.message || String(e.error))));
    window.addEventListener("unhandledrejection", (e) => collected.push("rejection: " + ((e.reason && e.reason.message) || String(e.reason))));
    window.confirm = () => true;
    window.alert = () => {};
    window.prompt = () => null;
    // 先把表单填满再点。否则绝大多数处理器会在「请先选择文件」这类前置校验处提前 return，
    // 处理器体后半段——正是出错的地方——根本执行不到，点了等于没点（已实测）。
    document.querySelectorAll("input, textarea").forEach((el) => {
      if (el.type === "checkbox" || el.type === "radio") { el.checked = true; return; }
      if (el.value) return;
      el.value = el.type === "number" ? "5" : "smoke.xlsx";
    });
    document.querySelectorAll("select").forEach((el) => { if (el.selectedIndex < 0) el.selectedIndex = 0; });
    // 处理器普遍把自己包在 try/catch 里、只把 error.message 写进日志面板，
    // 这类错误既不会冒泡到 window 也不进 console——只能回头读日志。
    // 必须**边点边采**：按钮列表末尾就有「清空日志」，点完再读等于什么都没读（实测踩过）。
    const BUG_SIGNATURE = /is not defined|is not a function|Cannot read propert|Cannot access '|ReferenceError|TypeError|SyntaxError|Unexpected token/;
    const seen = new Set();
    const scanLog = () => {
      const view = document.getElementById("logView");
      if (!view) return;
      // 逐个子节点读：textContent 会把所有 div 拼成一整段（div 之间没有换行符），
      // 拼完就分不清是哪一条报的错了。
      for (const node of view.children) {
        const line = node.textContent || "";
        if (BUG_SIGNATURE.test(line)) seen.add(line.trim().slice(0, 200));
      }
    };
    const buttons = Array.from(document.querySelectorAll("button")).filter((b) => !b.disabled);
    for (const button of buttons) {
      try { button.click(); } catch (error) { collected.push("click#" + (button.id || "") + ": " + error.message); }
      await new Promise((resolve) => setTimeout(resolve, 0));
      scanLog();
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    scanLog();
    for (const line of seen) collected.push("日志里的代码错误: " + line);
    return { clicked: buttons.length, errors: collected };
  })()`).catch((error) => ({ clicked: 0, errors: ["点击探测未执行：" + error.message] }));
  errors.push(...(probe.errors || []));

  const result = { bridgeOk, bankOk, clicked: probe.clicked, rendererErrors: errors };
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
  try {
    store.releaseLock();
  } catch (error) {
    console.error("[shutdown] lock release failed:", error);
  }
  // 审计事件走的是异步批量队列：不显式同步刷盘，退出前最后几条（往往正是失败那条）会丢。
  // 这里刻意不关浏览器环境：关环境属于账号侧动作，退出时替用户关掉他手动开着的环境不合适。
  try {
    auditLogger.flushSync();
  } catch (error) {
    console.error("[shutdown] audit flush failed:", error);
  }
}

function getMainWindow() {
  return mainWindow;
}

module.exports = { registerIpc, createWindow, dataDir, smokeCheck, shutdown, getMainWindow };
