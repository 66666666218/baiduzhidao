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
      // 「任务总量上限」：以前既没从这里传、crawl.js 也没读，两头都断，这个设置一直是死的
      maxQuestions: Number(settings.maxQuestions) || 0,
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

// ---------- 账号总览 ----------
// 复用「查收录」那个任务：它已经按账号返回了 账号名/剩余额度/上传条数/收录/被拒，
// 没必要再写一个任务去拿同样的数据。
function renderAccountOverview(accounts, topicMap = {}) {
  const tbody = $("accountOverviewBody");
  tbody.innerHTML = "";
  if (!accounts.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.className = "empty-hint";
    td.textContent = "没有可显示的账号：请先在设置页填写「比特环境名称」。";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const account of accounts) {
    const tr = document.createElement("tr");
    // 绑定题材：设置页里「账号题材绑定」是按**比特环境名**做 key 的，差一个字就匹配不上，
    // 而那种错只有跑到任务深处才报错。这里直接摊开，一眼能看出谁没绑。
    const topic = topicMap[account.envLabel];
    const topicText = topic ? topic : "⚠️ 未绑定";
    // 「批量发布权益」= 工作台 userinfo 的 hasPermission。没有它上传会被拒，
    // 一键全自动的网盘链会自动跳过这些账号。null 表示没查到（按不拦处理）。
    const permText = account.hasPermission === true ? "✅ 有"
      : account.hasPermission === false ? "❌ 无（网盘链会跳过）" : "? 未查到";
    const cells = account.ok
      ? [
          account.envLabel,
          topicText,
          account.name || "(未取到)",
          permText,
          account.remainingQuota == null ? "未知" : String(account.remainingQuota),
          String(account.taskTotal || 0),
          String(account.summary.totalRows),
          String(account.summary.successRows),
          String(account.summary.failedRows),
          account.summary.hasFailure ? "⚠️ 有被拒" : "✅ 正常",
        ]
      : [account.envLabel, topicText, "-", "-", "-", "-", "-", "-", "-", `❌ ${account.error}`];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text; // textContent 而不是 innerHTML：错误信息里可能带用户数据
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// 「每账号每日限额」在「自动提交」页与「一键全自动」页各有一个输入框。
// saveSettingsQuiet 只从「自动提交」页那个读（单一真源），这里把值同步过去，
// 否则用户在一键全自动页改完，一保存会被另一个框的旧值覆盖回去。
$("autoAccountDailyLimit").addEventListener("input", () => {
  $("accountDailyLimit").value = $("autoAccountDailyLimit").value;
});

// 本地账号档案：把「连续失败被标记需人工检查」这件事变得看得见、解得开。
// 这一栏不联网、不需要登录，随时可以刷。
function renderLocalAccounts(list) {
  const tbody = $("localAccountsBody");
  tbody.textContent = "";
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6">还没有账号记录。跑过一次提交任务、或在设置页保存过账号列表，这里就会出现。</td></tr>';
    return;
  }
  for (const account of list) {
    const tr = document.createElement("tr");
    const cells = [
      account.name,
      account.blocked ? "🚫 需人工检查" : "✅ 可用",
      account.blocked ? (account.blockedReason || "未注明") : "",
      account.dailyLimit > 0 ? `${account.usedToday}/${account.dailyLimit}` : `${account.usedToday}（不限）`,
      account.lastUsedAt || "",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    const actionCell = document.createElement("td");
    if (account.blocked) {
      const button = document.createElement("button");
      button.className = "btn soft";
      button.textContent = "解除标记";
      button.addEventListener("click", async () => {
        try {
          const r = await rpc.invoke("accounts:unblock", { name: account.name });
          renderLocalAccounts(r.accounts || []);
          $("localAccountsHint").textContent = `已解除「${account.name}」的标记`;
        } catch (error) { $("localAccountsHint").textContent = `解除失败：${error.message}`; }
      });
      actionCell.appendChild(button);
    }
    tr.appendChild(actionCell);
    tbody.appendChild(tr);
  }
}

$("refreshLocalAccounts").addEventListener("click", async () => {
  $("localAccountsHint").textContent = "读取中…";
  try {
    const r = await rpc.invoke("accounts:overview");
    const list = (r && r.accounts) || [];
    renderLocalAccounts(list);
    const blocked = list.filter((a) => a.blocked).length;
    $("localAccountsHint").textContent = blocked
      ? `共 ${list.length} 个账号，其中 ${blocked} 个被标为需人工检查（后续任务会跳过它们）`
      : `共 ${list.length} 个账号，都可用`;
  } catch (error) { $("localAccountsHint").textContent = `读取失败：${error.message}`; }
});

$("refreshAccountOverview").addEventListener("click", async () => {
  $("accountOverviewHint").textContent = "查询中…";
  try {
    const settings = await rpc.invoke("settings:get");
    const bitEnvs = settings.bitEnvs || [];
    if (!bitEnvs.length) { $("accountOverviewHint").textContent = "请先在设置页填写比特环境账号"; return; }
    const topicMap = settings.accountTopics || {};
    const unbound = bitEnvs.map((e) => e.label || e).filter((name) => !topicMap[name]);
    // withReasons=false：总览只要汇总，不必为每批被拒去拉结果文件（那会很慢）
    const result = await rpc.invoke("task:check-published", { bitEnvs, withReasons: false });
    renderAccountOverview(result.accounts || [], topicMap);
    const okCount = (result.accounts || []).filter((a) => a.ok).length;
    $("accountOverviewHint").textContent = `已刷新 ${okCount}/${bitEnvs.length} 个账号`
      + (unbound.length ? `　⚠️ ${unbound.length} 个账号没绑定题材（搜资源和按题材上传都用不了）` : "");
    appendLog(`账号总览已刷新：${okCount}/${bitEnvs.length} 个账号可用`);
    if (unbound.length) {
      appendLog(`⚠️ 这些账号在「账号题材绑定」里没有对应条目：${unbound.join("、")}。`
        + `绑定表的冒号左边必须和上面的环境名一字不差，否则搜资源会直接报「没有账号绑定题材」。`);
    }
  } catch (error) {
    $("accountOverviewHint").textContent = `刷新失败：${error.message}`;
    appendLog(`账号总览刷新失败：${error.message}`);
  }
});

// ---------- 软件更新（GitHub Releases） ----------
let currentVersion = "";

/** 顶部提示条：启动静默检查发现新版时出现，点了就走「检查并下载」 */
function showUpdateBanner(version) {
  const banner = $("updateBanner");
  if (!banner || !version) return;
  banner.textContent = `🔔 发现新版本 v${version}（当前 v${currentVersion}）——点这里下载安装`;
  banner.hidden = false;
}

function applyUpdateInfo(info) {
  currentVersion = info.version;
  $("updateInfo").textContent = `当前版本 v${info.version}`;
  $("checkUpdate").disabled = !info.supported;
  if (!info.supported) $("updateInfo").textContent += "（开发模式不支持在线更新）";
  // 只有主进程说"已下载好"才允许安装。状态走结构化字段，不匹配日志文本——
  // 此前是靠 includes("下载完成。重启软件即自动安装") 判断的，日志改一个字按钮就静默失效。
  $("installUpdate").disabled = !info.ready;
  // 启动静默检查可能早于界面就绪，那条推送收不到——用查询结果兜底
  if (info.available) showUpdateBanner(info.available);
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

// 启动静默检查（只查不下载）发现新版时推过来
rpc.on("update:available", (info) => showUpdateBanner(info && info.version));

$("updateBanner").addEventListener("click", () => {
  $("updateBanner").hidden = true; // 用户已看到，收起；失败信息在运行日志里
  $("checkUpdate").click();
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

// 「打开发布页」入口已整体移除（按钮在 index.html 里也删了）：它打开的正是仓库发布页地址。
// 这里必须同步删掉监听器 —— 只删按钮的话，`$("openReleases")` 取到 null，
// `.addEventListener` 会直接抛 TypeError，整个渲染端初始化就崩了（而且是在用户看得到的地方）。

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
    });
    appendLog(`提交结束：成功 ${result.count} 条，失败 ${result.failed} 条。`);
  } catch (error) {
    appendLog(`提交失败：${error.message}`);
  }
});

