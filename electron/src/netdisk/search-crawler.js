"use strict";

/**
 * 百度知道搜索采集器（纯协议 · 无浏览器 · 无需登录 Cookie）。
 *
 * 用途：给一个关键词（如「流浪地球 网盘」），从搜索结果里直接捞网盘资源。
 * 与「主页找资源」互补：那条路要从答主主页绕一圈，这条直接从问题命中，
 * 少一次跳转，也不依赖旧版 uid 才能用的 myanswer 接口。
 *
 * 为什么能纯协议：搜索结果是**服务端渲染**的（整页只有 1 个 hotword JSON 请求），
 * 不支持 JS 也能拿到完整 HTML。已实测三个关键词全部 HTTP 200、无异常页。
 *
 * 已知坑：单条结果的摘要会**截断**。百度分享码是 23 位，而 extractPanLinks 只要求
 * ≥5 位——被截断的残码会被当成有效链接收进来。这里按码长过滤并计数，
 * 宁可少收也不把半个链接写进资源表（那种链接转存必然失败）。
 */

const { extractPanLinks, detectBlockedPage } = require("./home-crawler");
const { parseTopicRules } = require("../domain/topic-rules");

/**
 * 各题材的默认搜索词。
 * **写什么就搜什么**（不自动拼「网盘」）——这样你想搜精确词还是宽泛词都能自己控。
 * 格式与分类规则一致：`题材=词1|词2`。
 */
const DEFAULT_SEARCH_KEYWORDS = [
  "影视=电影 网盘|电视剧 网盘|动漫 网盘",
  "游戏=游戏 网盘|手游 网盘|单机游戏 网盘",
  "小说=小说 网盘|电子书 网盘|有声小说 网盘",
  "漫画=漫画 网盘|条漫 网盘",
  "音乐=音乐 网盘|无损音乐 网盘|专辑 网盘",
  "课程=课程 网盘|教程 网盘|网课 网盘",
  "软件=软件 网盘|绿色软件 网盘|办公软件 网盘",
  "资料=素材 网盘|模板 网盘|资料包 网盘",
].join("\n");

