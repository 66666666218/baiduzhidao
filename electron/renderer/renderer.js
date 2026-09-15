"use strict";

// ---------- 基础 ----------
const $ = (id) => document.getElementById(id);
const rpc = window.api;

let logLines = [];

// ---------- 视图切换 ----------
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`.view[data-view="${button.dataset.view}"]`)?.classList.add("active");
    if (button.dataset.view === "results") refreshResults();
    if (button.dataset.view === "crawl") refreshBankStats();
    if (button.dataset.view === "generate") refreshUsage();
    if (button.dataset.view === "bank") renderBank();
    if (button.dataset.view === "random") refreshPickStats();
  });
});

// ---------- 事件绑定 ----------
$("checkBit").addEventListener("click", async () => {
  $("settingsHint").textContent = "正在连接比特浏览器...";
  try {
    await saveSettingsQuiet();
    await rpc.invoke("bit:check");
    $("settingsHint").textContent = "✅ 比特浏览器连接正常";
  } catch (error) {
    $("settingsHint").textContent = `❌ ${error.message}`;
  }
});

$("openDataDir").addEventListener("click", async () => {
  try {
    await rpc.invoke("app:open-data-dir");
  } catch (error) {
    appendLog(`打开数据目录失败：${error.message}`);
  }
});

$("runSelfTest").addEventListener("click", async () => {
  $("runSelfTest").disabled = true;
  $("settingsHint").textContent = "自检运行中，请查看运行日志...";
  appendLog("=== 开始一键自检（不使用真实账号/AI Key）===");
  try {
    const result = await rpc.invoke("app:selftest");
    const failed = result.steps.filter((step) => !step.ok);
    appendLog(`=== 自检${result.ok ? "全部通过 ✅" : `未通过（${failed.length} 项失败）❌`} ===`);
    if (!result.ok) $("settingsHint").textContent = "自检未通过，详情见运行日志";
    else $("settingsHint").textContent = "✅ 自检通过，整条链路可用";
  } catch (error) {
    appendLog(`自检失败：${error.message}`);
    $("settingsHint").textContent = `自检失败：${error.message}`;
  } finally {
    $("runSelfTest").disabled = false;
    setTimeout(() => { $("settingsHint").textContent = ""; }, 4000);
  }
});

$("saveSettings").addEventListener("click", async () => {
  await saveSettingsQuiet();
  $("settingsHint").textContent = "✅ 已保存";
  setTimeout(() => { $("settingsHint").textContent = ""; }, 2500);
});

$("startCrawl").addEventListener("click", async () => {
  await saveSettingsQuiet();
  try {
    const settings = await rpc.invoke("settings:get");
    const result = await rpc.invoke("task:crawl", {
      bitEnvs: settings.bitEnvs,
      category: $("category").value,
      crawlStartPage: Number($("crawlStartPage").value) || 1,
      crawlOutputDir: $("crawlOutputDir").value,
      pageDelayMs: Number($("pageDelayMs").value),
      resume: $("resumeCrawl").checked,
    });
    appendLog(`爬取结束：新增 ${result.count} 条。`);
    refreshBankStats();
  } catch (error) {
    appendLog(`爬取失败：${error.message}`);
  }
});

$("pickCrawlDir").addEventListener("click", async () => {
  const result = await rpc.invoke("path:pick-folder", { title: "选择爬取结果文件夹" });
  if (!result.canceled) $("crawlOutputDir").value = result.filePath;
});

$("importBank").addEventListener("click", async () => {
  try {
    const result = await rpc.invoke("bank:import", {});
    if (result && !result.canceled) {
      appendLog(`题库导入完成：文件 ${result.files} 个，新增 ${result.imported} 条，更新 ${result.updated} 条，总计 ${result.total} 条。`);
      refreshBankStats();
    }
  } catch (error) {
    appendLog(`导入失败：${error.message}`);
  }
});

$("exportBank").addEventListener("click", async () => {
  try {
    const result = await rpc.invoke("bank:export", {});
    if (result && !result.canceled) appendLog(`题库已导出：${result.xlsxPath}（${result.count} 条）`);
  } catch (error) {
    appendLog(`导出失败：${error.message}`);
  }
});