// 按题材搜资源：纯协议搜百度知道，产出自动填入「资源表格」，接着就能转存
// **这一段只做采集**：先把资源全部收成一张表（不够会自动加码补足），
// 转存+生成那是「开始批量转存」的事 —— 两个动作分开跑，各自都能单独重来。
$("startSearchResources").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
  const settings = await rpc.invoke("settings:get");
  if (!Object.keys(settings.accountTopics || {}).length) {
    appendLog("还没有账号绑定题材：请到设置页「账号题材绑定」按「账号=题材」填好（题材名要与搜索词里的题材名一致）。");
    return;
  }
  const target = Number($("searchTargetCount").value) || 0;
  try {
    appendLog(target ? `开始采集（目标 ${target} 条，不够会自动加码补足）…` : "开始采集（未设目标条数，采到多少算多少）…");
    const result = await rpc.invoke("task:search-resources", {
      pages: Number(settings.searchPages) || 1,
      targetCount: target,
      searchConcurrency: Number($("searchConcurrency").value) || 2,
    });
    if (result && result.outputPath) {
      $("batchExcelPath").value = result.outputPath; // 自动衔接「资源表格」
      appendLog(`搜资源完成：${result.count} 条${target ? `（目标 ${target} 条${result.targetReached ? "已达成" : "未达成，请增加搜索词或答主主页"}）` : ""}，已自动填入「资源表格」：${result.outputPath}`);
      appendLog("→ 下一步点「开始批量转存」：一次性转存这批资源并生成上传专用表。");
    }
  } catch (error) {
    appendLog(`搜资源失败：${error.message}`);
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
    appendLog(`批量转存启动：环境 ${bitEnvs.join("、")}，并发 ${ Number($("batchCc").value) || 0 ? Number($("batchCc").value) : "自动" }，目标目录 ${$("batchDestDir").value || "/来自资源批量转存"}`);
    const result = await rpc.invoke("task:batch-transfer", {
      filePath,
      bitEnvs,
      perEnv: Number($("batchPerEnv").value) || 50,
      destDir: $("batchDestDir").value.trim() || "/来自资源批量转存",
      limit: Number($("batchLimit").value) || 0,
      // 0=自动：给每个账号配了互不相同的代理、且账号数≥2 时才并行（一线程一账号）
      cc: Number($("batchCc").value) || 0,
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

/**
 * 「批量上传」页账号框是所有上传动作的**唯一入口**。
 *
 * 以前「按题材分账号上传」压根不读这个框，直接用 `settings.bitEnvs`（设置页的全量账号）——
 * 用户在框里只填了「账号2」，点下去账号1、账号2 全被传了一遍，日志里还看不出来。
 * 现在这页的三个按钮（批量上传 / 按题材上传 / 查收录）统一从这里取。
 */
function readUploadEnvs() {
  return uniqueStrings($("uploadBitEnv").value.split(/\r?\n|[,，]/).map((s) => s.trim()).filter(Boolean));
}

function uniqueStrings(list) {
  return Array.from(new Set(Array.isArray(list) ? list : []));
}

/** 设置里的比特环境名（对象是 {label} 形式，界面上要的是裸字符串） */
function settingEnvLabels(settings, key) {
  return uniqueStrings((settings[key] || []).map((env) => (env && env.label) || env).filter(Boolean));
}

/**
 * 取本次参与上传的账号。返回 { envs, source } —— source 用于把"这批账号是怎么来的"
 * 摆到用户面前：**不知道账号列表从哪来，就不可能知道为什么多传了一个号**。
 */
function resolveUploadEnvs(settings) {
  const ui = readUploadEnvs();
  if (ui.length) return { envs: ui, source: "ui" };
  return { envs: settingEnvLabels(settings, "bitEnvs"), source: "settings" };
}

/** 框里写了设置页没有的账号名 —— 多半是笔误，上传时才会报"未登录"，先说一声 */
function warnUnknownEnvs(settings, envs) {
  const known = settingEnvLabels(settings, "bitEnvs");
  if (!known.length) return;
  const unknown = envs.filter((env) => !known.includes(env));
  if (unknown.length) appendLog(`⚠️ 这些账号不在设置页的账号列表里：${unknown.join("、")}（名字要与设置页一字不差，否则会报「未登录」）`);
}

$("startBatchUpload").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
  const filePath = $("uploadExcelPath").value;
  if (!filePath) { appendLog("请先选择上传专用表。"); return; }
  const envs = readUploadEnvs();
  if (!envs.length) { appendLog("请先填写上传账号（每行一个；「开始批量上传」只取第一行）。"); return; }
  const bitEnv = envs[0];
  if (envs.length > 1) {
    appendLog(`本次只用框里的第一个账号「${bitEnv}」上传；要让多个账号各传自己题材，请点「按题材分账号上传」。`);
  }
  const settings = await rpc.invoke("settings:get");
  warnUnknownEnvs(settings, [bitEnv]);
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
// 查收录：上传接口 200 只代表平台收下了，收录结果要单独查
$("checkPublished").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
  const settings = await rpc.invoke("settings:get");
  // 与上传按钮同一入口：查的就是"刚才那批负责上传的号"，不用再到设置页确认一遍
  const { envs: bitEnvs } = resolveUploadEnvs(settings);
  if (!bitEnvs.length) { appendLog("请先在本页「上传账号」框或设置页填写比特环境账号。"); return; }
  try {
    const result = await rpc.invoke("task:check-published", { bitEnvs });
    for (const account of result.accounts || []) {
      if (!account.ok) { appendLog(`　${account.envLabel}：${account.error}`); continue; }
      const s = account.summary;
      appendLog(`　${account.envLabel}（${account.name || "?"}）：最近 ${s.taskCount} 个任务共 ${s.totalRows} 条 → 收录 ${s.successRows}，被拒 ${s.failedRows}，剩余额度 ${account.remainingQuota ?? "未知"}`);
    }
    if (result.outputPath) appendLog(`收录明细已导出：${result.outputPath}`);
    if (result.failedPath) appendLog(`被拒明细已导出（含逐条失败原因）：${result.failedPath}`);
    else if (result.failedRows === 0) appendLog("　本轮没有被拒的条目。");
  } catch (error) {
    appendLog(`查收录失败：${error.message}`);
  }
});

$("startTopicUpload").addEventListener("click", async () => {
  if (!await saveSettingsQuiet()) return;
  const filePath = $("uploadExcelPath").value;
  if (!filePath) { appendLog("请先选择上传专用表。"); return; }
  const settings = await rpc.invoke("settings:get");
  const { envs: bitEnvs, source } = resolveUploadEnvs(settings);
  if (!bitEnvs.length) { appendLog("请先在设置页填写比特环境账号，或在本页「上传账号」框里填（每行一个）。"); return; }
  if (source === "settings") {
    appendLog(`⚠️ 「上传账号」框是空的，本次回落到设置页的全部账号（${bitEnvs.length} 个）：${bitEnvs.join("、")}`
      + " —— 只想让某几个号传，就把框里没用的行删掉。");
  } else {
    appendLog(`本次参与上传的账号（${bitEnvs.length} 个）：${bitEnvs.join("、")}`);
  }
  warnUnknownEnvs(settings, bitEnvs);
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
    // 成功的阶段也带上"做出了多少"（后端给的 summary）—— 只显示「✅ 爬题」的话，
    // 爬了 0 题也是 ✅，用户没法从结果表里看出哪一步其实是空转。
    const detail = stage.ok ? (stage.summary ? `：${stage.summary}` : "") : `：${stage.error || ""}`;
    return `${mark} ${stage.label}${detail}`;
  });
  if (lines.length) {
    const paragraph = document.createElement("p");
    paragraph.className = "hint";
    paragraph.textContent = `阶段结果：${lines.join("　|　")}`;
    box.appendChild(paragraph);
  }
  // 本轮产出的文件：无人值守跑完之后，用户最先想知道的就是"东西在哪"。
  // 这些路径以前只散落在日志里，而日志会被后续输出顶上翻走。
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  if (artifacts.length) {
    const row = document.createElement("p");
    row.className = "hint";
    row.appendChild(document.createTextNode("本轮产出："));
    for (const art of artifacts) {
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.textContent = `打开${art.label}`;
      openButton.addEventListener("click", async () => {
        const r = await rpc.invoke("file:open", { filePath: art.path });
        if (r && r.ok === false) appendLog(`打开「${art.label}」失败：${r.error}`);
      });
      const revealButton = document.createElement("button");
      revealButton.type = "button";
      revealButton.textContent = "定位";
      revealButton.title = art.path;
      revealButton.addEventListener("click", () => rpc.invoke("file:reveal", { filePath: art.path }));
      row.appendChild(openButton);
      row.appendChild(revealButton);
    }
    box.appendChild(row);
  }
}

