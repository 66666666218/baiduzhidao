"use strict";

// ---------- 基础 ----------
const $ = (id) => document.getElementById(id);
const rpc = window.api;

let logLines = [];

/**
 * 渲染层约定：任何一次主进程调用失败都必须在日志里留痕。
 * 之前十几处 await 没有 catch，拒绝被静默吞掉——最典型的是导出答案时目标 xlsx
 * 正被 Excel 占用，界面毫无提示，用户以为已经导出成功。
 * 失败时返回 null，调用方按"取消"处理（现有 handler 都已判 !result / result.canceled）。
 */
async function call(label, channel, payload) {
  try {
    return await rpc.invoke(channel, payload);
  } catch (error) {
    appendLog(`${label}失败：${error.message}`);
    return null;
  }
}

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
  if (!await saveSettingsQuiet()) return;
  $("settingsHint").textContent = "✅ 已保存";
  setTimeout(() => { $("settingsHint").textContent = ""; }, 2500);
});

$("startCrawl").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
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
  const result = await call("选择爬取结果文件夹", "path:pick-folder", { title: "选择爬取结果文件夹" });
  if (result && !result.canceled) $("crawlOutputDir").value = result.filePath;
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

// ---------- 软件更新（GitHub Releases） ----------
function applyUpdateInfo(info) {
  $("updateInfo").textContent = `当前版本 v${info.version}`;
  $("checkUpdate").disabled = !info.supported;
  if (!info.supported) $("updateInfo").textContent += "（开发模式不支持在线更新）";
  // 只有主进程说"已下载好"才允许安装。状态走结构化字段，不匹配日志文本——
  // 此前是靠 includes("下载完成。重启软件即自动安装") 判断的，日志改一个字按钮就静默失效。
  $("installUpdate").disabled = !info.ready;
}

(async () => {
  try {
    applyUpdateInfo(await rpc.invoke("update:info"));
  } catch { /* 通道异常不影响其他功能 */ }
})();

// 下载完成时主进程主动推：立刻点亮按钮，不必等到下一次查询
rpc.on("update:ready", (info) => {
  $("installUpdate").disabled = false;
  $("updateInfo").textContent = `新版 v${(info && info.version) || ""} 已下载完成，点「重启并安装新版」即可`;
});

$("checkUpdate").addEventListener("click", async () => {
  $("checkUpdate").disabled = true;
  $("updateInfo").textContent = "检查更新中…";
  try {
    const r = await rpc.invoke("update:check");
    $("updateInfo").textContent = `当前版本 v${r.currentVersion}`;
  } catch (error) {
    $("updateInfo").textContent = "检查失败，详见运行日志";
    appendLog(`检查更新失败：${error.message}`);
  } finally {
    $("checkUpdate").disabled = false;
  }
});

$("installUpdate").addEventListener("click", async () => {
  try {
    await rpc.invoke("update:install");
  } catch (error) {
    appendLog(`安装失败：${error.message}`);
  }
});

$("openReleases").addEventListener("click", async () => {
  try {
    const info = await rpc.invoke("update:info");
    // link:open 的 handler 接收纯字符串 URL（不是对象）
    await rpc.invoke("link:open", String(info.releasesUrl || ""));
  } catch (error) {
    appendLog(`打开发布页失败：${error.message}`);
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
      strategy: $("samplingStrategy").value,
      outputPath: $("randomOutputPath").value,
      skipGenerated: $("skipGenerated").checked,
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
  const result = await call("选择随机抽题保存路径", "path:pick-save-xlsx", { title: "选择随机抽题保存路径" });
  if (result && !result.canceled) $("randomOutputPath").value = result.filePath;
});

$("pickGenerateExcel").addEventListener("click", async () => {
  const result = await call("选择生成来源表格", "path:pick-open-table", { title: "选择生成答案来源表格" });
  if (result && !result.canceled) $("generateExcelPath").value = result.filePath;
});

$("startGenerate").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
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
    // 未选题时会弹文件选择框，用户取消 → {canceled:true}，此时没有 count/failed 字段
    if (result && !result.canceled) appendLog(`生成结束：新回答 ${result.count} 条，失败 ${result.failed} 条。`);
    refreshUsage();
  } catch (error) {
    appendLog(`生成失败：${error.message}`);
  }
});

$("pickSubmitExcel").addEventListener("click", async () => {
  const result = await call("选择提交来源表格", "path:pick-open-table", { title: "选择提交来源表格" });
  if (result && !result.canceled) $("submitExcelPath").value = result.filePath;
});

