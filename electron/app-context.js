"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { Config, nowText, nowTimeText, CATEGORIES } = require("./src/config");
const { Logger } = require("./src/log");
const { Store } = require("./src/storage/store");
const excel = require("./src/storage/excel");
const { createAdapter, BrowserPool } = require("./src/browser");
const { LlmClient } = require("./src/llm/client");
const { TaskManager } = require("./src/tasks/manager");
const { runCrawlTask } = require("./src/tasks/crawl");
const { runSearchResourcesTask } = require("./src/tasks/search-resources");
const { runCheckPublishedTask } = require("./src/tasks/check-published");
const { runGenerateTask } = require("./src/tasks/generate");
const { runSubmitTask } = require("./src/tasks/submit");
const { runPassedCountTask } = require("./src/tasks/passed-count");
const { runBatchTransferTask } = require("./src/tasks/batch-transfer");
const { runBatchUploadTask, runTopicUploadTask } = require("./src/tasks/upload-batch");
const { makePickQuestions } = require("./src/tasks/pick");
const { EventBus } = require("./src/events/bus");
const { AuditLogger } = require("./src/audit/logger");
const { INVOKE_CHANNELS } = require("./src/ipc-channels");
// ⚠️ `isProxyError` 不在这里 require：第 18-C 轮起"重试"不再按错误类型分支
//（当前设置 → 临时直连，两种都试），所以它只剩一个消费者 = `describeUpdateError`
// 内部的文案判定 —— 判定规则本来就住在 `errors.js`，这里再 import 一次就是死绑定。
const { describeUpdateError, describeError, scrubUrl } = require("./src/errors");
const { resolveNetdiskRoles, envLabelsOf } = require("./src/domain/account-topic");
const { createAutoPipeline } = require("./src/workflows/auto-pipeline");
// 「一键全自动跑着的时候外部任务不许开工」这条规则唯一的一份实现。
// 放在 src/workflows/pipeline-guard.js 而不是直接写在本文件里，是因为本文件 require("electron")、
// 测试加载不起来 —— 规则写在那边就只能"扫文本"验证，而扫文本读不出逻辑（2.0.44 就是这么翻的车）。
const { pipelineBlocksTask, pipelineBlockedMessage, pipelineStartTask } = require("./src/workflows/pipeline-guard");
const { AccountManager } = require("./src/browser/account-manager");
// 「从比特窗口提取 Cookie」这条通道要连 CDP 取 Cookie，所以主进程仍然需要 chromium。
// （2026-10-10：查收录/权益检查已搬到 src/tasks/check-published.js，且**优先用「账号凭证」里存的
//   Cookie、不开窗口**；这里保留只是因为还有上面这条通道和登录窗口。）
// 之前漏了它，直接把「查收录」「账号总览」打成一跑就 ReferenceError: chromium is not defined，
// 而日志只显示「查收录失败」，完全看不出是少了一行 import。
const { chromium } = require("playwright-core");

let mainWindow = null;
let clipboardApi = null; // registerIpc 时注入（供任务内剪贴板兜底）
let currentAutosavePath = ""; // 当前任务的 CSV 自动保存文件
let autosaveSeq = 0; // 同一分钟内连起两个任务时区分自动保存文件
// 一键全自动的编排实例（在 registerIpc 里装配）。放在模块级是因为
// 「停止」按钮要对它喊一声：TaskManager.stop 只能停当前任务，而编排在阶段之间
// 还要决定"下一阶段是否该开始"。没有它，用户点了停止，编排仍会把后续阶段依次拉起来。
let autoPipeline = null;

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
// 账号档案（封禁/额度/健康度）**必须是进程级单例**。
// 以前 `submit.js` 写的是 `deps.accountManager || new AccountManager(...)`，而 deps 里从来没有
// 这个字段 —— 于是每次跑都是新建一个临时对象，`markBlocked()` 还额外套了一层
// `if (deps.accountManager)` 的守卫。结果：注释里承诺的"连续失败自动标记账号需人工检查"
// **一次都没生效过**，`account.blocked` 事件也从未发出过。这类"看着在工作、实际是空操作"
// 的代码在这个项目里已经出过好几次，所以这里显式建单例并注入 deps。
const accountManager = new AccountManager({ store, dailyLimit: 0 });
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
// 把「按环境名取网盘凭据」交给 BrowserPool：存过凭据的环境会改用 headless Edge，
// **完全不开比特窗口** —— 内存不够的机器靠这个才能跑起来。
// 没存过的仍走比特（同时也保留比特的指纹隔离能力）。
// 浏览器引擎由设置决定：默认 "bit"（指纹浏览器，一环境一指纹）。
// 选 "headless" 才用系统 Edge —— 省内存，但**所有账号共用同一份指纹**，
// 隔离性下降，多账号运营需自行权衡（设置页有明确说明）。
// 传函数而不是取值：用户在设置页改了「运行模式」应立即生效，不该要求重启软件。
const browserPool = new BrowserPool(createAdapter({ apiUrl: config.load().apiUrl }), {
  mode: () => (String(config.load().browserMode || "bit") === "headless" ? "headless" : "bit"),
  credentialOf: (envLabel) => {
    try {
      const { credentialOf: pick } = require("./src/netdisk/manager");
      return pick(dataDir, envLabel);
    } catch { return null; }
  },
});
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
    // 账号档案单例：任务通过它 acquire / markBlocked，状态在整个进程内共享
    //（以前 submit 拿不到它，于是"连续失败标记账号"从未生效 —— 详见模块顶部的注释）
    accountManager,
    dataDir,   // 与「打开数据目录」/批量转存输出一致的基准目录
    // 让任务能拿到「账号凭证」里存好的凭据：submit 用它走纯协议提交（不开窗口），
    // batch-transfer 用它免去开窗口取网盘凭证。
    // 该账号配了代理就返回 dispatcher（纯协议请求用它走代理）；没配返回 undefined（直连）
    proxyOf: (envLabel) => {
      try {
        const { dispatcherFor } = require("./src/netdisk/proxy");
        const proxies = require("./src/netdisk/proxy").parseAccountProxies(settings.accountProxies || "");
        return dispatcherFor(proxies[envLabel]);
      } catch { return undefined; }
    },
    credentialOf: (envLabel) => {
      try { const { credentialOf: pick } = require("./src/netdisk/manager"); return pick(dataDir, envLabel); }
      catch { return null; }
    },
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
// 构建标识：日志首行即可辨识版本，用来排查"装的其实是旧包"。
// ⚠️ 版本号必须**自动取**（app.getVersion 读的就是 package.json / 安装包里的版本），
// 不能手写死字符串 —— 这里原先写的是 "2026-09-28-F（修复：…）"，一直没跟着版本走，
// 到 2.0.28 还挂着 9 月 28 日那行，等于这个标识**已经不能用来判断版本了**。
// 顺带把数据目录打出来：用户反馈问题时，这一行就能定位他的数据在哪、是不是装了两个版本。
logger.log(`软件版本 v${app.getVersion()}（${app.isPackaged ? "安装版" : "开发版"}）· 数据目录 ${dataDir}`);