$("refreshStats").addEventListener("click", refreshBankStats);

$("randomPick").addEventListener("click", async () => {
  $("randomPick").disabled = true;
  try {
    const checked = Array.from(document.querySelectorAll(".pick-cat:checked")).map((box) => box.value);
    const result = await rpc.invoke("questions:random-pick", {
      categories: checked.length ? checked : ["三类一起"],
      count: Number($("randomCount").value) || 20,
      outputPath: $("randomOutputPath").value,
    });
    if (result && !result.canceled) {
      appendLog(`已抽题 ${result.count} 条 → ${result.filePath}（题库剩余可用 ${result.remainingAfter} 条${result.resetRound ? "，已重开新一轮" : ""}）`);
      refreshPickStats();
    }
  } catch (error) {
    appendLog(`抽题失败：${error.message}`);
  } finally {
    $("randomPick").disabled = false;
  }
});

$("pickRandomPath").addEventListener("click", async () => {
  const result = await rpc.invoke("path:pick-save-xlsx", { title: "选择随机抽题保存路径" });
  if (!result.canceled) $("randomOutputPath").value = result.filePath;
});

$("pickGenerateExcel").addEventListener("click", async () => {
  const result = await rpc.invoke("path:pick-open-table", { title: "选择生成答案来源表格" });
  if (!result.canceled) $("generateExcelPath").value = result.filePath;
});

$("startGenerate").addEventListener("click", async () => {
  await saveSettingsQuiet();
  try {
    const settings = await rpc.invoke("settings:get");
    const result = await rpc.invoke("task:generate", {
      aiApiKey: settings.aiApiKey,
      aiBaseUrl: settings.aiBaseUrl,
      aiModel: settings.aiModel,
      aiConcurrency: settings.aiConcurrency,
      aiDailyTokenBudget: settings.aiDailyTokenBudget || 0,
      titleTemplate: settings.titleTemplate,
      introTemplate: settings.introTemplate,
      filePath: $("generateExcelPath").value,
      results: [],
    });
    appendLog(`生成结束：新回答 ${result.count} 条，失败 ${result.failed} 条。`);
    refreshUsage();
  } catch (error) {
    appendLog(`生成失败：${error.message}`);
  }
});

$("pickSubmitExcel").addEventListener("click", async () => {
  const result = await rpc.invoke("path:pick-open-table", { title: "选择提交来源表格" });
  if (!result.canceled) $("submitExcelPath").value = result.filePath;
});

$("startSubmit").addEventListener("click", async () => {
  if (!confirm("自动提交会真实发布回答，存在风控/封号风险，确认继续？")) return;
  await saveSettingsQuiet();
  try {
    const settings = await rpc.invoke("settings:get");
    const filePath = $("submitExcelPath").value;
    if (!filePath) {
      appendLog("请先选择包含回答内容的来源表格。");
      return;
    }
    const result = await rpc.invoke("task:submit", {
      bitEnvs: settings.bitEnvs,
      results: [],
      filePath,
      submitLimit: Number($("submitLimit").value) || 0,
      accountDailyLimit: Number($("accountDailyLimit").value) || 0,
      forceResubmit: $("forceResubmit").checked,
      checkCompletedEnvs: $("checkCompletedEnvs").checked,
      maxQuestionsPerEnv: settings.maxQuestionsPerEnv,
    });
    appendLog(`提交结束：成功 ${result.count} 条，失败 ${result.failed} 条。`);
  } catch (error) {
    appendLog(`提交失败：${error.message}`);
  }
});

$("fetchPassed").addEventListener("click", async () => {
  await saveSettingsQuiet();
  try {
    const settings = await rpc.invoke("settings:get");
    const result = await rpc.invoke("task:passed-count", { bitEnvs: settings.bitEnvs });
    for (const account of result.accounts) {
      appendLog(`账号 ${account.bitEnv}：${account.status === "completed" ? "已全部解锁" : account.status === "error" ? `读取失败 ${account.error}` : `${account.done}/${account.total}`}`);
    }
  } catch (error) {
    appendLog(`读取失败：${error.message}`);
  }
});

