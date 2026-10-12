"use strict";

/**
 * 搜资源：纯协议搜百度知道（无浏览器、无需 Cookie）→ 产出资源表，直接喂批量转存。
 *
 * 原本定义在 app-context.js（装配文件）里，2026-10-10 搬到任务层：
 * 放那儿只有主进程能调，脚本要跑同一条链就只能抄一遍，而「抄第二遍」是这个仓库出过事故的原因。
 * `deps` 需要：log / config / dataDir。
 *
 * 【为什么分成「先全量采集」和「再批量转存」两件事】
 * 采集打的是**百度知道的读接口**（搜索页 / 答主主页 / 问题页），可以放心并发、也可以失败重来 ——
 * 它不占网盘额度、不写任何东西、跑第二次唯一的代价是时间。
 * 转存打的是**百度网盘的写接口**，那条路有硬门槛：同一出口 IP 的短时并发会被降级
 *（实测并发 2 就 100% 失败，详见 batch-transfer.js）。两条路的节奏完全不一样，
 * 混在一起跑只能取两者的最慢值。所以：**先把资源全部采集成一张表，再一次性批量转存生成**。
 *
 * 【为什么要「目标条数 + 自动补足」】
 * 用户只选了 3 个题材来采集时，经常出现"采出来不够"的情况（某题材热词少 / 摘要里没带链接）。
 * 以前的处理是原地结束、给一句总数，用户发现不够只能自己改页数再跑一遍。现在改成：
 * 不到目标就**自动往上加码**（多翻页 → 多爬答主主页 → 补泛化搜索词），每一轮加了多少都写进日志。
 */

const path = require("path");

const searchCrawler = require("../netdisk/search-crawler");
const homeCrawler = require("../netdisk/home-crawler");
const excel = require("../storage/excel");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 正整数夹取（缺省给 fallback），界面上乱填不会把并发搞成 0 或 999 */
function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 翻页间隔（毫秒）：**payload 优先 → 设置页的「翻页间隔」→ 兜底 1500**。
 *
 * 为什么单独抽出来：以前这里只读 `payload.pageDelayMs`，兜底 1500，**完全不看设置页**；
 * 而"搜资源"这条路径（手动和 auto-pipeline）从来不传 payload.pageDelayMs ——
 * 于是设置页那个「翻页间隔」对搜资源**一点作用都没有**，永远按 1500 跑。
 * 用户想让它快/慢一点，改设置毫无反馈，正是"设了不生效"的典型。
 * 兜底保留 1500（比爬题的 800 更保守）：打的是知道搜索接口，宁慢一点点。
 */
function resolvePageDelayMs(payload, settings) {
  const p = payload || {};
  const s = settings || {};
  // 先算出"设置页/兜底"这一档，它同时也是**非法 payload 的回落目标** ——
  // 注意 `Number(null) === 0`，所以不能让 raw 直接等于 null 掉进 clampInt（那会变成"不等待"）。
  const fromSettings = clampInt(s.pageDelayMs, 0, 10000, 1500);
  if (p.pageDelayMs == null) return fromSettings;
  return clampInt(p.pageDelayMs, 0, 10000, fromSettings);
}

/**
 * 把新采到的行并进已有结果（按链接去重，保留先来先到）。
 * @returns {number} 本次新增条数
 */