/** 全自动页的运行模式提示：把"这次要开几个窗口、多慢"说清楚 */
function updateRunModeHint() {
  const box = $("autoRunModeHint");
  const mode = $("autoRunMode") ? $("autoRunMode").value : "protocol";
  if (!box) return;
  // 「账号并发」是设置页的项，这里只是把它对**本次全自动**的含义说出来。
  // 并发 >1 时"账号之间串行、天然有间隔"这句话就不成立了，必须改口 —— 否则
  // 界面在给用户虚假的安全感（这是审查点名过的一类问题）。
  const cc = Number($("accountConcurrency") && $("accountConcurrency").value) || 1;
  const ccNote = cc > 1
    ? `　⚠️ 「账号并发」当前是 ${cc}：多个账号会同时跑，串行间隔没有了。请确认每个账号配了不同出口 IP；比特模式下要同时开 ${cc} 个窗口。`
    : "";
  if (mode === "protocol") {
    box.textContent = `本次全程不开浏览器：爬题/提交/上传/查收录都走协议。${cc > 1 ? "" : "账号之间串行处理，天然有间隔。"}若担心 IP 关联，可在设置页配「账号代理」。${ccNote}`;
  } else if (mode === "bit") {
    box.textContent = `本次每个账号都会打开一个比特窗口：隔离最好，但比较慢、吃内存。建议一次只挑 1~2 个账号跑。${ccNote}`;
  } else {
    box.textContent = `本次用系统 Edge 无头跑：内存比比特小，但所有账号共用同一份浏览器指纹。${ccNote}`;
  }
}
if ($("autoRunMode")) {
  $("autoRunMode").addEventListener("change", () => {
    if ($("browserMode")) $("browserMode").value = $("autoRunMode").value;
    updateRunModeHint();
  });
}
// 反向同步：设置页改了「运行模式」，全自动页那个 select 必须跟着变。
// 只做单向（全自动 → 设置页）出过一个很危险的 bug：用户在设置页选了「比特窗口」（想一账号一指纹），
// 切到全自动页时那个 select 还是旧值「纯协议」，一点「开始」就把它写回 browserMode 并存盘 ——
// 于是**实际按纯协议跑**（不开窗口、所有账号共用本机 IP 与指纹，正是他想规避的），
// 而且设置被永久改回去，全程没有任何提示。两个入口写同一个设置，就必须双向同步。
if ($("browserMode")) {
  $("browserMode").addEventListener("change", () => {
    if ($("autoRunMode")) {
      $("autoRunMode").value = $("browserMode").value;
      updateRunModeHint();
    }
  });
}