$("refreshResults").addEventListener("click", refreshResults);

$("exportResults").addEventListener("click", async () => {
  const result = await rpc.invoke("answers:export", { keyword: $("resultsSearch").value });
  if (result && !result.canceled) appendLog(`已导出 ${result.count} 条答案${result.keyword ? `（搜索：${result.keyword}）` : ""} → ${result.filePath}`);
});

$("clearUsed").addEventListener("click", async () => {
  if (!confirm("确认清空所有“已提交”的答案记录？")) return;
  const result = await rpc.invoke("answers:clear", { onlyUsed: true });
  appendLog(`已清空 ${result.cleared} 条已提交记录。`);
  refreshResults();
});

$("clearAll").addEventListener("click", async () => {
  if (!confirm("确认清空全部答案记录？此操作不可恢复。")) return;
  await rpc.invoke("answers:clear", {});
  refreshResults();
});

$("maskAccounts").addEventListener("change", refreshResults);

$("copyLog").addEventListener("click", async () => {
  await rpc.invoke("clipboard:write", logLines.join("\n"));
  $("copyLog").textContent = "已复制";
  setTimeout(() => { $("copyLog").textContent = "复制日志"; }, 1500);
});

$("clearLog").addEventListener("click", () => {
  logLines = [];
  $("logView").textContent = "";
});

$("maskLog").addEventListener("change", async () => {
  await rpc.invoke("logs:set-mask", $("maskLog").checked);
});

$("stopTask").addEventListener("click", async () => {
  await rpc.invoke("task:stop");
  appendLog("已发送停止请求，等待任务退出...");
});

// ---------- 主进程事件 ----------
rpc.on("task:log", (text) => appendLog(text));
rpc.on("task:progress", (progress) => updateProgress(progress));
rpc.on("task:item", (item) => {
  if (document.querySelector(".view.results.active")) refreshResults();
});

// ---------- 函数 ----------

async function saveSettingsQuiet() {
  const patch = {};
  patch.apiUrl = $("apiUrl").value;
  patch.activityUrl = $("activityUrl").value.trim();
  patch.bitEnvs = $("bitEnvs").value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  patch.category = $("category").value;
  patch.timeoutMs = Number($("timeoutMs").value) || undefined;
  patch.verifyWaitSeconds = Number($("verifyWaitSeconds").value) || 0;
  patch.delayMin = Number($("delayMin").value) || 0;
  patch.delayMax = Number($("delayMax").value) || 0;
  patch.maxQuestions = Number($("maxQuestions").value) || undefined;
  patch.maxQuestionsPerEnv = Number($("maxQuestionsPerEnv").value) || undefined;
  patch.closeAfter = $("closeAfter").value === "true";
  patch.crawlStartPage = Number($("crawlStartPage").value) || 1;
  patch.pageDelayMs = Number($("pageDelayMs").value);
  if (!Number.isFinite(patch.pageDelayMs)) patch.pageDelayMs = 800;
  patch.crawlOutputDir = $("crawlOutputDir").value;
  patch.randomCount = Number($("randomCount").value) || undefined;
  patch.randomOutputPath = $("randomOutputPath").value;
  patch.aiBaseUrl = $("aiBaseUrl").value;
  patch.aiApiKey = $("aiApiKey").value;
  patch.aiModel = $("aiModel").value;
  patch.aiConcurrency = Number($("aiConcurrency").value) || 1;
  patch.aiDailyTokenBudget = Number($("aiDailyTokenBudget").value) || 0;
  patch.submitLimit = Number($("submitLimit").value) || 0;
  patch.accountDailyLimit = Number($("accountDailyLimit").value) || 0;
  await rpc.invoke("settings:save", patch);
}

