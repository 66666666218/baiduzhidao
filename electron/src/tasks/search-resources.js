"use strict";

/**
 * 搜资源：纯协议搜百度知道（无浏览器、无需 Cookie）→ 产出资源表，直接喂批量转存。
 *
 * 原本定义在 app-context.js（装配文件）里，2026-10-10 搬到任务层：
 * 放那儿只有主进程能调，脚本要跑同一条链就只能抄一遍，而「抄第二遍」是这个仓库出过事故的原因。
 * `deps` 需要：log / config / dataDir。
 */

const path = require("path");

const searchCrawler = require("../netdisk/search-crawler");
const excel = require("../storage/excel");

/**
 * 搜资源：纯协议搜百度知道（无浏览器、无需 Cookie）→ 产出资源表，直接喂批量转存。
 *
 * 抽成具名函数是为了让「一键全自动」编排也能调同一个实现，而不是抄第二遍。
 */
async function runSearchResourcesTask(ctx, deps) {
  const { log } = deps;
  const settings = deps.config.load();
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
  const outputPath = path.join(deps.dataDir, "搜资源", `搜资源_${stamp}.xlsx`);
  const savedPath = excel.writeWorkbookSafe(outputPath, rows, "搜资源", ["资源名", "链接", "提取码", "问题链接", "来源关键词"], log);
  log(`搜资源产出 ${rows.length} 条：${savedPath}`);
  return { count: rows.length, stats: result.stats, outputPath: savedPath };
}

module.exports = { runSearchResourcesTask };