// 爬题上限：两个入口绑同一个设置，互相跟着走（同「运行模式」那套做法）
if ($("maxQuestions")) $("maxQuestions").addEventListener("input", () => { if ($("autoMaxQuestions")) $("autoMaxQuestions").value = $("maxQuestions").value; });
if ($("autoMaxQuestions")) $("autoMaxQuestions").addEventListener("input", () => { if ($("maxQuestions")) $("maxQuestions").value = $("autoMaxQuestions").value; });

// 「账号并发」改了要立刻刷新全自动页那句提示（它引用了并发数）
if ($("accountConcurrency")) {
  $("accountConcurrency").addEventListener("input", () => {
    if ($("autoRunMode")) updateRunModeHint();
  });
}

$("startAutoPipeline").addEventListener("click", async () => {
  const stages = [];
  if ($("autoStageCrawl").checked) stages.push("crawl");
  if ($("autoStagePick").checked) stages.push("pick");
  if ($("autoStageGenerate").checked) stages.push("generate");
  if ($("autoStageSubmit").checked) stages.push("submit");
  if ($("autoStageTransfer").checked) stages.push("transfer");
  if ($("autoStageUpload").checked) stages.push("upload");
  // 全自动页的模式是"同一个设置"的第二个入口 —— 单向写回设置页那个，避免两处互相覆盖
  if ($("autoRunMode") && $("browserMode")) $("browserMode").value = $("autoRunMode").value;
  // 爬题上限同理：全自动页这个框和设置页的「任务总量上限」是**同一个设置**，
  // 单向写回设置页那个输入框，再由 saveSettingsQuiet 统一存（只做单向，避免两处互相覆盖）。
  if ($("autoMaxQuestions") && $("maxQuestions")) $("maxQuestions").value = $("autoMaxQuestions").value;
  if (!stages.length) { appendLog("请至少勾选一个阶段。"); return; }
  if (!await saveSettingsQuiet()) return;

  const settings = await rpc.invoke("settings:get");
  // 本次参与的账号：本页填了就用本页的，留空回落到设置页的全部
  const pickedEnvs = $("autoBitEnvs").value.split(/\r?\n|[,，]/).map((s) => s.trim()).filter(Boolean);
  const effectiveEnvs = pickedEnvs.length ? pickedEnvs : (settings.bitEnvs || []).map((e) => e.label || e);
  if (!effectiveEnvs.length) { appendLog("没有可用的账号：请在设置页填「比特环境名称」，或在本页「本次参与的账号」里填。"); return; }
  if ($("autoStageGenerate").checked && !settings.aiApiKey) {
    appendLog("「生成答案」需要 AI Key，请先在「生成答案」页填写。");
    return;
  }
  // 没选资源表**不再拦停**：后端本来就支持"按账号绑定的题材自动搜一批资源"
  //（见 auto-pipeline.js 的搜资源分支）。以前这里硬性 return，等于把后端已经实现的
  // 一条路在界面上堵死 —— 代码里留着、用户走不到，是最容易腐烂的那类分支。
  if ($("autoStageTransfer").checked && !$("autoTransferTable").value) {
    // 但"自动搜"是有前提的：题材绑定 + 搜索词。缺了会在**跑到第 5 个阶段时**才失败
    //（前面爬题/抽题/生成/提交全白跑），所以这里要提前把话说死。
    if (!String(settings.searchKeywords || "").trim()) {
      appendLog("⚠️ 未选网盘资源表，而设置页「搜索词」是空的 —— 自动搜资源会失败，转存阶段会中断整条链，"
        + "前面几个阶段的成果仍保留。建议先选一张资源表，或到设置页配好「搜索词」和「账号题材绑定」。");
    } else {
      appendLog("未选网盘资源表，本次将按账号绑定的题材**自动搜资源**（用设置页的「搜索词」+「账号题材绑定」）。");
    }
  }
  // 上传阶段读的是"上传专用表"，不是抽题表。不预先说一声的话，用户会在结果里
  // 看到一条 ⏭️ 才发现上传没跑 —— 提前一句能省一次整轮。
  if ($("autoStageUpload").checked && !$("autoStageTransfer").checked && !$("autoUploadTable").value) {
    appendLog("注意：「按题材上传」需要「上传专用表」，而本次既没勾「网盘转存」也没指定该表 —— 该阶段会被跳过。");
  }
  const destructive = $("autoStageSubmit").checked || $("autoStageTransfer").checked || $("autoStageUpload").checked;
  if (destructive && !confirm("本次会真实提交答案/转存网盘/上传资源到平台，且全程无人值守。确认继续？")) return;

  $("autoReport").innerHTML = "";
  try {
    const result = await rpc.invoke("task:auto-pipeline", {
      stages,
      bitEnvs: pickedEnvs, // 空数组 = 流水线回落到设置页的全部账号
      // 网盘链账号分工：留空 = 用上面的账号（回落在后端做）
      transferEnvs: $("autoTransferEnvs").value.split(/\r?\n|[,，]/).map((s) => s.trim()).filter(Boolean),
      uploadEnvs: $("autoUploadEnvs").value.split(/\r?\n|[,，]/).map((s) => s.trim()).filter(Boolean),
      pickCount: Number($("autoPickCount").value) || 20,
      batchRows: Number($("autoBatchRows").value) || 500,
      uploadTablePath: $("autoUploadTable").value,
      transferTablePath: $("autoTransferTable").value,
      transferDestDir: $("autoTransferDest").value,
    });
    renderAutoReport(result);
    // 有阶段被跳过时不能说"全部阶段成功" —— 用户等的可能正是被跳过的那一步
    //（典型：上传账号都没有批量发布权益 → 上传整段跳过，但前面都成功）。
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const outcome = result.stopped ? "已手动停止"
      : !result.ok ? "有阶段失败（详见上方结果与运行日志）"
      : skipped.length ? `其余阶段成功，但有 ${skipped.length} 个阶段被跳过：${skipped.map((s) => s.label).join("、")}`
      : "全部阶段成功";
    appendLog(`一键全自动结束：${outcome}。`);
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
  const result = await call("停止任务", "task:stop");
  if (!result) return;
  // accepted=false 表示此刻没有 TaskManager 任务在跑（一键全自动停在"抽题"或阶段之间时如此）。
  // 不区分的话界面只会说"等待任务退出"，而其实没有任何东西在退出 ——
  // 用户会一直等，然后认为软件卡住了。
  if (result.accepted) {
    appendLog(`已请求停止「${result.taskName || "当前任务"}」，它会在下一个检查点退出；`
      + `若 ${Math.round((result.graceMs || 0) / 1000)} 秒后仍未退出，会自动释放任务锁，之后可正常操作。`);
  } else {
    appendLog("已请求停止（当前没有正在运行的任务；若为「一键全自动」，后续阶段不会再启动）。");
  }
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
    if (document.querySelector('.view[data-view="results"].active')) refreshResults();
  }, 300);
});