// ---------- 任务包装 ----------

/**
 * @param {object} [options]
 * @param {boolean} [options.fromPipeline] 这次调用是不是「一键全自动」编排发起的。
 *   只有编排注入的那一份（见 pipelineStartTask）会带上它 —— 界面上手点的、脚本调的都不带。
 *   ⚠️ 少了这个区分就是 2.0.44 的 P0 回归：编排自己也是通过 startTask 逐个启动阶段，
 *   那把"一键全自动正在运行中"的锁会把编排自己的第一个阶段挡在门外，
 *   整条链瞬间以「0/2 个阶段成功」结束（用户看到的就是这个）。
 */
async function startTask(name, payload, runner, options = {}) {
  // 互斥检查必须在这里、且在下面的 try 之前做：
  // 放进 tasks.start 的异常里统一处理，会给"用户连点两次"这种启动拒绝也广播一次
  // status:"failed"，把仍在正常运行的上一个任务的进度条改成"失败"并重新启用按钮。
  tasks.assertIdle();
  // 一键全自动**不在** TaskManager 里跑（它按阶段逐个调 startTask，自己只是编排），
  // 所以 tasks.assertIdle() 看不见它 —— 阶段之间（尤其"抽题"那一步，它根本不是任务）
  // this.current 是空的，此时用户手点「爬题」就会被放行，两条链同时跑、抢同一批浏览器
  // 窗口和同一份台账。这里用编排自己的状态补上这把锁。
  // 判据的三条分支（含"编排自己发起的必须放行""已点停止的必须放行"）都在
  // pipeline-guard.js 里，只有一份 —— 那边是纯函数，单测能直接打真逻辑。
  if (pipelineBlocksTask({
    pipelineRunning: Boolean(autoPipeline && autoPipeline.isRunning()),
    pipelineAborted: Boolean(autoPipeline && autoPipeline.isAborted()),
    fromPipeline: Boolean(options.fromPipeline),
  })) {
    // 被拒也必须留痕：以前这层只在渲染端弹出"爬取失败：…"，而渲染端的日志面板不进日志文件，
    // 用户导出的日志里就一点痕迹都没有 —— 看起来像"我点了，但什么都没发生"。
    logger.log(`⛔ 已拒绝启动「${name}」：${pipelineBlockedMessage()}`);
    throw new Error(pipelineBlockedMessage());
  }
  // 脚本类工具（scripts/*.js）会另起一个 Store 写同一份 JSON，两边各持内存缓存整份覆写。
  // 主程序这边只警告不拦停：拦在 GUI 上会让人以为软件坏了，脚本那边则直接拒绝启动。
  const foreignWriter = store.detectForeignWriter();
  if (foreignWriter) {
    logger.log(`⚠️ 检测到另一个写入者（${foreignWriter.owner} · 进程 ${foreignWriter.pid}，${Math.round(foreignWriter.idleMs / 1000)} 秒前还在活动）正在写同一份数据目录，` +
      "两边会互相覆盖题库/记录。请先关掉它（命令行工具或主程序）再继续。");
  }
  // 「这次到底哪几个号会参与」必须在开工第一行就打出来。
  // 账号选错是成本最高的一类错误（答案已发出、额度已扣，撤不回来），而每个入口
  // 取号的地方都不一样（本页账号框 / 设置页全量 / 一键全自动的账号分工）——
  // 不在这里统一留痕，用户只能靠猜"这次跑的到底是哪几个号"。
  // 同名写两遍要当场点名：那会生成两个同名 slot，**那个号会被执行两遍**。
  const envLabels = payload && Array.isArray(payload.bitEnvs)
    ? envLabelsOf(payload.bitEnvs)
    : (payload && String(payload.bitEnv || "").trim() ? [String(payload.bitEnv).trim()] : []);
  if (envLabels.length) {
    logger.log(`本次参与账号（${envLabels.length} 个）：${envLabels.join("、")}`);
    const unique = Array.from(new Set(envLabels));
    if (unique.length !== envLabels.length) {
      logger.log(`⚠️ 账号名单里有重复名字（${envLabels.length} 行 / ${unique.length} 个不同账号），`
        + "重复的号会被执行两遍 —— 请检查来源（本页账号框 / 设置页「比特环境名称」）。");
    }
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
    // 落盘失败**不能把已经跑完的任务报成失败**（以前 flushAll 中途抛出就会那样），
    // 但也不能装作没发生 —— 说清楚是哪份数据没写出去。
    const flushFailed = store.flushAll();
    if (flushFailed.length) {
      logger.log(`⚠️ 有数据没能落盘：${flushFailed.map((f) => `${f.name}（${f.error}）`).join("、")}`
        + "。任务本身已完成，但这些内容可能没保存下来 —— 请检查磁盘空间/文件是否被占用。");
    }
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
 * 用「知道侧」接口验证这份 Cookie 的登录态 —— 这是整条链的通行证。
 * 只带这两条就够：BDUSS 是百度全域 Cookie，网盘和知道通用；STOKEN 给网盘侧用。
 */
async function fetchZhidaoLogin(account) {
  const cookie = `BDUSS=${String(account.bduss || "").trim()}${account.stoken ? "; STOKEN=" + String(account.stoken).trim() : ""}`;
  const res = await fetch(`https://zhidao.baidu.com/api/loginInfo?t=${Date.now()}`, {
    headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36", Referer: "https://zhidao.baidu.com" },
    signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
  });
  return JSON.parse(await res.text());
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
    // 把设置里的账号登记进账号档案，这样「账号档案」在没跑过任务时也能列出全部账号
    //（已 blocked 的账号即使被移出设置也保留在档案里 —— 那正是需要被看见的状态）。
    accountManager.register((saved.bitEnvs || []).map((env) => env.label || env));
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
    if (autoPipeline) autoPipeline.abort(); // 手动停止时一并中止一键全自动的后续阶段
    const result = tasks.stop();
    // accepted=false = 此刻没有 TaskManager 任务在跑（典型：一键全自动正停在"抽题"或阶段之间）。
    // 以前一律只回 {ok:true}，界面那句"已发送停止请求，等待任务退出..."就成了空头承诺 ——
    // 用户不知道到底有没有东西被停掉，也不知道要等多久才解锁。
    if (result && result.accepted) {
      logger.log(`已请求停止「${result.taskName}」：任务会在下一个检查点自行退出；`
        + `若 ${Math.round((result.graceMs || 0) / 1000)} 秒内没退出来，会自动释放任务锁（之后可正常操作）。`);
    } else if (autoPipeline && autoPipeline.isRunning()) {
      logger.log("已请求停止一键全自动：当前阶段结束后不再启动后续阶段。");
    } else {
      logger.log("当前没有正在运行的任务（停止请求已忽略）。");
    }
    return result;
  });
  ipcMain.handle("task:pause", () => {
    const result = tasks.pause();
    // accepted=false = 此刻没有 TaskManager 任务（一键全自动停在"抽题"或阶段之间就是这样）。
    // 以前这里什么都不说，界面那句"已请求暂停"也就不会出现 —— 用户点了暂停**一点反应都没有**，
    // 而他要的是"先停下别往下跑"。停止按钮上一轮已经区分了这种情况（见上面 task:stop），
    // 暂停/恢复这两个入口是同一类问题，一起补上。
    if (!result || !result.accepted) {
      logger.log("当前没有可暂停的任务（一键全自动停在阶段之间时就是这样）—— 若想让它别再往下跑，请点「停止当前任务」。");
    }
    return result;
  });
  ipcMain.handle("task:resume", () => {
    const result = tasks.resume();
    if (!result || !result.resumed) logger.log("当前没有处于暂停状态的任务（恢复请求已忽略）。");
    return result;
  });
  ipcMain.handle("task:history", () => ({ current: tasks.currentState(), history: tasks.historyList() }));

  // 账号档案（本地状态）：让"连续失败自动标记需人工检查"这件事**看得见、解得开**。
  // 以前这个标记只存在于内存里、没有任何界面入口 —— 用户只会发现某个号突然不跑了。
  ipcMain.handle("accounts:overview", () => ({ accounts: accountManager.list() }));
  ipcMain.handle("accounts:unblock", (_event, payload) => {
    const name = String((payload && payload.name) || "").trim();
    if (!name) throw new Error("缺少账号名");
    accountManager.unblock(name);
    return { ok: true, accounts: accountManager.list() };
  });
  ipcMain.handle("task:running", () => ({ running: tasks.isRunning() }));

  // 比特浏览器
  ipcMain.handle("bit:check", async () => {
    return browserPool.adapter.checkConnection();
  });

  // 爬题
  ipcMain.handle("task:crawl", (_event, payload) => startTask("crawl", payload, (ctx) => runCrawlTask(ctx, deps())));

  // 随机抽题
  // 抽成具名函数：一键全自动编排要复用同一段逻辑，不能把它抄第二遍
  // 抽题实现搬到了 src/tasks/pick.js —— 脚本跑整链时与界面**共用同一份**去重口径，
  // 否则"我跑一遍"就不等于"你点一遍"，验证也就失去意义。
  const pickQuestions = makePickQuestions({
    store,
    config,
    emit,
    defaultSaveDir: app.getPath("desktop"),
    chooseSavePath: async (defaultPath) => {
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: "保存随机抽题表格",
        defaultPath,
        filters: [{ name: "Excel 表格", extensions: ["xlsx"] }],
      });
      return choice.canceled || !choice.filePath ? null : choice.filePath;
    },
  });
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
    // 校验分两步，**主次不能颠倒**：
    //   ① 知道侧登录态（/api/loginInfo）—— 这才是"整个软件的通行证"，提交/爬题/上传都靠它，必须有效；
    //   ② 网盘容量（/api/quota）—— 只影响网盘链，**失败不该拦住添加**：
    //      只登录了知道、没登网盘的账号，对答题链完全够用，以前用网盘接口校验会把它们误拒。
    const login = await fetchZhidaoLogin(account).catch(() => null);
    if (!login || Number(login.isLogin) !== 1) {
      throw new Error("这个 Cookie 的百度登录态无效或已过期（知道侧 isLogin≠1）。请重新登录后复制新的 Cookie。");
    }
    const quota = await manager.quota(account).catch(() => null);
    const accounts = manager.loadAccounts(dataDir).filter((a) => a.name !== name);
    // 网盘查不到时也要记 quotaOk=false + 原因：界面据此显示「网盘未连接」，
    // 而不是留空让人以为是"还没查过"。字段与 netdisk:accounts:refresh 保持一致。
    accounts.push({
      ...account,
      userName: String(login.userName || ""),
      quotaOk: Boolean(quota && quota.valid),
      totalGB: quota && quota.valid ? quota.totalGB : null,
      freeGB: quota && quota.valid ? quota.freeGB : null,
      quotaErrno: quota && quota.valid ? 0 : (quota && quota.errno !== undefined ? quota.errno : null),
      quotaReason: quota && quota.valid ? "" : String((quota && quota.reason) || "未知原因"),
      quotaAt: new Date().toISOString(),
    });
    manager.saveAccounts(dataDir, accounts);
    return { valid: true, userName: String(login.userName || ""), totalGB: quota ? quota.totalGB : null, freeGB: quota ? quota.freeGB : null, netdiskOk: Boolean(quota && quota.valid) };
  });
  /**
   * 软件内登录窗口：用户在这里登录百度，软件自己把 Cookie 读出来。
   *
   * 为什么比"让用户 F12 复制"好：不用教用户开开发者工具、不用开比特、也不会
   * 把多个域的 Cookie 拼错（这是最常见的失败原因）。登录窗口和主窗口共享同一个
   * session，所以登录完直接读 session 就行。
   *
   * 登录成功的判定：轮询 session 里的 BDUSS。一旦出现就说明登进去了，
   * 立刻读全量、关窗、返回 —— 不需要用户再点任何按钮。
   */
  ipcMain.handle("auth:login-and-extract", async (_e, p) => {
    const { BrowserWindow, session } = require("electron");
    // 默认直接跳到百度登录页 —— 它自带「扫码登录」tab，用户掏出手机扫一下就行，
    // 省得还要在页面里找登录入口（以前默认去网盘首页，得先点"登录"）。
    const loginUrl = String((p && p.url) || "").trim() || "https://passport.baidu.com/v2/?login&tpl=mn&u=https%3A%2F%2Fpan.baidu.com%2F";
    const partition = "persist:baidu-login";   // 独立分区，不和主窗口的 session 混
    const ses = session.fromPartition(partition);
    // UA 必须伪装成普通 Chrome：Electron 默认 UA 里带 `Electron/33.x`，
    // 百度一眼就能认出"这不是普通浏览器"。改掉之后，登录窗口在站点看来
    // 和一份普通 Chrome 无异（指纹仍是同一份 —— 但登录是低危动作，
    // 真正敏感的提交/上传全走纯协议，不带任何浏览器指纹）。
    const LOGIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
    try { ses.setUserAgent(LOGIN_UA); } catch { /* 忽略 */ }
    const win = new BrowserWindow({
      width: 1100, height: 800, autoHideMenuBar: true, title: "登录百度（登录完成后本窗口自动关闭）",
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try { win.webContents.setUserAgent(LOGIN_UA); } catch { /* 忽略 */ }
    // 每次开都从干净状态开始：上一次残留的登录态会让人误以为"已经登过了"
    try { await ses.clearStorageData({ storages: ["cookies"] }); } catch { /* 忽略 */ }
    await win.loadURL(loginUrl).catch(() => {});

    const readBduss = async () => {
      const list = await ses.cookies.get({ domain: ".baidu.com" }).catch(() => []);
      return list.find((c) => c.name === "BDUSS" && c.value) || null;
    };
    const deadline = Date.now() + 5 * 60 * 1000;   // 给足 5 分钟，别催用户
    let hit = null;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) break;
      hit = await readBduss();
      if (hit) break;
      // 也扫一遍 zhidao 域（百度知道登录后 BDUSS 会落在 .baidu.com，这里只是兜底）
      const zd = await ses.cookies.get({ domain: "zhidao.baidu.com" }).catch(() => []);
      hit = zd.find((c) => c.name === "BDUSS" && c.value) || null;
      if (hit) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const all = await ses.cookies.get({}).catch(() => []);
    const pick = (n) => (all.find((c) => c.name === n && c.value) || {}).value || "";
    const bduss = pick("BDUSS");
    const stoken = pick("STOKEN");
    if (!win.isDestroyed()) win.destroy();
    if (!bduss) return { ok: false, reason: "没有检测到登录（窗口已关闭或超时）。请重新点「登录并提取」，在窗口里完成登录。" };
    // 顺便问一次账号名 —— 界面用它给"没填备注名"的情况自动命名，
    // 免得用户登录成功却因为没填名字丢掉这份 Cookie、还得重登一遍。
    let userName = "";
    try {
      const info = await fetchZhidaoLogin({ bduss, stoken });
      userName = String((info && info.userName) || "");
    } catch { /* 取不到就算了，不影响提取本身 */ }
    return { ok: true, bduss, stoken, userName };
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
  /**
   * 「刷新账号」必须**真的去网盘查一次**，而不是把本地存档再读一遍。
   *
   * 以前的 `netdisk:accounts:list` 只返回存档，而存档里的 `totalGB/freeGB`
   * 是**添加账号那一刻**写进去的快照 —— 之后再没更新过。于是界面上的「总容量/剩余」
   * 永远是几个月前的数字（用户看到的现象就是"显示不准"）；更糟的是网盘登录失效之后
   * （errno=-6，实测三个号全中），旧数字还挂在界面上，一点提示都没有 ——
   * 这属于"看着是最新的、其实是过期的"，比显示一个错数字更有害。
   *
   * 所以这里逐个账号真查一次 `/api/quota`，把**结果与原因一起**写回存档并返回：
   *   · quotaOk=true  → 实时值；
   *   · quotaOk=false → totalGB/freeGB 置空（不再拿旧值糊弄），并带上 quotaReason；
   * 调用方（界面）据此显示「登录已失效」这类人话，而不是一个看着很像真的旧数字。
   */
  ipcMain.handle("netdisk:accounts:refresh", async () => {
    const accounts = manager.loadAccounts(dataDir);
    if (!accounts.length) return [];
    const out = [];
    for (const acc of accounts) {
      // 网盘接口是**写敏感**的（限流按请求数算），这里串行且不加额外并发；
      // 单个账号失败不能中断整批（一个号过期不该连累其它号查不到）。
      const q = await manager.quota(acc).catch((e) => ({
        valid: false,
        name: acc.name,
        errno: null,
        reason: "查询失败：" + String((e && e.message) || e || "").slice(0, 80),
      }));
      // 查不到时 totalGB/freeGB 置空（不拿旧值糊弄），但**把上一次成功的值留成快照**：
      // 容量不会剧烈变化，上次的值仍有参考价值 —— 关键是必须标清它是"上次的"，不能当实时值摆出来。
      const wasOk = acc.quotaOk === true && acc.totalGB != null;
      out.push({
        ...acc,
        quotaOk: Boolean(q.valid),
        totalGB: q.valid ? q.totalGB : null,
        freeGB: q.valid ? q.freeGB : null,
        loginOk: q.valid ? true : Boolean(q.loginOk),
        lastTotalGB: q.valid ? acc.totalGB : (acc.lastTotalGB != null ? acc.lastTotalGB : (wasOk ? acc.totalGB : null)),
        lastFreeGB: q.valid ? acc.freeGB : (acc.lastFreeGB != null ? acc.lastFreeGB : (wasOk ? acc.freeGB : null)),
        lastQuotaAt: q.valid ? acc.quotaAt : (acc.lastQuotaAt || (wasOk ? acc.quotaAt : null)),
        quotaErrno: q.valid ? 0 : (q.errno === undefined ? null : q.errno),
        quotaReason: q.valid ? "" : String(q.reason || "未知原因"),
        quotaAt: new Date().toISOString(),
      });
    }
    manager.saveAccounts(dataDir, out);
    return out;
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
  ipcMain.handle("netdisk:empty-recycle", async (_e, p) => {
    const name = String(p && p.name || "");
    const acc = manager.loadAccounts(dataDir).find((a) => a.name === name);
    if (!acc) throw new Error("账号不存在");
    return manager.emptyRecycleBin(acc);
  });
  ipcMain.handle("netdisk:records", () => manager.transferRecords(dataDir));
  ipcMain.handle("task:batch-upload", (_event, payload) => startTask("batch-upload", payload, (ctx) => runBatchUploadTask(ctx, deps())));
  // 按题材分账号上传：把上传专用表按分类规则拆成各账号的份，逐个账号投递
  ipcMain.handle("task:upload-by-topic", (_event, payload) => startTask("upload-by-topic", payload, (ctx) => runTopicUploadTask(ctx, deps())));

  /**
   * 一键全自动：把「爬题 → 抽题 → 生成 → 提交 → 转存 → 上传」串成一条链。
   *
   * 编排本体搬到了 src/workflows/auto-pipeline.js（原来这里是 245 行的内联实现）。
   * 搬出来主要不是为了好看：内联版每个阶段都写成「勾选了 && !failure && 前置条件」，
   * 前置条件不满足时**直接不进分支、不留任何记录**，于是结论照样是"全部阶段成功"。
   * 新版所有"选了却没跑成"的跳过都会进 report，结论文案据此如实生成。
   *
   * 为什么在主进程按阶段串行调 startTask，而不是包成一个大任务：
   * TaskManager 是单任务互斥的（运行中再 start 会抛错）。分阶段串行，每个阶段
   * 各自是一个正常任务，进度/暂停/停止/日志语义完全不变；阶段之间检查中止旗标。
   */
  autoPipeline = createAutoPipeline({
    config,
    // ⚠️ 注入的**必须是** pipelineStartTask(startTask)，不能是裸 startTask。
    // 编排也是用 startTask 启动它自己每一个阶段的，而上面那把互斥锁只该锁"外部"调用 ——
    // 注入裸 startTask 就等于让编排把自己锁在门外（2.0.44 的 P0 回归，见 pipeline-guard.js 顶部）。
    // 用包装函数而不是让 auto-pipeline.js 自己传标记：编排拿到的就是这个函数，
    // 它里面任何阶段（含将来新增的）都只能调这一个，结构上不可能漏带标记。
    startTask: pipelineStartTask(startTask),
    taskDeps: deps,
    pickQuestions,
    emit,
    // 进度脉冲：让界面立刻进入「运行中」。暂停/停止按钮只在收到 task:progress 之后才启用，
    // 而各阶段往往要跑很久才第一次上报（爬题是整页爬完才 report）——不发这一下，
    // 这段时间界面是死的、暂停点不动，看起来像卡死了。
    // 阶段失败在**任务启动之前**时（比如抽题报"题库为空"），由编排传 "failed" 收尾，
    // 否则界面会永久停在运行中。
    pulse: (status = "running") => sendToRenderer("task:progress", { done: 0, total: 0, status }),
    dataDir,
    taskRunners: {
      crawl: runCrawlTask,
      generate: runGenerateTask,
      submit: runSubmitTask,
      checkPublished: runCheckPublishedTask,
      searchResources: runSearchResourcesTask,
      batchTransfer: runBatchTransferTask,
      topicUpload: runTopicUploadTask,
    },
    CATEGORIES,
    excel,
    fs,
    path,
    resolveNetdiskRoles,
    // 开工前预检用：纯协议模式下如果这些账号**一个可用凭据都没有**，直接拦住并说清
    // 两边名字差在哪 —— 否则会逐个回落到开比特窗口，而用户选纯协议正是为了不开窗口。
    credentialOf: (envLabel) => {
      try { const { credentialOf: pick } = require("./src/netdisk/manager"); return pick(dataDir, envLabel); }
      catch { return null; }
    },
    credentialHint: (envLabel) => {
      try { const { credentialHint: hint } = require("./src/netdisk/manager"); return hint(dataDir, envLabel); }
      catch { return ""; }
    },
  });
  ipcMain.handle("task:auto-pipeline", (_event, payload) => autoPipeline.run(payload));

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
    // 允许调用方**追加**能选的文件类型（默认 xlsx/xls/csv）。
    //
    // 为什么需要（2026-10-14）：批量转存的「资源表格」其实**一直支持 txt（一行一个链接）**
    // —— `tasks/batch-transfer.js` 里就有 `/\.txt$/i` 那一支。但选择框的 filters 只列了
    // xlsx/xls/csv，于是用户在界面上**根本选不到 txt**：功能在、入口没有，他只能来问
    // "能不能一行一个链接"。这里加的是入口，不是功能。
    // 只给真正需要的调用方开（把 txt 塞进"上传专用表"那种选择框只会让人选错文件）。
    //
    // ⚠️ 合并规则**只许住在 `storage/excel.js` 的 `mergePickExtensions`**，这里只负责调它。
    // 先前这里是内联的 `[...new Set(["xlsx","xls","csv", ...extra])]`：写死之后静态守卫照样全绿
    //（扫文本只看得见"接线"，看不见逻辑）—— 提成纯函数后测试才能真的喂参数、看返回值。
    const extraList = Array.isArray(payload && payload.extensions) ? payload.extensions : [];
    const exts = excel.mergePickExtensions(extraList);
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: (payload && payload.title) || "选择表格",
      properties: ["openFile"],
      filters: extraList.length
        ? [{ name: "表格 / 链接清单（一行一个）", extensions: exts }]
        : [{ name: "表格文件", extensions: exts }],
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

  // 软件更新（仅打包版可用，开发模式直接拒绝）
  // 下载有 20%~100% 节流日志；下载完成后退出软件即自动安装（也可在界面点「重启并安装」）。
  // ⚠️ **日志与界面一律不出现仓库地址**：electron-updater 的原始报错里带着完整的发布页 URL，
  // 以前直接把 `e.message` 打进日志（还有一句"用浏览器打开发布页 <URL>"），等于把仓库地址
  // 逐字印给用户看。现在：① 所有要进日志的文本先过 `errors.scrubUrl`；
  // ② 界面上「打开发布页」按钮和 `update:info.releasesUrl` 字段都移除（按钮还在但字段没了的话，
  // 点一下就是打开空链接 + 渲染端 `$("openReleases")` 取到 null 直接抛错）。
  // 需要自动更新能工作时，仓库名仍然只在包内的 `resources/app-update.yml` 里（那是更新源配置，
  // 不是日志）—— 想连这个也不留，就得把在线更新整条关掉。
  let updateReady = false; // 新版已下载完成
  let updateReadyVersion = ""; // 已下载好的版本号（界面要显示它，不能只给个布尔值）
  let updateAvailable = ""; // 已知有新版的版本号（尚未下载）
  let wantDownload = false; // 本次检查是否顺带下载
  // 下载中状态也留一份：界面刷新（或刚启动）时要能靠 `update:info` 复原出
  // "正在下载 42%" 这个状态，否则界面又会退回"当前版本 v2.0.44"那种什么都没发生的样子。
  let downloading = false;
  let downloadPercent = null;
  let lastProgressLog = 0;
  let lastProgressEmit = 0;
  // 「上一次检查更新是什么时候、成没成、为什么没成」——原来这份信息只进日志文件，
  // 界面上永远只有一句"当前版本 vX"。于是"我点过检查更新了吗？它到底查了没？"
  // 这个问题在界面上根本没法回答（用户 17:55 那次就是这么来问的）。
  let lastCheckAt = ""; // "HH:MM" 形式，只给人看，不参与判断
  let lastCheckOk = null; // null=还没查过 / true=成功 / false=失败
  let lastCheckWhy = ""; // 失败原因（人话，已过 scrubUrl）
  // >0 表示"正在重试序列里"。此时 `autoUpdater.on("error")` 不单独播报 ——
  // 一次失败会被 electron-updater 既 emit("error") 又 throw（AppUpdater.checkForUpdates 的
  // .catch 就是这么写的，实测）、再叠上重试序列，一次网络抖动能刷出三四条"⚠️ 更新失败"，
  // 用户会以为坏了三次。播报统一由 checkForUpdates 那边负责（它知道是第几次、下一步换什么方式）。
  let checkRetryDepth = 0;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoInstallOnAppQuit = true;
    // ⚠️ 这一整段里所有"要给人看"的文案都必须走 `logger.log`，**不能**用 `emit("task:log", …)`。
    // 两者看起来都能进界面的日志面板，但只有 `logger.log` 同时落进**日志文件**
    //（`logger.onLog` 会把同一行转给渲染端）。2026-10-14 用户报「点击检查更新并不能更新」时，
    // 我打开他的日志文件发现**一个字都没有更新记录** —— 只能去翻 electron-updater 的下载缓存，
    // 才看清它其实下载成功了。诊断信息进不了文件，等于没有。
    autoUpdater.on("checking-for-update", () => logger.log("检查更新中…"));
    autoUpdater.on("update-available", (info) => {
      updateAvailable = info.version;
      // 又发现了一个新版本：之前那个"已下载好"的就不再是最新的了，状态一并复位
      updateReady = false;
      updateReadyVersion = "";
      downloading = wantDownload; // 启动静默检查只查不下，不能显示成"下载中"
      downloadPercent = wantDownload ? 0 : null;
      // 结构化推送：界面顶部的更新提示靠这个，不靠解析下面的日志文本
      emit("update:available", { version: info.version, current: app.getVersion() });
      logger.log(wantDownload
        ? `发现新版本 v${info.version}，开始下载（约 85MB）…`
        : `发现新版本 v${info.version}（当前 v${app.getVersion()}），点界面顶部的提示即可下载安装。`);
    });
    autoUpdater.on("update-not-available", (info) => {
      updateAvailable = "";
      logger.log(`已是最新版本（v${info.version}），无需更新。`);
    });
    autoUpdater.on("download-progress", (p) => {
      downloadPercent = p.percent;
      if (p.percent - lastProgressLog >= 20 || p.percent >= 100) {
        lastProgressLog = p.percent;
        logger.log(`新版本下载中：${Math.round(p.percent)}%（${(p.transferred / 1048576).toFixed(0)}/${(p.total / 1048576).toFixed(0)} MB）`);
      }
      // 结构化进度推给界面：以前只有"每 20% 一行日志"，而下载 85MB 要好几分钟 ——
      // 用户点完检查更新之后界面上什么都不动，看起来就是"点了没用"。
      // 节流到 ~500ms 一次：下载事件很密，每来一个就发一次 IPC 是浪费。
      const now = Date.now();
      if (now - lastProgressEmit >= 500 || p.percent >= 100) {
        lastProgressEmit = now;
        emit("update:progress", {
          version: updateAvailable,
          percent: p.percent,
          transferred: p.transferred,
          total: p.total,
        });
      }
    });
    autoUpdater.on("update-downloaded", (info) => {
      updateReady = true;
      updateReadyVersion = info.version;
      updateAvailable = "";
      downloading = false;
      downloadPercent = null;
      // 主动推给界面。此前界面是靠匹配下面这行日志文本来启用「重启并安装新版」按钮的，
      // 改一个字按钮就永远不亮且不报错——状态必须走结构化事件，不能走日志文本。
      emit("update:ready", { version: info.version });
      logger.log(`✅ 新版本 v${info.version} 下载完成。界面顶部的提示现在会变成「点这里立即重启并安装」；`
        + "也可以直接关掉软件 —— 关闭时它会自动装上，下次打开就是新版。");
    });
    autoUpdater.on("error", (e) => {
      // 失败也要把"下载中"清掉，否则界面会永远停在某个百分比上骗人。
      // ⚠️ 光清主进程这边的状态**不够**：界面用的是自己那份 updateState，只有收到推送才会重画
      //（`update:info` 只在界面刷新时拉一次）。2.0.46 修完进度显示之后，这里就留下了一个新的
      // "界面撒谎"口子：下载到 42% 撞上代理断了 → 主进程 downloading=false，界面仍写着
      // "⬇️ 下载中 42%"，而且永远不动。所以必须显式推一条 `update:error`。
      downloading = false;
      downloadPercent = null;
      const message = describeUpdateError(e);
      if (checkRetryDepth > 0) {
        // 还在重试序列里 —— 由 checkForUpdates 统一播报（它知道是第几次尝试、下一步换什么方式）。
        // 这里再播一遍就是"一次失败报三遍"，见上面 checkRetryDepth 的说明。
        return;
      }
      lastCheckAt = nowTimeText();
      lastCheckOk = false;
      lastCheckWhy = message;
      emit("update:error", { message });
      emit("update:checked", { ok: false, why: message, at: lastCheckAt });
      logger.log(`⚠️ 更新失败：${message}`);
      logger.log("可改用手动更新：拿到最新安装包直接覆盖安装即可（答题数据不受影响）。"
        + "若你已经在下载中途失败过，再点一次「检查更新」会接着重下。");
    });
  } catch (e) {
    logger.log(`更新模块初始化失败（不影响其他功能）：${e.message}`);
  }

  /** 重试序列里两次尝试之间的等待：给瞬时故障（代理刚重连、WiFi 刚起来、线路抖动）一点时间 */
  const UPDATE_RETRY_DELAY_MS = 1500;

  /**
   * 检查更新。
   * download=true 顺带下载（用户主动点「检查更新」）；
   * download=false 只查不下载（启动静默检查用）。
   *
   * 必须按调用设置 autoDownload：它是全局开关，一直开着的话启动静默检查
   * 会在用户毫不知情的情况下把 85MB 下下来。
   *
   * ── 为什么要"失败后换一种方式再试一次"（2026-10-14 17:55 那次）──
   * 用户贴的日志是 `net::ERR_CONNECTION_RESET`（连接被对端重置），而**同一分钟里
   * 连百度知道的请求也在挂**（`⚠️ 搜索失败（跳过）… — fetch failed`）—— 也就是他那会儿
   * 整台机器的网络都不稳。这类错误绝大多数是**瞬时**的，原来"一次就放弃、只留一句手动更新的建议"
   * 等于把用户直接赶到手动安装上去。
   * 现在的策略是**两种方式各试一次**：
   *   ① 按当前网络设置（通常是系统代理）—— 线路抖动能自愈；
   *   ② 临时直连 —— 代理本身坏了的情况。
   * 两种都失败才真报失败，而且日志里会写清"是第几次、用的哪种方式、为什么失败"。
   * 这样下次再看日志，一眼就能区分"是代理的问题"还是"两条路都不通"。
   */
  async function checkForUpdates({ download }) {
    if (!app.isPackaged) throw new Error("开发模式不支持在线检查更新（仅打包版可用）。");
    const { autoUpdater } = require("electron-updater");
    wantDownload = Boolean(download);
    autoUpdater.autoDownload = wantDownload;
    lastProgressLog = 0;
    lastProgressEmit = 0;

    const plan = [
      { label: "按当前网络设置", mode: null },
      { label: "临时直连", mode: "direct" },
    ];
    let lastError = null;
    checkRetryDepth += 1;
    try {
      for (let i = 0; i < plan.length; i += 1) {
        const step = plan[i];
        const isLast = i === plan.length - 1;
        if (i > 0) {
          logger.log(`等待 ${UPDATE_RETRY_DELAY_MS / 1000} 秒后换「${step.label}」再试一次…`);
          await sleep(UPDATE_RETRY_DELAY_MS);
        }
        try {
          await withProxyMode(step.mode, () => autoUpdater.checkForUpdates());
          lastCheckAt = nowTimeText();
          lastCheckOk = true;
          lastCheckWhy = "";
          if (i > 0) logger.log(`✅ 换用「${step.label}」后检查成功了。`);
          emit("update:checked", { ok: true, why: "", at: lastCheckAt });
          return { currentVersion: app.getVersion() };
        } catch (error) {
          lastError = error;
          const why = describeUpdateError(error);
          logger.log(isLast
            ? `检查更新失败（${step.label}）：${why}。已试过两种方式，不再自动重试。`
            : `检查更新失败（${step.label}）：${why}。`);
          if (isLast) {
            // 原始串（如 net::ERR_CONNECTION_RESET）只在这里出现**一次**：
            // `describeUpdateError` 翻成人话后就不带它了，而排查时恰恰靠它区分故障类型。
            const brief = scrubUrl(String((error && error.message) || error)).slice(0, 120);
            if (brief) logger.log(`  原因摘要：${brief}`);
            lastCheckAt = nowTimeText();
            lastCheckOk = false;
            lastCheckWhy = why;
            emit("update:checked", { ok: false, why, at: lastCheckAt });
          }
        }
      }
    } finally {
      checkRetryDepth -= 1;
    }
    // 到这里说明两次都没成。抛出去让上层（手动检查 → 界面；启动检查 → 稍后再试）各自处理。
    // ⚠️ 上面循环里最后一次的失败**没有**走 `autoUpdater.on("error")` 的播报（那段在
    //   checkRetryDepth>0 时故意静音），所以"⚠️ 更新失败"这一条由这里负责补齐，不能两头都不说。
    if (lastError) {
      const why = describeUpdateError(lastError);
      emit("update:error", { message: why });
      logger.log(`⚠️ 更新失败：${why}`);
    }
    throw lastError || new Error("检查更新失败");
  }

  /**
   * 临时把默认会话换成别的代理模式，跑一段异步操作，然后**必须还原**。
   *
   * ⚠️ 还原这一步是硬要求：`setProxy` 改的是**整个默认会话**，不还原的话之后
   * 爬题/提交/网盘全变成直连 —— 用户配代理恰恰是为了不走直连（出口 IP 会被关联）。
   * 所以还原放在 finally 里，成功失败都执行。
   *
   * @param {string|null} mode "direct" 才切换；传 null 表示"就用用户当前那套，别动"
   */
  async function withProxyMode(mode, run) {
    if (!mode) return run();
    const { session } = require("electron");
    let switched = false;
    try {
      await session.defaultSession.setProxy({ mode });
      switched = true;
      logger.log(`⚠️ 已临时把网络切成**${mode === "direct" ? "直连" : mode}**试一次（用完会还原成你原来的代理设置）…`);
      return await run();
    } finally {
      if (switched) {
        try {
          await session.defaultSession.setProxy({ mode: "system" });
        } catch { /* 还原失败也要继续：总比把代理永久改成直连强 */ }
      }
    }
  }

  /** 小睡一会儿（重试之间用）。用 setTimeout 而不是忙等，避免卡住主线程。 */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 界面上直接显示原始报错是没有意义的（`net::ERR_PROXY_CONNECTION_FAILED` 这种谁也看不懂），
  // 这里抛一句人话；完整原因由上面的 `autoUpdater.on("error")` 打进运行日志。
  ipcMain.handle("update:check", () => checkForUpdates({ download: true }).catch((e) => {
    throw new Error(`${describeUpdateError(e)}（详细原因见运行日志）`);
  }));
  ipcMain.handle("update:install", () => {
    if (!updateReady) {
      // 这句要说清"还有什么别的办法"：用户点了安装却没反应时，最有用的一句是
      //「你什么都不用做，关掉软件它自己会装上」。
      throw new Error("新版尚未下载完成。请先点「检查更新」并等下载完成；"
        + "若你已经下过一轮，可以直接关闭软件 —— 关闭时它会自动装上，下次打开就是新版。");
    }
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
  ipcMain.handle("update:info", () => ({
    version: app.getVersion(),
    supported: Boolean(app.isPackaged),
    ready: updateReady, // 新版是否已下载好（界面据此启用「重启并安装新版」）
    readyVersion: updateReadyVersion, // 已下载好的版本号（界面要显示，不能只给布尔值）
    available: updateAvailable, // 有新版但还没下载时的版本号（界面据此显示顶部提示）
    downloading, // 是否正在下载（界面据此把顶部提示条显示成进度）
    percent: downloadPercent, // 已下载百分比（null = 还不知道）
    // 「上次检查更新」的结果 —— 界面刷新（或刚启动）后要能复原它。
    // 没有这份信息的话，界面上永远只有一句"当前版本 vX"：**检查失败过也看不出来**，
    // 用户以为"已是最新"，其实我们根本没问到过服务器。
    lastCheck: { at: lastCheckAt, ok: lastCheckOk, why: lastCheckWhy },
    // 以前这里还返回 `releasesUrl`（仓库发布页地址），渲染端靠它开浏览器 —— 已移除，
    // 连按钮一起删（见上面那段说明）：留着字段就是"地址还在包里，只是不显示"。
  }));

  /**
   * 启动时的自动检查更新：只查不下载，有新版就在界面顶部提示，由用户决定要不要下。
   *
   * 延后 20 秒是避开启动时的初始化与自检，别去抢带宽和主线程。
   * 开发模式（app.isPackaged=false）会直接抛错被吞掉，不会发请求。
   *
   * ── 失败为什么还要**自动再试一次**（用户 17:55 那次的教训）──
   * 那次的现场是：软件刚起来，用户同时点着"按题材搜索"，而整台机器的网络在抖
   * （更新检查报 `net::ERR_CONNECTION_RESET`，同一分钟里连百度知道的请求也在 `fetch failed`）。
   * 以前的做法是**这一次失败就彻底不再查了** —— 于是那台机器上"有没有新版本"这个问题，
   * 直到用户自己想起来去点「检查更新」才有答案。而用户根本不知道要去点。
   * 现在：第一次失败 → 10 分钟后再自动试一次（这时启动高峰已经过去、网络也多半好了）；
   * 第二次还失败 → 才交给用户，并说清"可以点哪里手动重试"。
   * 只重试**一次**，不会再往后排 —— 网络真的断了的时候，隔十分钟弹一次是骚扰。
   */
  const STARTUP_CHECK_DELAY_MS = 20000;
  const STARTUP_RETRY_DELAY_MS = 10 * 60 * 1000;

  function scheduleStartupCheck({ first }) {
    const wait = first ? STARTUP_CHECK_DELAY_MS : STARTUP_RETRY_DELAY_MS;
    const timer = setTimeout(() => {
      checkForUpdates({ download: false }).catch((e) => {
        // ⚠️ 这里**不再重复报原因**：`checkForUpdates` 内部已经把每次尝试都写进日志了
        //（包括那句 `原因摘要：net::ERR_CONNECTION_RESET`）。之前这里又抄了一遍
        // `启动检查更新失败：…` + `原因摘要：…`，于是**一次失败在日志里出现两遍**，
        // 用户贴过来时看着像坏了两次。
        const why = describeUpdateError(e);
        // ⚠️ 原因用「：」引出，**不能**用括号包 —— `describeUpdateError` 的输出自己就带括号
        //（`可能是网络问题（更新服务器连不上）`），一套起来就是括号套括号。这个坑本仓库
        //已经踩了三次（提示条、更新页那行、这里），所以加了机械守卫：见 round18 的 E3。
        if (first) {
          logger.log(`本次启动的自动检查没成功：${why} —— 不影响使用，`
            + `${Math.round(STARTUP_RETRY_DELAY_MS / 60000)} 分钟后会自动再试一次。`);
          scheduleStartupCheck({ first: false });
        } else {
          logger.log(`自动检查（含 10 分钟后的重试）都没成功：${why}。`
            + "之后请点「使用教程 → 软件更新 → 检查更新」手动重试，或拿到最新安装包直接覆盖安装（答题数据不受影响）。");
        }
      });
    }, wait);
    timer.unref?.();
  }

  scheduleStartupCheck({ first: true });

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
    // flushAll 现在不抛错、改成返回失败清单（见 store.js 的注释）。
    // 退出路径上没人再能看到界面，只能落到 stderr —— 但至少不是"静默丢掉"。
    const failed = store.flushAll();
    if (failed.length) console.error("[shutdown] 有数据没能落盘：", failed);
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