async function loadSettings() {
  const settings = await rpc.invoke("settings:get");
  $("apiUrl").value = settings.apiUrl || "";
  $("activityUrl").value = settings.activityUrl || "";
  $("bitEnvs").value = (settings.bitEnvs || []).map((env) => env.label || env).join("\n");
  $("category").value = settings.category || "情感类";
  $("timeoutMs").value = settings.timeoutMs;
  $("verifyWaitSeconds").value = settings.verifyWaitSeconds;
  $("delayMin").value = settings.delayMin;
  $("delayMax").value = settings.delayMax;
  $("maxQuestions").value = settings.maxQuestions;
  $("maxQuestionsPerEnv").value = settings.maxQuestionsPerEnv;
  $("closeAfter").value = String(settings.closeAfter);
  $("crawlStartPage").value = settings.crawlStartPage || 1;
  $("pageDelayMs").value = settings.pageDelayMs != null ? settings.pageDelayMs : 800;
  $("crawlOutputDir").value = settings.crawlOutputDir || "";
  $("randomCount").value = settings.randomCount || 20;
  $("randomOutputPath").value = settings.randomOutputPath || "";
  $("aiBaseUrl").value = settings.aiBaseUrl || "";
  $("aiApiKey").value = settings.aiApiKey || "";
  $("aiModel").value = settings.aiModel || "";
  $("aiConcurrency").value = settings.aiConcurrency || 2;
  $("aiDailyTokenBudget").value = settings.aiDailyTokenBudget || 0;
  $("submitLimit").value = settings.submitLimit || 0;
  $("accountDailyLimit").value = settings.accountDailyLimit || 10;
  // 流水线减摩擦：生成/提交视图默认使用最近一次抽题表格
  const lastPick = settings.lastPickFilePath || "";
  if (!$("generateExcelPath").value && lastPick) $("generateExcelPath").value = lastPick;
  if (!$("submitExcelPath").value && lastPick) $("submitExcelPath").value = lastPick;
}

async function refreshPickStats() {
  const stats = await rpc.invoke("bank:stats");
  $("pickStats").textContent = stats.total
    ? `题库 ${stats.total} 条 · 可抽 ${stats.remainingCount} / 已抽 ${stats.usedCount}`
    : "题库为空，请先爬题或导入";
}

async function refreshBankStats() {
  const stats = await rpc.invoke("bank:stats");
  const counts = stats.counts || {};
  const detail = Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(" · ");
  const pickInfo = stats.total ? ` · 可抽 ${stats.remainingCount} / 已抽 ${stats.usedCount}` : "";
  $("bankStats").textContent = `内置题库：${stats.total} 条${detail ? `（${detail}）` : ""}${pickInfo}`;
}

async function refreshUsage() {
  const usage = await rpc.invoke("ai:usage");
  $("usageHint").textContent = usage.calls
    ? `累计调用 ${usage.calls} 次，输入 ${usage.promptTokens} tokens，输出 ${usage.completionTokens} tokens`
    : "";
}

function appendLog(text) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = `[${time}] ${text}`;
  logLines.push(line);
  if (logLines.length > 2000) logLines.splice(0, 500);
  const view = $("logView");
  // 节点追加代替整段 textContent 重渲染（长任务日志量大时避免 O(n²) 卡顿）
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
  const div = document.createElement("div");
  div.textContent = line;
  view.appendChild(div);
  while (view.childElementCount > 2000) {
    view.removeChild(view.firstChild);
  }
  if (atBottom) view.scrollTop = view.scrollHeight;
}

const ACTION_BUTTON_IDS = ["startCrawl", "randomPick", "startGenerate", "startSubmit", "fetchPassed", "runSelfTest"];

function setActionsEnabled(enabled) {
  for (const id of ACTION_BUTTON_IDS) {
    const button = $(id);
    if (button) button.disabled = !enabled;
  }
}

let taskPaused = false;

$("pauseTask").addEventListener("click", async () => {
  const result = await rpc.invoke("task:pause").catch(() => null);
  if (result && result.accepted) {
    taskPaused = true;
    $("pauseTask").hidden = true;
    $("resumeTask").hidden = false;
    appendLog("已请求暂停，任务将在下一个检查点挂起...");
  }
});

$("resumeTask").addEventListener("click", async () => {
  await rpc.invoke("task:resume").catch(() => {});
  taskPaused = false;
  $("resumeTask").hidden = true;
  $("pauseTask").hidden = false;
  appendLog("已恢复任务。");
});

