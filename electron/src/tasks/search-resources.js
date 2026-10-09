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
const homeCrawler = require("../netdisk/home-crawler");
const excel = require("../storage/excel");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // **全文兜底**：搜索只能看到结果的"标题+摘要"，答主把提取码写在完整回答里时摘要根本带不出来。
  // 真机实测：12 条里有 1 条如此，而那是一条确实需要码的分享 —— 注定转存失败。
  // 只对**提取码为空**的行做（本次 1 条），所以额外请求很少；接口实测不需要 Cookie。
  // 请求间隔按 1.5 秒来（与 home-crawler 的问题页兜底同口径），别把知道打成限流。
  const needPwd = rows.filter((r) => !String(r.提取码 || "").trim() && r.问题链接);
  if (needPwd.length) {
    log(`有 ${needPwd.length} 条没有提取码，去问题页全文找一次…`);
    let filled = 0;
    let linkMissing = 0;   // 完整回答里根本没有这个链接
    let noCodeInFull = 0;  // 有链接、但全文里也没写码
    for (const row of needPwd) {
      if (ctx.shouldStop()) break;
      const qid = (String(row.问题链接).match(/\/question\/(?:hx\/)?(\d+)/) || [])[1];
      if (!qid) continue;
      try {
        const full = await homeCrawler.fetchQuestionResources(qid);
        const same = full.filter((x) => x.link === row.链接);
        const hit = same.find((x) => x.pwd);
        if (hit) { row.提取码 = hit.pwd; filled += 1; }
        else if (same.length) noCodeInFull += 1;
        else linkMissing += 1;
      } catch (error) {
        // 单条兜底失败不影响整批（可能是风控/改版），并且要说出来 —— 静默吞掉就又变成"不知为何少了几条"
        log(`（${qid} 全文兜底失败，这条维持无提取码：${error.message}）`);
      }
      await sleep(1500);
    }
    if (filled) log(`✅ 从问题页全文补回了 ${filled} 条的提取码`);
    // 两种"没补到"的原因必须分开说：一个说明我们抓错了来源，一个说明源数据就没给码。
    if (linkMissing) log(`（${linkMissing} 条：问题页的完整回答里**没有这个链接**，多半是搜索摘要里拼出来的，或回答已被删改）`);
    if (noCodeInFull) log(`（${noCodeInFull} 条：完整回答里有链接、但全文都没写码 —— 免密分享正常；若该分享其实需要码（码可能写在图片里或别处），转存时会失败并明确提示你补码）`);
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const outputPath = path.join(deps.dataDir, "搜资源", `搜资源_${stamp}.xlsx`);
  const savedPath = excel.writeWorkbookSafe(outputPath, rows, "搜资源", ["资源名", "链接", "提取码", "问题链接", "来源关键词"], log);
  log(`搜资源产出 ${rows.length} 条：${savedPath}`);
  // 提到了提取码却没解析出来的行 —— **提前说**，别等转存时一条条撞。
  // 真机现场：搜到 10 条里有 1 条提取码为空，而那是一条确实需要码的分享，当时毫无提示。
  const missingPwd = result.rows.filter((r) => r.pwdMissing).length;
  if (missingPwd) {
    log(`⚠️ 其中 ${missingPwd} 条提到了提取码但没能解析出来。如果这些分享确实需要码，转存时会失败（报 verify errno）。`
      + `建议打开资源表把「提取码」列补上，或删掉这几行再跑转存。`);
  }
  // 提取码为空但摘要里**没提**码的，也要说一声 —— 这类多半是"码写在完整答案里、
  // 而搜索结果摘要没带出来"（上面的全文兜底已经尽力去找过了）。免密分享本来就该为空，
  // 所以这里只是提示、不判定为坏数据；真伪到转存时会由 verify 给出明确结论。
  // 计数取**兜底之后**的 rows，别用兜底前的 result.rows（那会把已经补回来的又数一遍）。
  const emptyPwd = rows.filter((r) => !String(r.提取码 || "").trim()).length;
  if (emptyPwd) {
    log(`ℹ️ 仍有 ${emptyPwd} 条没有提取码：免密分享本来就没有码（正常），`
      + `但若它其实需要码，转存时会被拒 —— 报错会明确提示你补「提取码」，已转存的不会重复。`);
  }
  return { count: rows.length, stats: result.stats, outputPath: savedPath };
}

module.exports = { runSearchResourcesTask };