// ---------- 函数 ----------

async function saveSettingsQuiet() {
  const patch = {};
  patch.apiUrl = $("apiUrl").value;
  patch.activityUrl = $("activityUrl").value.trim();
  patch.bitEnvs = $("bitEnvs").value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  patch.browserMode = $("browserMode").value;
  patch.transferEnvs = $("autoTransferEnvs").value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  patch.uploadEnvs = $("autoUploadEnvs").value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  patch.accountTopics = $("accountTopics").value; // 文本形式「账号=题材」，由后端归一化
  patch.linkRouting = $("linkRouting").value;
  patch.skipReviewAnswers = Boolean($("skipReviewAnswers") && $("skipReviewAnswers").checked);
  patch.topicRules = $("topicRules").value; // 上传侧分类规则，由后端解析
  patch.accountProxies = $("accountProxies").value; // 纯协议模式：每账号出口代理
  patch.accountConcurrency = Number($("accountConcurrency").value) || 1; // 账号并发（1=顺序）
  patch.searchKeywords = $("searchKeywords").value; // 搜资源：按题材的搜索词
  patch.searchPages = Number($("searchPages").value) || 1;
  // 采资源的目标条数与并发（0 份目标 = 采到多少算多少）
  patch.searchTargetCount = Number($("searchTargetCount").value) || 0;
  patch.searchConcurrency = Math.min(5, Math.max(1, Number($("searchConcurrency").value) || 2));
  patch.category = $("category").value;
  patch.timeoutMs = Number($("timeoutMs").value) || undefined;
  patch.verifyWaitSeconds = Number($("verifyWaitSeconds").value) || 0;
  patch.delayMin = Number($("delayMin").value) || 0;
  patch.delayMax = Number($("delayMax").value) || 0;
  // ⚠️ 不能用 `Number(x) || undefined`：界面标签写着「0=不限」，而 `0 || undefined` 会把 0
  // 变成 undefined，后端拿不到这个键就回落到默认 20 —— 用户填 0 想要"不限"，
  // 结果每个分类只爬 20 题，输入框重开又显示 20。空着才表示"不改这个设置"。
  patch.maxQuestions = $("maxQuestions").value.trim() === "" ? undefined : Number($("maxQuestions").value);
  patch.closeAfter = $("closeAfter").value === "true";
  patch.autoSubmit = $("autoSubmit").value === "true";
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
  // 回答最大 tokens / 温度：后端（app-context 的 llm.setConfig）早就接好了，只是界面一直没入口 ——
  // 于是这两个值恒为默认（520 / 0.7），用户想「回答更长一点」「更发散一点」根本无处可改。
  // 温度 0 是**合法值**（确定性输出），不能被 `|| 0.7` 吃掉；只有输入框为空才回落默认。
  patch.aiMaxTokens = Number($("aiMaxTokens").value) || 520;
  const tempRaw = $("aiTemperature").value;
  patch.aiTemperature = String(tempRaw).trim() === "" ? 0.7 : Number(tempRaw);
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
  $("browserMode").value = ["protocol", "bit", "headless"].includes(settings.browserMode) ? settings.browserMode : "protocol";
  if ($("autoRunMode")) { $("autoRunMode").value = $("browserMode").value; updateRunModeHint(); }
  $("accountProxies").value = settings.accountProxies || "";
  $("accountConcurrency").value = Number(settings.accountConcurrency) || 1;
  // 上面那行在两个 if 之后才执行，而 updateRunModeHint 已经先跑过一次了 ——
  // 提示语里带着并发数，所以设完要再刷一次，否则提示与实际设置不一致。
  if ($("autoRunMode")) updateRunModeHint();
  $("autoTransferEnvs").value = (settings.transferEnvs || []).map((env) => env.label || env).join("\n");
  $("autoUploadEnvs").value = (settings.uploadEnvs || []).map((env) => env.label || env).join("\n");
  // 「批量上传」页的账号框：**所见即所传**。启动时回填成真正会被用来上传的那批号
  //（网盘链上传账号优先，否则全部账号），想去掉哪个号直接删那一行 ——
  // 以前这里永远是空的、而后端静默回落全量账号，用户填了账号2 却被传了账号1+账号2。
  $("uploadBitEnv").value = (settingEnvLabels(settings, "uploadEnvs").length
    ? settingEnvLabels(settings, "uploadEnvs")
    : settingEnvLabels(settings, "bitEnvs")).join("\n");
  $("accountTopics").value = Object.entries(settings.accountTopics || {}).map(([account, topic]) => `${account}=${topic}`).join("\n");
  $("linkRouting").value = settings.linkRouting || "strict";
  if ($("skipReviewAnswers")) $("skipReviewAnswers").checked = settings.skipReviewAnswers === true;
  $("topicRules").value = settings.topicRules || "";
  $("searchKeywords").value = settings.searchKeywords || "";
  $("searchPages").value = settings.searchPages || 1;
  $("searchTargetCount").value = Number(settings.searchTargetCount) || 0;
  $("searchConcurrency").value = Math.min(5, Math.max(1, Number(settings.searchConcurrency) || 2));
  $("category").value = settings.category || "情感类";
  $("timeoutMs").value = settings.timeoutMs;
  $("verifyWaitSeconds").value = settings.verifyWaitSeconds;
  $("delayMin").value = settings.delayMin;
  $("delayMax").value = settings.delayMax;
  $("maxQuestions").value = settings.maxQuestions;
  if ($("autoMaxQuestions")) $("autoMaxQuestions").value = $("maxQuestions").value;
  $("closeAfter").value = String(settings.closeAfter);
  $("autoSubmit").value = String(Boolean(settings.autoSubmit));
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
  $("aiMaxTokens").value = settings.aiMaxTokens || 520;
  // 温度用 ?? 而不是 ||：温度 0 是合法值，`0 || 0.7` 会把它显示成 0.7（用户改回 0 却看着像没存上）
  $("aiTemperature").value = settings.aiTemperature ?? 0.7;
  $("submitLimit").value = settings.submitLimit || 0;
  $("accountDailyLimit").value = settings.accountDailyLimit || 10;
  // 同一个设置的第二个入口（「一键全自动」页）。保存时只从上面那一个读，
  // 所以下面挂了 input 监听把它同步过去——两个输入框各自保存会互相覆盖。
  $("autoAccountDailyLimit").value = settings.accountDailyLimit || 10;
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

// 「开始一键全自动」也在列：它和下面这些按钮是同一把锁（TaskManager 单任务互斥）。
// 以前它不在列里，于是全自动跑到一半时这个按钮还是亮的，连点第二次只会换来一句
// "一键全自动正在运行中"的报错 —— 把"正在跑"这件事做成按钮灰掉，比让它报错好。
const ACTION_BUTTON_IDS = ["startCrawl", "randomPick", "startGenerate", "startSubmit", "startBatchTransfer", "startBatchUpload", "startSearchResources", "checkPublished", "refreshAccountOverview", "refreshLocalAccounts", "fetchPassed", "runSelfTest", "startAutoPipeline"];

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