const PAN_HOST = "https://zhidao.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** 百度知道搜索结果每页固定 10 条 */
const PAGE_SIZE = 10;
/** 分享码最小可信长度：百度是 23 位，留点余量取 20，短于此的视为被截断 */
const MIN_SHARE_CODE = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function defaultFetch(url, { referer } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Referer": referer || `${PAN_HOST}/` },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || /timeout|abort/i.test(e.message || ""))) {
      throw new Error("请求超时（20 秒无响应）");
    }
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url.slice(0, 100)}`);
  return res.text();
}

function buildSearchUrl(keyword, pageIndex) {
  const pn = Math.max(0, Number(pageIndex) || 0) * PAGE_SIZE;
  return `${PAN_HOST}/search?word=${encodeURIComponent(keyword)}&site=-1&sites=0&date=0&pn=${pn}`;
}

/** 去掉高亮标签与实体，压平空白 */
function cleanText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** 问题链接归一化：去掉查询串、统一 https */
function normalizeQuestionUrl(raw) {
  const text = String(raw || "").trim();
  const path = (text.match(/\/question\/[\w./-]+/) || [])[0];
  return path ? `${PAN_HOST}${path}` : "";
}

/**
 * 解析搜索结果页 → [{ questionUrl, title, snippet }]
 *
 * 结构（实测）：每条结果是一个 <dl class="dl">，标题是其中的 <a class="ti" href="…">，
 * 回答摘要跟在 <dd class="dd answer"> 里，网盘链接就明晃晃地写在摘要里。
 */
function parseSearchResults(html) {
  const text = String(html || "");
  const out = [];
  // 按结果块切分；切完先截到 </dl>，否则最后一块会把页脚也吞进来
  for (const chunk of text.split(/<dl class="dl"/).slice(1)) {
    const block = chunk.split("</dl>")[0];
    const anchor = block.match(/<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*\bti\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a\b[^>]*class="[^"]*\bti\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const questionUrl = normalizeQuestionUrl(anchor[1]);
    if (!questionUrl) continue;
    out.push({
      questionUrl,
      title: cleanText(anchor[2]),
      snippet: cleanText(block).slice(0, 3000),
    });
  }
  return out;
}

/** 分享码长度过滤：截断的残码一律不要 */
function splitByShareCode(links) {
  const usable = [];
  let truncated = 0;
  for (const item of links) {
    const code = String(item.link || "").split("/s/")[1] || "";
    if (code.length >= MIN_SHARE_CODE) usable.push(item);
    else truncated += 1;
  }
  return { usable, truncated };
}

/**
 * 按「账号绑定的题材」生成搜索词。
 *
 * 同一个题材只出一份：多个账号绑同一题材时结果本就一样，搜两遍纯属浪费请求。
 * 题材没配搜索词的直接跳过（并回报），不会硬凑。
 *
 * @param {string[]} topics        账号绑定的题材列表（可重复）
 * @param {string}   keywordRules  `题材=词1|词2` 文本
 * @returns {{terms: Array<{topic:string, term:string}>, uncovered: string[]}}
 */
function buildTopicSearchTerms(topics, keywordRules) {
  const rules = parseTopicRules(keywordRules);
  const wordsByTopic = new Map(rules.map((r) => [r.name, r.keywords]));
  const wanted = [...new Set((Array.isArray(topics) ? topics : []).map((t) => String(t || "").trim()).filter(Boolean))];

  const terms = [];
  const seen = new Set();
  const covered = new Set();
  for (const topic of wanted) {
    const words = wordsByTopic.get(topic);
    if (!words || !words.length) continue;
    covered.add(topic);
    for (const word of words) {
      const term = String(word).trim();
      if (!term || seen.has(term)) continue;
      seen.add(term);
      terms.push({ topic, term });
    }
  }
  return { terms, uncovered: wanted.filter((t) => !covered.has(t)) };
}

/**
 * 搜索采集主入口。
 *
 * 【为什么支持并发】原来是「关键词 → 逐页」严格串行，每个关键词每个页数都要等
 * `pageDelayMs`（默认 1.5 秒）。3 个题材 × 2 个词 × 2 页 = 12 个请求 = 18 秒纯等待，
 * 而每一个请求本身只花几百毫秒 —— **时间几乎全花在等，不在干活**。
 * 但注意：并发打的是**百度知道的搜索页**（读接口，与网盘那条写接口不是一回事），
 * 网盘转存那条路的并发降级不适用于这里。
 *
 * 【为什么能安全降级】`detectBlockedPage` 已经在判异常页。一旦真的撞上，
 * 立刻把并发降回 1（只留第一个 worker 继续），而不是整批废掉 ——
 * 宁可变慢也不白跑，这条原则与转存那条路一致。
 *
 * 【结果为什么仍然稳定】并行会让 push 顺序变成运气。这里按「先并行跑完、
 * 再按关键词顺序摊平」的方式汇总，`["叶问","叶问2"]` 两个词无论谁先返回，
 * 输出顺序都一样 —— 否则同样的输入两次跑出两份不同的表，去重/断点全跟着飘。
 *
 * @returns {{rows:Array, stats:object}} rows: { name, link, pwd, questionUrl, source }
 */
async function crawlSearchResources({
  keywords,
  pages = 1,
  limit = 0,
  onLog = () => {},
  onProgress,
  shouldStop,
  fetchImpl = defaultFetch,
  pageDelayMs = 1500,
  concurrency = 1,
  pageStart = 0,
} = {}) {
  const list = (Array.isArray(keywords) ? keywords : []).map((k) => String(k || "").trim()).filter(Boolean);
  if (!list.length) throw new Error("请填写至少一个搜索关键词");
  const pageEnd = Math.max(1, Number(pages) || 1);
  // 「从第几页开始」是**补足**用的：第一轮已经抓过第 0~2 页，加码时只抓第 3 页往后，
  // 不重复请求已经看过的那些页。手上正翻着 4 页还嫌不够，再去重抓前几页纯属浪费。
  const pageFrom = Math.min(Math.max(0, Number(pageStart) || 0), Math.max(0, pageEnd - 1));

  const seenLinks = new Set();
  const homepages = new Set();   // 搜索结果里顺带收集到的答主主页（零额外请求）
  const stats = { keywords: list.length, pagesFetched: 0, failed: 0, results: 0, truncated: 0, linked: 0 };
  // 进度以「关键词 × 页」为单位上报。没有这个，搜资源阶段在界面上是完全静默的：
  // 既看不出在动，暂停/停止按钮也一直不启用。
  const totalUnits = list.length * Math.max(0, pageEnd - pageFrom);
  let doneUnits = 0;
  const report = () => onProgress?.({ done: doneUnits, total: totalUnits, produced: rowsCount() });

  // 每个关键词一份结果；汇总时按关键词顺序摊平，保证输出顺序与耗时无关
  const perKeyword = list.map(() => []);
  let produced = 0;
  const rowsCount = () => produced;
  /** 把一条链接收进来（返回是否新增） */
  const tryPush = (bucket, row) => {
    if (seenLinks.has(row.link)) return false;
    seenLinks.add(row.link);
    bucket.push(row);
    produced += 1;
    return true;
  };

  // 任务队列：扁平化成「关键词 × 页」的一个个小任务，worker 从里面抢。
  // 扁平化的好处是并发粒度落在"最细的那层"上，某个关键词某页卡住不会拖住整批。
  const jobs = [];
  for (let ki = 0; ki < list.length; ki += 1) {
    for (let pageIndex = pageFrom; pageIndex < pageEnd; pageIndex += 1) {
      jobs.push({ ki, keyword: list[ki], pageIndex });
    }
  }

  const workerCount = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1) || 1, jobs.length || 1));
  // 降级开关：任何一个 worker 撞到异常页就置 true，之后只有 worker 0 继续干活。
  // 这样"加压 → 被拦 → 自动退回串行"是自愈的，不需要用户回来重跑。
  let degraded = false;
  let cursor = 0;

  report();
  const takeJob = () => (cursor < jobs.length ? jobs[cursor++] : null);

  async function worker(slot) {
    while (true) {
      if (shouldStop && shouldStop()) return;
      if (limit && produced >= limit) return;
      // 被降级了：只有 0 号 worker 继续，其它退出（等效于立刻回到串行）
      if (degraded && slot > 0) return;
      const job = takeJob();
      if (!job) return;

      const bucket = perKeyword[job.ki];
      let html;
      try {
        html = await fetchImpl(buildSearchUrl(job.keyword, job.pageIndex), { referer: `${PAN_HOST}/` });
      } catch (e) {
        stats.failed += 1;
        onLog(`⚠️ 搜索失败（跳过）：${job.keyword} 第 ${job.pageIndex + 1} 页 — ${e.message}`);
        doneUnits += 1;
        report();
        continue;
      }
      stats.pagesFetched += 1;

      const blocked = detectBlockedPage(html);
      if (blocked) {
        stats.failed += 1;
        onLog(`⚠️ 搜索返回异常页（${blocked}）：${job.keyword} 第 ${job.pageIndex + 1} 页`);
        if (!degraded && workerCount > 1) {
          degraded = true;
          onLog(`　→ 已自动把并发降到 1（其余线程退出），剩下的继续跑完，不用手工重来。`);
        }
        continue;
      }

      // 顺手把这一页里出现的答主主页都记下来（结果卡片里就有，不用额外请求）：
      for (const hp of extractAuthorHomepages(html)) homepages.add(hp);
      const results = parseSearchResults(html);
      stats.results += results.length;
      if (!results.length) onLog(`该页没解析到结果：${job.keyword} 第 ${job.pageIndex + 1} 页`);

      for (const item of results) {
        if (limit && produced >= limit) break;
        const { usable, truncated } = splitByShareCode(extractPanLinks(`${item.title}\n${item.snippet}`));
        stats.truncated += truncated;
        for (const { link, pwd, pwdMissing } of usable) {
          // 把"提到了码但没解析出来"这件事一路带下去：只在本行失败时留个记号，
          // 结果是"搜完就报一次总数"，用户能提前回表补码，而不是转存时才一条条撞。
          if (pwdMissing) stats.pwdMissing = (stats.pwdMissing || 0) + 1;
          // 「搜到的链接数」只数**去重后真正入库的**，重复链接不该算进产出
          if (tryPush(bucket, { name: item.title, link, pwd, pwdMissing: Boolean(pwdMissing), questionUrl: item.questionUrl, source: `搜索:${job.keyword}` })) {
            stats.linked += 1;
          }
        }
      }
      await sleep(pageDelayMs);
      doneUnits += 1;
      report();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, slot) => worker(slot)));

  // 按关键词顺序摊平（并行汇总 → 顺序摊平），保证输出与耗时无关
  const rows = [];
  for (const bucket of perKeyword) rows.push(...bucket);
  const finalRows = limit > 0 ? rows.slice(0, limit) : rows;

  if (stats.truncated) {
    onLog(`⚠️ 丢弃 ${stats.truncated} 条被摘要截断的残缺链接（分享码不足 ${MIN_SHARE_CODE} 位，转存必然失败）`);
  }
  if (!finalRows.length) {
    if (shouldStop && shouldStop()) return { rows: finalRows, stats, homepages: Array.from(homepages), stopped: true };
    throw new Error("这些关键词没有搜到带网盘链接的结果（可换关键词或增加页数）");
  }
  return { rows: finalRows, stats, homepages: Array.from(homepages) };
}

/**
 * 从知道搜索结果页里收集**答主主页**。
 *
 * 为什么值得做：一个资源型答主的主页里往往挂着几十条带网盘链接的回答，
 * 比"搜索页那 10 条"多得多。而且**爬主页走的是知道接口，不碰网盘接口** ——
 * 不会撞转存那条"分享页限流"（实测那是网盘侧、按 IP 的写请求密度触发的）。
 *
 * 主页链接在搜索结果卡片里就有（`usercenter?uid=xxxx`），不用额外请求。
 */
function extractAuthorHomepages(html) {
  const out = new Set();
  // ⚠️ 字符集要**字母数字**，不能只认十六进制：知道真实 uid 形如
  // `4d424069236f25705e79g008001000000`（中间带 g）。用 [0-9a-f] 会在 g 处截断，
  // 得到一个残缺 uid，主页接口对它返回"0 条回答" —— 我第一版就是这么写的，实测才发现。
  const re = /usercenter\?uid=([0-9a-z]{8,48})/gi;
  let m;
  while ((m = re.exec(String(html || "")))) out.add(`${PAN_HOST}/usercenter?uid=${m[1]}`);
  return Array.from(out);
}

module.exports = {
  PAN_HOST,
  PAGE_SIZE,
  MIN_SHARE_CODE,
  DEFAULT_SEARCH_KEYWORDS,
  buildSearchUrl,
  cleanText,
  normalizeQuestionUrl,
  parseSearchResults,
  extractAuthorHomepages,
  splitByShareCode,
  buildTopicSearchTerms,
  crawlSearchResources,
};