$("startSubmit").addEventListener("click", async () => {
  if (!confirm("自动提交会真实发布回答，存在风控/封号风险，确认继续？")) return;
  if (!await saveSettingsQuiet()) return;
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
      dailyAnswerLimit: Number(settings.dailyAnswerLimit) || 0,   // 本次总回答上限（设置项，0=不限）
      forceResubmit: $("forceResubmit").checked,
      checkCompletedEnvs: $("checkCompletedEnvs").checked,
      accountTopics: settings.accountTopics,   // 带链接答案的账号↔题材严格路由依据
      linkRouting: settings.linkRouting,
      maxQuestionsPerEnv: settings.maxQuestionsPerEnv,
    });
    appendLog(`提交结束：成功 ${result.count} 条，失败 ${result.failed} 条。`);
  } catch (error) {
    appendLog(`提交失败：${error.message}`);
  }
});

$("pickBatchExcel").addEventListener("click", async () => {
  const result = await call("选择资源表格", "path:pick-open-table", { title: "选择资源表格" });
  if (result && !result.canceled) $("batchExcelPath").value = result.filePath;
});

// ---------- 从答主主页找资源 → 自动衔接批量转存 ----------
$("startCrawlHome").addEventListener("click", async () => {
  const homepages = $("chHomepages").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!homepages.length) { appendLog("请先粘贴至少一个答主主页地址（问题页点对方头像可得 usercenter 链接）。"); return; }
  // 兜底上限留空 = 用默认 50；显式填 0 才是"不兜底"（防止清空输入框被 Number("") 变成 0 误关兜底）
  const enrichRaw = $("chEnrich").value.trim();
  const enrichLimit = enrichRaw === "" ? 50 : Number(enrichRaw);
  const limitRaw = $("chLimit").value.trim();
  const limit = limitRaw === "" ? 0 : Number(limitRaw) || 0;
  appendLog(`主页找资源启动：${homepages.length} 个主页，资源上限 ${limit || "不限"}，问题页兜底 ${enrichLimit} 次。`);
  try {
    const result = await rpc.invoke("task:crawl-home", {
      homepages,
      limit,
      enrichLimit,
    });
    if (result.stopped) { appendLog("主页找资源已停止。"); return; }
    appendLog(`✅ 主页找资源完成：产出 ${result.count} 条资源（摘要直提 ${result.stats.direct}、问题页兜底 ${result.stats.enriched}、问题页失败跳过 ${result.stats.failed}）。`);
    if (!result.count) { appendLog("未产出资源，跳过转存衔接。"); return; }
    $("batchExcelPath").value = result.outputPath;   // 自动衔接「批量转存」
    appendLog(`资源表格已自动填入「资源表格」：${result.outputPath}`);
    appendLog("确认下方比特环境名后点「开始批量转存」即可转存为自己的资源。");
  } catch (error) {
    appendLog(`主页找资源失败：${error.message}`);
  }
});

$("startBatchTransfer").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
  const filePath = $("batchExcelPath").value;
  if (!filePath) { appendLog("请先选择资源表格。"); return; }
  const bitEnvs = $("batchBitEnvs").value.split(/\r?\n|[,，]/).map((x) => x.trim()).filter(Boolean);
  if (!bitEnvs.length) { appendLog("请填写至少一个比特环境名（多账号每行一个）。"); return; }
  try {
    appendLog(`批量转存启动：环境 ${bitEnvs.join("、")}，目标目录 ${$("batchDestDir").value || "/来自资源批量转存"}`);
    const result = await rpc.invoke("task:batch-transfer", {
      filePath,
      bitEnvs,
      perEnv: Number($("batchPerEnv").value) || 50,
      destDir: $("batchDestDir").value.trim() || "/来自资源批量转存",
      limit: Number($("batchLimit").value) || 0,
      outName: $("batchOutName").value.trim(),
    });
    appendLog(`批量转存结束：本轮成功 ${result.count} 条，失败 ${result.failed} 条，历史累计 ${result.totalOk} 条。`);
    if (result.outputPath) {
      $("uploadExcelPath").value = result.outputPath;   // 自动衔接「批量上传」
      appendLog(`✅ 上传专用表已生成并自动填入「批量上传」视图：${result.outputPath}`);
      appendLog("可直接切到「📤 批量上传」点开始；也可点「打开表格修改」先用 Excel 编辑后再传。");
    }
  } catch (error) {
    appendLog(`批量转存失败：${error.message}`);
  }
});