function mergeRows(target, seen, incoming) {
  let added = 0;
  for (const row of incoming || []) {
    const key = String(row.link || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.push(row);
    added += 1;
  }
  return added;
}

/**
 * 生成「补足计划」：每一轮比上一轮多加一点筹码。
 *
 * 顺序是有讲究的 —— **先翻页、再爬主页、最后才加词**：
 *   翻页：还在原关键词的结果集里，相关性最好，代价最小；
 *   主页：答主主页里往往挂着几十条带链接的回答，是同一个领域里"批量量最大"的来源；
 *   加词：换成泛化搜索词（题材名本身），相关性最差，留到最后兜底。
 * 每一轮的凭据（起止页数 / 主页数 / 兜底深度）都写在返回的 step 里，日志能照着念，
 * 用户看到"还差 30 条，正在多爬主页"时知道自己为什么在等。
 */
function buildSupplementPlan({ basePages, baseHomepages, baseEnrich, maxPages, maxHomepages, maxEnrich, topics }) {
  const steps = [
    { label: "首轮·按当前设置", pages: basePages, pageStart: 0, homepages: baseHomepages, enrich: baseEnrich, extraTerms: [] },
    { label: "补足①·搜索多翻几页", pages: maxPages, pageStart: basePages, homepages: baseHomepages, enrich: baseEnrich, extraTerms: [] },
    { label: "补足②·多爬几个答主主页", pages: maxPages, pageStart: maxPages, homepages: maxHomepages, enrich: maxEnrich, extraTerms: [] },
    { label: "补足③·补泛化搜索词", pages: maxPages, pageStart: maxPages, homepages: maxHomepages, enrich: maxEnrich, extraTerms: buildGenericTerms(topics) },
  ];
  // 已经到顶的轮次没有意义（跑完也不会多出一条），直接不进流程，省得白等一轮网络。
  return steps.filter((step, index) => {
    if (index === 0) return true;
    if (index === 1) return step.pages > basePages;
    if (index === 2) return step.homepages > baseHomepages || step.enrich > baseEnrich;
    return Array.isArray(step.extraTerms) && step.extraTerms.length > 0;
  });
}

/**
 * 泛化搜索词：题材名本身 + 「题材名 网盘」。
 * 用户自己配的词（比如「单机游戏 网盘」）搜不出来时，用题材名裸搜往往还能兜到一点。
 * 只在该题材确实配了绑定时才生成（没绑题材的不在这里瞎凑）。
 */
function buildGenericTerms(topics) {
  const out = [];
  const seen = new Set();
  for (const topic of (Array.isArray(topics) ? topics : []).map((t) => String(t || "").trim()).filter(Boolean)) {
    for (const term of [topic, `${topic} 网盘`]) {
      if (seen.has(term)) continue;
      seen.add(term);
      out.push({ topic, term });
    }
  }
  return out;
}

/**
 * 搜资源：纯协议搜百度知道（无浏览器、无需 Cookie）→ 产出资源表，直接喂批量转存。
 *
 * 抽成具名函数是为了让「一键全自动」编排也能调同一个实现，而不是抄第二遍。
 */
async function runSearchResourcesTask(ctx, deps) {
  const { log } = deps;
  const settings = deps.config.load();
  const payload = ctx.livePayload ? ctx.livePayload() : ctx.payload || {};
  const explicit = (Array.isArray(payload.keywords) ? payload.keywords : [])
    .map((x) => String(x || "").trim()).filter(Boolean);

  let terms;
  let topics = [];
  if (explicit.length) {
    terms = explicit.map((term) => ({ topic: "", term }));
  } else {
    // 用「账号绑定的题材」决定搜什么：哪个账号负责哪类资源，就搜哪类。
    // 传了 bitEnvs 就只看这些账号绑的题材（一键全自动可以只挑几个号跑），
    // 否则用设置页里全部账号的题材。
    const topicMap = settings.accountTopics || {};
    const picked = (Array.isArray(payload.bitEnvs) ? payload.bitEnvs : [])
      .map((e) => (e && typeof e === "object" ? e.label ?? e.name : e))
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    topics = picked.length
      ? picked.map((name) => topicMap[name]).filter(Boolean)
      : Object.values(topicMap);
    topics = Array.from(new Set(topics.map((t) => String(t || "").trim()).filter(Boolean)));
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

  // ── 参数 ──
  const limit = Number(payload.limit) || 0;                      // 硬上限：到了就不采了
  const target = Math.max(0, Number(payload.targetCount) || 0);   // 目标条数：不到就自动补足
  const concurrency = clampInt(payload.searchConcurrency ?? settings.searchConcurrency, 1, 5, 2);
  const pageDelayMs = resolvePageDelayMs(payload, settings);

  const basePages = Math.max(1, Number(payload.pages) || settings.searchPages || 1);
  const maxPages = Math.max(basePages, Number(payload.maxPages) || Math.min(10, Math.max(5, basePages * 3)));
  const baseHp = Math.max(0, Number(payload.homepageLimit) || 3);
  const maxHp = Math.max(baseHp, Number(payload.maxHomepageLimit) || 20);
  const baseEnrich = Math.max(0, Number(payload.homepageEnrichLimit) || 10);
  const maxEnrich = Math.max(baseEnrich, Number(payload.maxEnrichLimit) || 50);

  const collected = [];
  const seenLinks = new Set();
  const homepagePool = new Set();
  const crawledHomepages = new Set();
  const rounds = [];

  if (target > 0) log(`目标 ${target} 条${limit > 0 ? `（硬上限 ${limit} 条）` : ""}：先全量采集进表格，不够会自动加码补足。`);

  const plan = buildSupplementPlan({
    basePages, baseHomepages: baseHp, baseEnrich, maxPages, maxHomepages: maxHp, maxEnrich, topics,
  });

  let roundTerms = terms;
  for (const [index, step] of plan.entries()) {
    if (ctx.shouldStop()) break;
    if (target > 0 && collected.length >= target) break;
    if (limit > 0 && collected.length >= limit) break;
    // 首轮之后的每一轮，要么搜索范围变大了，要么加了新词 —— 否则这轮什么都多不出来。
    // 【新词要从第 0 页开始搜】泛化词是这一轮才拿出来的，以前一页都没看过；
    // 沿用"跳过已抓过的页"会把它们整篇跳过，看着像白白多跑一轮、其实一条都没去搜。
    const newTerms = diffTerms(step.extraTerms || [], roundTerms);
    const useTerms = newTerms.length ? newTerms : roundTerms;
    const fromPage = newTerms.length ? 0 : step.pageStart;
    const toPage = newTerms.length ? Math.max(basePages, step.pages) : step.pages;
    if (index > 0) {
      const short = target > 0 ? Math.max(0, target - collected.length) : 0;
      const how = index === 1 ? "，把每个词多翻几页"
        : index === 2 ? "，去答主主页里批量捞"
        : `，加上题材泛化词（${newTerms.map((t) => t.term).join("/")}）`;
      log(`── ${step.label}：还差 ${short || "若干"} 条${how} ──`);
      if (index === 3 && !newTerms.length) log(`　（泛化词都已经被前面的词覆盖了，这一轮跳过）`);
    }

    // 1) 关键词搜索
    let addedSearch = 0;
    if (useTerms.length && toPage > fromPage) {
      try {
        const search = await searchCrawler.crawlSearchResources({
          keywords: useTerms.map((t) => t.term),
          pages: toPage,
          pageStart: fromPage,
          limit: 0,
          concurrency,
          pageDelayMs,
          onLog: log,
          onProgress: (p) => ctx.report({ done: Math.min(p.done, p.total), total: p.total, status: "running" }),
          shouldStop: () => ctx.shouldStop(),
        });
        for (const hp of search.homepages || []) homepagePool.add(hp);
        addedSearch = mergeRows(collected, seenLinks, search.rows);
      } catch (error) {
        // 补足轮搜不到东西不算失败（首轮才会真的一无所获），说了继续下一轮
        log(`（${step.label}的搜索部分没收到东西：${error.message}）`);
      }
    }

    // 2) 答主主页兜底：搜索结果页里本来就带着答主主页链接（结果卡片里就有，零额外请求）。
    // 一个资源型答主的主页往往挂着几十条带网盘链接的回答，比"搜索页那 10 条"多得多；
    // 而且这条路走的是**知道接口、不碰网盘接口** —— 不会撞转存那条"分享页限流"。
    let addedHome = 0;
    const wanted = Math.max(step.homepages, index === 0 ? baseHp : 0);
    // **只爬还没爬过的主页**：同一个主页第二轮再爬一遍，返回的是同一批链接，
    // 去重后新增必为 0 —— 纯属把刚才那几十秒再花一遍。
    const fresh = Array.from(homepagePool).filter((hp) => !crawledHomepages.has(hp));
    const pool = wanted > 0 ? fresh : [];
    if (pool.length && !ctx.shouldStop()) {
      const pickCount = Math.min(wanted, pool.length);
      const picked = pool.slice(0, pickCount);
      log(`待爬的答主主页有 ${pool.length} 个${fresh.length !== homepagePool.size ? `（其中 ${homepagePool.size - fresh.length} 个前面几轮已爬过，跳过）` : ""}，本次挑 ${pickCount} 个去捞资源…`);
      try {
        const hp = await homeCrawler.crawlHomeResources({
          homepages: picked,
          limit: 0,
          enrichLimit: step.enrich,
          onLog: log,
          shouldStop: () => ctx.shouldStop(),
        });
        for (const hpUrl of picked) crawledHomepages.add(hpUrl);
        addedHome = mergeRows(collected, seenLinks, hp.rows || []);
        log(`从这几个主页额外收到 ${addedHome} 条资源`);
      } catch (error) {
        // 单条兜底失败不影响搜索结果 —— 但要说出来，别静默少了几条
        log(`（主页兜底失败，不影响关键词搜索的结果：${error.message}）`);
      }
    }

    rounds.push({ label: step.label, search: addedSearch, home: addedHome, total: collected.length });
    if (index > 0) log(`　${step.label}结束：本轮新增 ${addedSearch + addedHome} 条，累计 ${collected.length} 条${target ? `/${target}` : ""}`);
    roundTerms = useTerms;
    if (ctx.shouldStop()) break;
  }

  if (!collected.length && ctx.shouldStop()) {
    log("收到停止信号，本轮没采到资源。");
    return { count: 0, stats: { stopped: true }, outputPath: "" };
  }
  if (!collected.length) {
    throw new Error("这些关键词没有搜到带网盘链接的结果（可换关键词、增加页数，或提高「目标条数」让软件自动补足）");
  }

  const before = collected.length;
  const finalRows = limit > 0 ? collected.slice(0, limit) : collected;
  log(`采集结束：${finalRows.length} 条${before !== finalRows.length ? `（超过硬上限 ${limit}，截断）` : ""}`
    + `${target ? `，目标 ${target} 条${finalRows.length >= target ? "已达成" : `**差 ${target - finalRows.length} 条未达成**`}` : ""}`);
  if (target > 0 && finalRows.length < target) {
    log(`　⚠️ 没能采够：这几个题材的搜索词/主页都挖完了。想凑够就去设置页给这些题材多加几个搜索词，`
      + `或到「批量转存」页多粘几个同类答主主页跑一次「主页找资源」。已采到的 ${finalRows.length} 条照常落表。`);
  }

  // 列顺序有讲究：batch-transfer 靠列名猜「名称列/链接列/提取码列」，
  // 名称列必须在最前面，否则它可能把别的列当成资源名。
  const rows = finalRows.map((r) => ({
    资源名: r.name,
    链接: r.link,
    提取码: r.pwd,
    问题链接: r.questionUrl,
    来源关键词: r.source,
  }));

  // ── 全文兜底 ──
  // 搜索只能看到结果的"标题+摘要"，答主把提取码写在完整回答里时摘要根本带不出来。
  // 真机实测：12 条里有 1 条如此，而那是一条确实需要码的分享 —— 注定转存失败。
  // 只对**提取码为空**的行做，所以额外请求很少；接口实测不需要 Cookie。
  //
  // 这里改成**小并发**：原来是严格串行 + 每条睡 1.5 秒，几十条就几分钟纯等待，
  // 而这正好是用户抱怨"采集慢"的主要来源之一。并发数刻意压在 2 —— 打的是知道侧的读接口，
  // 快一点点犯不上把人家打限流；每个 worker 之间仍保留原来的 1.5 秒间隔。
  const needPwd = rows.filter((r) => !String(r.提取码 || "").trim() && r.问题链接);
  if (needPwd.length) {
    const backfillCc = clampInt(payload.pwdBackfillConcurrency ?? settings.searchConcurrency, 1, 3, 2);
    log(`有 ${needPwd.length} 条没有提取码，去问题页全文找一次（并发 ${backfillCc}）…`);
    let filled = 0;
    let linkMissing = 0;   // 完整回答里根本没有这个链接
    let noCodeInFull = 0;  // 有链接、但全文里也没写码
    let cursor = 0;
    const takeNext = () => (cursor < needPwd.length ? needPwd[cursor++] : null);
    await Promise.all(Array.from({ length: Math.min(backfillCc, needPwd.length) }, async () => {
      while (!ctx.shouldStop()) {
        const row = takeNext();
        if (!row) return;
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
    }));
    if (filled) log(`✅ 从问题页全文补回了 ${filled} 条的提取码`);
    // 两种"没补到"的原因必须分开说：一个说明我们抓错了来源，一个说明源数据就没给码。
    if (linkMissing) log(`（${linkMissing} 条：问题页的完整回答里**没有这个链接**，多半是搜索摘要里拼出来的，或回答已被删改）`);
    if (noCodeInFull) log(`（${noCodeInFull} 条：完整回答里有链接、但全文都没写码 —— 免密分享正常；若该分享其实需要码（码可能写在图片里或别处），转存时会失败并明确提示你补码）`);
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const outputPath = path.join(deps.dataDir, "搜资源", `搜资源_${stamp}.xlsx`);
  const savedPath = excel.writeWorkbookSafe(outputPath, rows, "搜资源", ["资源名", "链接", "提取码", "问题链接", "来源关键词"], log);
  log(`搜资源产出 ${rows.length} 条：${savedPath}`);
  log(`── 下一步：到「批量转存」页确认资源表格已是这张表，点「开始批量转存」，一次性转存并生成上传专用表 ──`);
  // 提到了提取码却没解析出来的行 —— **提前说**，别等转存时一条条撞。
  // 真机现场：搜到 10 条里有 1 条提取码为空，而那是一条确实需要码的分享，当时毫无提示。
  const missingPwd = finalRows.filter((r) => r.pwdMissing).length;
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
  return {
    count: rows.length,
    target,
    targetReached: target > 0 ? rows.length >= target : true,
    rounds,
    outputPath: savedPath,
  };
}

/** 按 term 去重（同一搜索词可能被多个题材同时配到，跑两遍纯属浪费请求） */
function dedupeTerms(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = String(item && item.term || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 从 candidates 里挑出 base 里还没有的词（补足时只需要搜**新增的**那几个） */
function diffTerms(candidates, base) {
  const known = new Set((base || []).map((t) => String(t && t.term || "").trim()).filter(Boolean));
  return dedupeTerms(candidates).filter((t) => !known.has(String(t.term).trim()));
}

module.exports = { runSearchResourcesTask, buildSupplementPlan, buildGenericTerms, dedupeTerms, diffTerms, mergeRows, clampInt, resolvePageDelayMs };
