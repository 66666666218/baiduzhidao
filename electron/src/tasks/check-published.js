"use strict";

/**
 * 查收录 / 批量发布权益检查（原本定义在 app-context.js 里，理由同 search-resources.js）。
 * `deps` 需要：browserPool / log / config / dataDir。
 * 取登录态**优先用「账号凭证」里存好的 Cookie**，没存才开窗口 —— 存过的账号全程纯协议。
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

const workbench = require("../netdisk/workbench");
const excel = require("../storage/excel");
const { describeError } = require("../errors");

/**
 * 从「账号凭证」存的账号里取 Cookie（按比特环境名匹配）。
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
function storedCookieOf(dataDir, envLabel, log) {
  try {
    // ⚠️ 路径是相对**本文件**的。刚从 app-context.js 搬过来时这里还是 "./src/netdisk/manager"，
    // 从 src/tasks/ 解析就成了 src/tasks/src/netdisk/manager —— 不存在，于是被 catch 吞掉、
    // 每次都"回落到开窗口"，把"存过 Cookie 就不开窗口"这条路径**静默废掉**
    //（真机上表现为：明明存了 Cookie，查收录却仍要开比特窗口，内存不够时直接失败）。
    // 相对路径的 require 是这类搬运最容易漏的地方，契约⑥ 只看"标识符有没有定义"，看不到它。
    const { credentialOf } = require("../netdisk/manager");
    // ⚠️ 这里是**形参** dataDir，不是模块级那个 —— 搬运时的批量替换一度把它也改成了
    // `deps.dataDir`，于是函数里冒出个不存在的 deps，抛 ReferenceError 被下面的 catch 吞掉，
    // 表现就是"存过 Cookie 却仍然开窗口"。这个坑和上面那个 require 路径是同一类：
    // **批量替换不认识作用域**，改完必须逐处看过。
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

/**
 * 查收录：核对上传到答主工作台的问答**是否真的被收录**。
 *
 * 为什么需要单独一步：上传接口返回 200 只代表**平台收下了**，之后平台还要异步审核，
 * 审核结果只体现在工作台的「上传记录」里（`qa/api/bulkqa/tasks`）。
 * 三件事是三回事：接口 200 → 审核通过 → 真的出现在回答里。
 *
 * 做法和转存一致：从浏览器取一次 Cookie，之后全程纯协议（不再操作页面）。
 */
async function runCheckPublishedTask(ctx, deps) {
  const { browserPool, log } = deps;
  const settings = deps.config.load();
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
      // 取登录态：**优先用「账号凭证」里存好的 Cookie，没存才开窗口**。
      // 实测：只带 BDUSS 就能调通工作台接口（BDUSS 是百度全域 Cookie），
      // 所以存过的账号不必为每次查收录/权益检查再开一次浏览器。
      let cookieStr = storedCookieOf(deps.dataDir, envLabel, log);
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
            const tmp = path.join(deps.dataDir, "查收录", `.result_${task.id}.xlsx`);
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
    outputPath = path.join(deps.dataDir, "查收录", `收录核对_${stamp}.xlsx`);
    outputPath = excel.writeWorkbookSafe(
      outputPath, rows, "收录核对",
      ["环境", "账号", "任务名", "创建时间", "总数", "已收录", "被拒", "扣额度"], log
    );
    log(`收录明细已导出：${outputPath}`);
  }
  let failedPath = "";
  if (failedRows.length) {
    failedPath = path.join(deps.dataDir, "查收录", `被拒明细_${stamp}.xlsx`);
    failedPath = excel.writeWorkbookSafe(
      failedPath, failedRows, "被拒明细",
      ["环境", "任务名", "任务时间", "qid", "问题", "失败原因", "答案带链接", "问题链接"], log
    );
    log(`被拒明细已导出：${failedPath}`);
  }
  return { stopped, accounts, outputPath, failedPath, failedRows: failedRows.length, checked: okAccounts.length };
}

module.exports = { runCheckPublishedTask, storedCookieOf };
