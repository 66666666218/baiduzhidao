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
 * @returns {{rows:Array, stats:object}} rows: { name, link, pwd, questionUrl, source }
 */
async function crawlSearchResources({
  keywords,
  pages = 1,
  limit = 0,
  onLog = () => {},
  shouldStop,
  fetchImpl = defaultFetch,
  pageDelayMs = 1500,
} = {}) {
  const list = (Array.isArray(keywords) ? keywords : []).map((k) => String(k || "").trim()).filter(Boolean);
  if (!list.length) throw new Error("请填写至少一个搜索关键词");
  const pageCount = Math.max(1, Number(pages) || 1);

  const rows = [];
  const seenLinks = new Set();
  const stats = { keywords: list.length, pagesFetched: 0, failed: 0, results: 0, truncated: 0, linked: 0 };

  for (const keyword of list) {
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      if (shouldStop && shouldStop()) break;
      if (limit && rows.length >= limit) break;
      let html;
      try {
        html = await fetchImpl(buildSearchUrl(keyword, pageIndex), { referer: `${PAN_HOST}/` });
      } catch (e) {
        stats.failed += 1;
        onLog(`⚠️ 搜索失败（跳过）：${keyword} 第 ${pageIndex + 1} 页 — ${e.message}`);
        continue;
      }
      stats.pagesFetched += 1;

      const blocked = detectBlockedPage(html);
      if (blocked) {
        stats.failed += 1;
        onLog(`⚠️ 搜索返回异常页（${blocked}）：${keyword} 第 ${pageIndex + 1} 页`);
        continue;
      }

      const results = parseSearchResults(html);
      stats.results += results.length;
      if (!results.length) onLog(`该页没解析到结果：${keyword} 第 ${pageIndex + 1} 页`);

      for (const item of results) {
        if (limit && rows.length >= limit) break;
        const { usable, truncated } = splitByShareCode(extractPanLinks(`${item.title}\n${item.snippet}`));
        stats.truncated += truncated;
        for (const { link, pwd } of usable) {
          if (seenLinks.has(link)) continue;
          seenLinks.add(link);
          rows.push({ name: item.title, link, pwd, questionUrl: item.questionUrl, source: `搜索:${keyword}` });
          stats.linked += 1;
        }
      }
      await sleep(pageDelayMs);
    }
    if (limit && rows.length >= limit) break;
  }

  if (stats.truncated) {
    onLog(`⚠️ 丢弃 ${stats.truncated} 条被摘要截断的残缺链接（分享码不足 ${MIN_SHARE_CODE} 位，转存必然失败）`);
  }
  if (!rows.length) {
    if (shouldStop && shouldStop()) return { rows, stats, stopped: true };
    throw new Error("这些关键词没有搜到带网盘链接的结果（可换关键词或增加页数）");
  }
  return { rows, stats };
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
  splitByShareCode,
  buildTopicSearchTerms,
  crawlSearchResources,
};