$("pickUploadExcel").addEventListener("click", async () => {
  const result = await call("选择上传专用表", "path:pick-open-table", { title: "选择上传专用表" });
  if (result && !result.canceled) $("uploadExcelPath").value = result.filePath;
});

$("editUploadExcel").addEventListener("click", async () => {
  const filePath = $("uploadExcelPath").value;
  if (!filePath) { appendLog("请先选择/生成上传专用表。"); return; }
  const r = await rpc.invoke("file:open", { filePath });
  if (!r.ok) appendLog(`打开表格失败：${r.error}`);
});

$("revealUploadExcel").addEventListener("click", async () => {
  const filePath = $("uploadExcelPath").value;
  if (!filePath) { appendLog("请先选择/生成上传专用表。"); return; }
  await rpc.invoke("file:reveal", { filePath });
});

$("startBatchUpload").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
  const filePath = $("uploadExcelPath").value;
  if (!filePath) { appendLog("请先选择上传专用表。"); return; }
  const bitEnv = $("uploadBitEnv").value.trim();
  if (!bitEnv) { appendLog("请填写用于上传的比特环境名。"); return; }
  const settings = await rpc.invoke("settings:get");
  try {
    const result = await rpc.invoke("task:batch-upload", {
      filePath,
      bitEnv,
      batchRows: Number($("uploadBatchRows").value) || 500,
      maxBatches: Number($("uploadMaxBatches").value) || 999,
      // 这条通道与「按题材上传」共用 upload-batch.js，契约测试要求两边都传齐字段；
      // 单账号路径用不到它们，传了也无副作用。
      bitEnvs: settings.bitEnvs,
      accountTopics: settings.accountTopics,
      topicRules: settings.topicRules,
    });
    appendLog(`批量上传结束：本次上传 ${result.uploaded} 行，共 ${result.batches} 批。`);
  } catch (error) {
    appendLog(`批量上传失败：${error.message}`);
  }
});

// 按题材分账号上传：分类规则派生题材 → 各账号只传自己题材的份
$("startTopicUpload").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
  const filePath = $("uploadExcelPath").value;
  if (!filePath) { appendLog("请先选择上传专用表。"); return; }
  const settings = await rpc.invoke("settings:get");
  const bitEnvs = settings.bitEnvs || [];
  if (!bitEnvs.length) { appendLog("请先在设置页填写比特环境账号。"); return; }
  if (!Object.keys(settings.accountTopics || {}).length) {
    appendLog("还没有账号绑定题材：请到设置页「账号题材绑定」按「账号=题材」填好（题材名要与分类规则里的分类名一致）。");
    return;
  }
  try {
    const result = await rpc.invoke("task:upload-by-topic", {
      filePath,
      bitEnvs,
      accountTopics: settings.accountTopics,
      topicRules: settings.topicRules,
      batchRows: Number($("uploadBatchRows").value) || 500,
      maxBatches: Number($("uploadMaxBatches").value) || 999,
    });
    appendLog(`按题材上传结束：共上传 ${result.uploaded} 行。`);
    for (const account of result.accounts || []) {
      appendLog(`　${account.envLabel}（${account.topic || "未绑定"}）：${account.error ? `失败 ${account.error}` : `上传 ${account.uploaded} 行`}`);
    }
    if ((result.topicTables || []).length) {
      appendLog(`题材分表已保存到：${result.splitDir}`);
      for (const table of result.topicTables) appendLog(`　${table.topic} → ${table.file}`);
    }
  } catch (error) {
    appendLog(`按题材上传失败：${error.message}`);
  }
});

// ---------- 一键全自动 ----------

$("pickAutoUploadTable").addEventListener("click", async () => {
  const result = await call("选择上传专用表", "path:pick-open-table", { title: "选择上传专用表" });
  if (result && !result.canceled) $("autoUploadTable").value = result.filePath;
});

$("pickAutoTransferTable").addEventListener("click", async () => {
  const result = await call("选择网盘资源表", "path:pick-open-table", { title: "选择网盘资源表" });
  if (result && !result.canceled) $("autoTransferTable").value = result.filePath;
});