function updateProgress(progress) {
  const wrap = $("progressWrap");
  if (!progress) {
    wrap.hidden = true;
    $("stopTask").disabled = true;
    return;
  }
  wrap.hidden = false;
  $("progressText").textContent = `${progress.done} / ${progress.total || "?"}（${statusText(progress.status)}）`;
  $("progressFill").style.width = progress.total ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` : "0%";
  const finished = progress.status === "done" || progress.status === "stopped" || progress.status === "failed";
  $("stopTask").disabled = finished;
  setActionsEnabled(finished);
  // 暂停/恢复按钮跟随运行状态与暂停标志
  $("pauseTask").disabled = finished;
  $("resumeTask").disabled = finished;
  if (finished) {
    $("pauseTask").hidden = false;
    $("resumeTask").hidden = true;
    taskPaused = false;
  } else if (!taskPaused) {
    $("pauseTask").hidden = false;
    $("resumeTask").hidden = true;
  }
}

function statusText(status) {
  return { running: "进行中", done: "完成", stopped: "已停止", failed: "失败" }[status] || status || "";
}

function maskEnv(label) {
  const text = String(label || "").trim();
  if (!text) return "";
  if (text.length <= 2) return `${text[0]}*`;
  if (text.length <= 6) return `${text.slice(0, 1)}*${text.slice(-1)}`;
  return `${text.slice(0, 2)}**${text.slice(-2)}`;
}

// ---------- 题库浏览 ----------
let bankPage = 1;
let bankTotal = 0;
const BANK_PAGE_SIZE = 50;

async function renderBank() {
  const result = await rpc.invoke("bank:list", {
    keyword: $("bankSearch").value,
    category: $("bankCategory").value,
    page: bankPage,
    pageSize: BANK_PAGE_SIZE,
  });
  bankTotal = result.total;
  const tbody = $("bankBody");
  tbody.innerHTML = "";
  if (!result.rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "empty-hint";
    td.textContent = bankTotal === 0 ? "题库为空：先到「题目爬取」采集，或导入题库表格。" : "没有匹配的题目：换个关键字或分类试试。";
    tr.appendChild(td);
    tbody.appendChild(tr);
    $("bankPageInfo").textContent = "共 0 条";
    return;
  }
  for (const item of result.rows) {
    const tr = document.createElement("tr");
    const titleCell = document.createElement("td");
    titleCell.className = "title-cell";
    titleCell.textContent = item.title;
    titleCell.title = item.title;
    const catCell = document.createElement("td");
    catCell.textContent = item.category || "";
    const statusCell = document.createElement("td");
    statusCell.textContent = (item.status || "") + (item.confirmed ? " ✓已确认" : "");
    const linkCell = document.createElement("td");
    if (item.questionUrl) {
      const anchor = document.createElement("a");
      anchor.textContent = "打开";
      anchor.href = "#";
      anchor.addEventListener("click", async (event) => {
        event.preventDefault();
        await rpc.invoke("link:open", item.questionUrl);
      });
      linkCell.appendChild(anchor);
    }
    tr.append(titleCell, catCell, statusCell, linkCell);
    tbody.appendChild(tr);
  }
  const maxPage = Math.max(1, Math.ceil(bankTotal / BANK_PAGE_SIZE));
  bankPage = Math.min(bankPage, maxPage);
  $("bankPageInfo").textContent = `共 ${bankTotal} 条 · 第 ${bankPage}/${maxPage} 页`;
}

$("bankSearchBtn").addEventListener("click", () => { bankPage = 1; renderBank(); });
$("bankSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { bankPage = 1; renderBank(); }
});
$("bankCategory").addEventListener("change", () => { bankPage = 1; renderBank(); });
$("bankPrev").addEventListener("click", () => { if (bankPage > 1) { bankPage -= 1; renderBank(); } });
$("bankNext").addEventListener("click", () => {
  if (bankPage < Math.max(1, Math.ceil(bankTotal / BANK_PAGE_SIZE))) { bankPage += 1; renderBank(); }
});

// ---------- 复制答案：搜索 + 分页 ----------
let resultsPage = 1;
let resultsTotal = 0;
const RESULTS_PAGE_SIZE = 50;

async function refreshResults() {
  const result = await rpc.invoke("answers:list", {
    keyword: $("resultsSearch").value,
    page: resultsPage,
    pageSize: RESULTS_PAGE_SIZE,
  });
  const results = result.rows || [];
  resultsTotal = result.total || results.length;
  const mask = $("maskAccounts").checked;
  const tbody = $("resultsBody");
  tbody.innerHTML = "";
  if (!results.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "empty-hint";
    td.textContent = resultsTotal === 0 ? "还没有答案记录：先完成「生成答案」。" : "没有匹配的记录：换个关键字试试。";
    tr.appendChild(td);
    tbody.appendChild(tr);
    $("resultsPageInfo").textContent = "共 0 条";
    return;
  }
  for (const item of results) {
    const tr = document.createElement("tr");
    const titleCell = document.createElement("td");
    titleCell.className = "title-cell";
    titleCell.textContent = item.title || item.questionUrl;
    titleCell.title = item.title || item.questionUrl;
    const envCell = document.createElement("td");
    envCell.textContent = mask ? maskEnv(item.bitEnv) : item.bitEnv;
    const statusCell = document.createElement("td");
    statusCell.textContent = item.status || "";
    const actionCell = document.createElement("td");
    if (item.answer) {
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn soft";
      copyBtn.textContent = "复制答案";
      copyBtn.addEventListener("click", async () => {
        await rpc.invoke("clipboard:write", item.answer);
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = "复制答案"; }, 1500);
      });
      actionCell.appendChild(copyBtn);
    }
    tr.append(titleCell, envCell, statusCell, actionCell);
    tbody.appendChild(tr);
  }
  const maxPage = Math.max(1, Math.ceil(resultsTotal / RESULTS_PAGE_SIZE));
  resultsPage = Math.min(resultsPage, maxPage);
  $("resultsPageInfo").textContent = `共 ${resultsTotal} 条 · 第 ${resultsPage}/${maxPage} 页`;
}

$("resultsSearchBtn").addEventListener("click", () => { resultsPage = 1; refreshResults(); });
$("resultsSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { resultsPage = 1; refreshResults(); }
});
$("resultsPrev").addEventListener("click", () => { if (resultsPage > 1) { resultsPage -= 1; refreshResults(); } });
$("resultsNext").addEventListener("click", () => {
  if (resultsPage < Math.max(1, Math.ceil(resultsTotal / RESULTS_PAGE_SIZE))) { resultsPage += 1; refreshResults(); }
});

// ---------- 常用网址 ----------
const LINKS = [
  { name: "百度知道 21 周年活动", url: "https://zhidao.baidu.com/hd/21th_activity/" },
  { name: "硅基流动控制台", url: "https://cloud.siliconflow.cn/" },
  { name: "比特浏览器官网", url: "https://www.bitbrowser.cn/" },
];

function renderLinks() {
  const list = $("linkList");
  for (const link of LINKS) {
    const row = document.createElement("div");
    row.className = "link-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = link.name;
    const anchor = document.createElement("a");
    anchor.textContent = link.url;
    anchor.href = "#";
    anchor.addEventListener("click", async (event) => {
      event.preventDefault();
      await rpc.invoke("link:open", link.url);
    });
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn soft";
    copyBtn.textContent = "复制链接";
    copyBtn.addEventListener("click", async () => {
      await rpc.invoke("clipboard:write", link.url);
      copyBtn.textContent = "已复制";
      setTimeout(() => { copyBtn.textContent = "复制链接"; }, 1500);
    });
    row.append(name, anchor, copyBtn);
    list.appendChild(row);
  }
}

// ---------- 初始化 ----------
(async function init() {
  try {
    await loadSettings();
    renderLinks();
    refreshBankStats();
    const recent = await rpc.invoke("logs:recent");
    if (recent.length) {
      const view = $("logView");
      const fragment = document.createDocumentFragment();
      for (const line of recent) {
        const div = document.createElement("div");
        div.textContent = line;
        fragment.appendChild(div);
      }
      view.appendChild(fragment);
      view.scrollTop = view.scrollHeight;
    }
    $("stopTask").disabled = true;
  } catch (error) {
    appendLog(`初始化失败：${error.message}`);
  }
})();