/** 阶段结果用 textContent 拼，不走 innerHTML：错误信息里可能带用户数据（路径、题目标题） */
function renderAutoReport(result) {
  const box = $("autoReport");
  box.textContent = "";
  const lines = (result.stages || []).map((stage) => {
    const mark = stage.ok ? "✅" : stage.skipped ? "⏭️" : "❌";
    return `${mark} ${stage.label}${stage.ok ? "" : "：" + (stage.error || "")}`;
  });
  if (!lines.length) return;
  const paragraph = document.createElement("p");
  paragraph.className = "hint";
  paragraph.textContent = `阶段结果：${lines.join("　|　")}`;
  box.appendChild(paragraph);
}

$("startAutoPipeline").addEventListener("click", async () => {
  const stages = [];
  if ($("autoStageCrawl").checked) stages.push("crawl");
  if ($("autoStagePick").checked) stages.push("pick");
  if ($("autoStageGenerate").checked) stages.push("generate");
  if ($("autoStageSubmit").checked) stages.push("submit");
  if ($("autoStageTransfer").checked) stages.push("transfer");
  if ($("autoStageUpload").checked) stages.push("upload");
  if (!stages.length) { appendLog("请至少勾选一个阶段。"); return; }
  if (!await saveSettingsQuiet()) return;

  const settings = await rpc.invoke("settings:get");
  if (!(settings.bitEnvs || []).length) { appendLog("请先在设置页填写比特环境账号。"); return; }
  if ($("autoStageGenerate").checked && !settings.aiApiKey) {
    appendLog("「生成答案」需要 AI Key，请先在「生成答案」页填写。");
    return;
  }
  if ($("autoStageTransfer").checked && !$("autoTransferTable").value) {
    appendLog("勾了「网盘转存」但没有选网盘资源表。");
    return;
  }
  const destructive = $("autoStageSubmit").checked || $("autoStageTransfer").checked || $("autoStageUpload").checked;
  if (destructive && !confirm("本次会真实提交答案/转存网盘/上传资源到平台，且全程无人值守。确认继续？")) return;

  $("autoReport").innerHTML = "";
  try {
    const result = await rpc.invoke("task:auto-pipeline", {
      stages,
      pickCount: Number($("autoPickCount").value) || 20,
      batchRows: Number($("autoBatchRows").value) || 500,
      uploadTablePath: $("autoUploadTable").value,
      transferTablePath: $("autoTransferTable").value,
      transferDestDir: $("autoTransferDest").value,
    });
    renderAutoReport(result);
    appendLog(`一键全自动结束：${result.ok ? "全部阶段成功" : result.stopped ? "已手动停止" : "有阶段失败（详见上方结果与运行日志）"}。`);
  } catch (error) {
    appendLog(`一键全自动失败：${error.message}`);
  }
});

$("fetchPassed").addEventListener("click", async () => {
  try {
    if (!await saveSettingsQuiet()) return;
    const settings = await rpc.invoke("settings:get");
    const result = await rpc.invoke("task:passed-count", { bitEnvs: settings.bitEnvs });
    for (const account of result.accounts) {
      appendLog(`账号 ${account.bitEnv}：${account.status === "completed" ? "已全部解锁" : account.status === "error" ? `读取失败 ${account.error}` : account.status === "unknown" ? "状态未知（未读到进度页）" : `${account.done}/${account.total}`}`);
    }
  } catch (error) {
    appendLog(`读取失败：${error.message}`);
  }
});

$("refreshResults").addEventListener("click", refreshResults);

$("exportResults").addEventListener("click", async () => {
  const result = await call("导出答案记录", "answers:export", { keyword: $("resultsSearch").value });
  if (result && !result.canceled) appendLog(`已导出 ${result.count} 条答案${result.keyword ? `（搜索：${result.keyword}）` : ""} → ${result.filePath}`);
});

$("clearUsed").addEventListener("click", async () => {
  if (!confirm("确认清空所有“已提交”的答案记录？")) return;
  const result = await call("清空已提交记录", "answers:clear", { onlyUsed: true });
  if (!result) return;
  appendLog(`已清空 ${result.cleared} 条已提交记录。`);
  refreshResults();
});

$("clearAll").addEventListener("click", async () => {
  if (!confirm("确认清空全部答案记录？此操作不可恢复。")) return;
  if (!await call("清空答案记录", "answers:clear", {})) return;
  refreshResults();
});

$("maskAccounts").addEventListener("change", refreshResults);

$("copyLog").addEventListener("click", async () => {
  if (!await call("复制日志", "clipboard:write", logLines.join("\n"))) return;
  $("copyLog").textContent = "已复制";
  setTimeout(() => { $("copyLog").textContent = "复制日志"; }, 1500);
});

$("clearLog").addEventListener("click", () => {
  logLines = [];
  $("logView").textContent = "";
});

$("maskLog").addEventListener("change", async () => {
  await call("切换日志脱敏", "logs:set-mask", $("maskLog").checked);
});

$("stopTask").addEventListener("click", async () => {
  if (!await call("停止任务", "task:stop")) return;
  appendLog("已发送停止请求，等待任务退出...");
});

// ---------- 主进程事件 ----------
rpc.on("task:log", (text) => appendLog(text));
rpc.on("task:progress", (progress) => updateProgress(progress));
// 完成一条就整表重渲染一次太贵（200 条 = 200 次 IPC + DOM 重建），
// 而且会把用户刚点过、正显示"已复制"的按钮节点换掉。合并成最多 300ms 一次。
let resultsRefreshTimer = null;
rpc.on("task:item", () => {
  if (resultsRefreshTimer) return;
  resultsRefreshTimer = setTimeout(() => {
    resultsRefreshTimer = null;
    if (document.querySelector(".view.results.active")) refreshResults();
  }, 300);
});

// ---------- 函数 ----------

async function saveSettingsQuiet() {
  const patch = {};
  patch.apiUrl = $("apiUrl").value;
  patch.activityUrl = $("activityUrl").value.trim();
  patch.bitEnvs = $("bitEnvs").value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  patch.accountTopics = $("accountTopics").value; // 文本形式「账号=题材」，由后端归一化
  patch.linkRouting = $("linkRouting").value;
  patch.topicRules = $("topicRules").value; // 上传侧分类规则，由后端解析
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
  return Boolean(await call("保存设置", "settings:save", patch));
}

async function loadSettings() {
  const settings = await call("读取设置", "settings:get");
  if (!settings) return;
  $("apiUrl").value = settings.apiUrl || "";
  $("activityUrl").value = settings.activityUrl || "";
  $("bitEnvs").value = (settings.bitEnvs || []).map((env) => env.label || env).join("\n");
  $("accountTopics").value = Object.entries(settings.accountTopics || {}).map(([account, topic]) => `${account}=${topic}`).join("\n");
  $("linkRouting").value = settings.linkRouting || "strict";
  $("topicRules").value = settings.topicRules || "";
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
  const stats = await call("读取题库统计", "bank:stats");
  if (!stats) return;
  $("pickStats").textContent = stats.total
    ? `题库 ${stats.total} 条 · 可抽 ${stats.remainingCount} / 已抽 ${stats.usedCount}`
    : "题库为空，请先爬题或导入";
}

async function refreshBankStats() {
  const stats = await call("读取题库统计", "bank:stats");
  if (!stats) return;
  const counts = stats.counts || {};
  const detail = Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(" · ");
  const pickInfo = stats.total ? ` · 可抽 ${stats.remainingCount} / 已抽 ${stats.usedCount}` : "";
  $("bankStats").textContent = `内置题库：${stats.total} 条${detail ? `（${detail}）` : ""}${pickInfo}`;
}

async function refreshUsage() {
  const usage = await call("读取 AI 用量", "ai:usage");
  if (!usage) return;
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

const ACTION_BUTTON_IDS = ["startCrawl", "randomPick", "startGenerate", "startSubmit", "startBatchTransfer", "startBatchUpload", "fetchPassed", "runSelfTest"];

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
  return { running: "进行中", paused: "已暂停", done: "完成", stopped: "已停止", failed: "失败" }[status] || status || "";
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
  const result = await call("读取题库", "bank:list", {
    keyword: $("bankSearch").value,
    category: $("bankCategory").value,
    page: bankPage,
    pageSize: BANK_PAGE_SIZE,
  });
  if (!result || !result.rows) return;
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
        await call("打开题目链接", "link:open", item.questionUrl);
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
  const result = await call("读取答案记录", "answers:list", {
    keyword: $("resultsSearch").value,
    page: resultsPage,
    pageSize: RESULTS_PAGE_SIZE,
  });
  if (!result) return;
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
        if (!await call("复制答案", "clipboard:write", item.answer)) return;
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
      await call("打开链接", "link:open", link.url);
    });
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn soft";
    copyBtn.textContent = "复制链接";
    copyBtn.addEventListener("click", async () => {
      if (!await call("复制链接", "clipboard:write", link.url)) return;
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
