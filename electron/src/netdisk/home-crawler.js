"use strict";

/**
 * 答主主页资源爬取器（纯协议 · 无浏览器）。
 *
 * 流程：答主主页 URL → 解析 uid → ihome/api/myanswer 分页拉回答列表
 *      → 摘要直提网盘链接 → 疑似资源问答再开问题页全文兜底
 *      → 产出「资源名/链接/提取码/问题链接」表格行，直接喂批量转存。
 *
 * 只取资源链接与问题地址，回答正文一律不落盘不复用（平台"搬运/洗稿"封号红线）。
 */

const PAN_HOST = "https://zhidao.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 主页 URL / 裸 uid → uid（支持 usercenter 完整链接、?uid= 参数、纯 hex uid） */
function parseHomepage(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("请填写答主主页地址");
  const m = s.match(/uid=([0-9a-f]{8,40})/i) || s.match(/^([0-9a-f]{16,40})$/i);
  if (!m) throw new Error(`无法识别主页地址（需 usercenter 链接或 uid）：${s.slice(0, 80)}`);
  return m[1].toLowerCase();
}

/** 从任意文本提取百度网盘分享链接与提取码 */
function extractPanLinks(text) {
  const s = String(text || "");
  const links = [];
  const seen = new Set();
  const re = /pan\.baidu\.com\/s\/([0-9a-zA-Z_-]{5,})/g;
  let m;
  while ((m = re.exec(s))) {
    const url = `https://pan.baidu.com/s/${m[1]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    // 在链接附近 120 字符窗口内找提取码（pwd=xxxx / 提取码：xxxx / 密码 xxxx）
    const around = s.slice(Math.max(0, m.index - 60), m.index + m[0].length + 120);
    const pwd = (around.match(/pwd[=:：\s]*([0-9a-zA-Z]{4})/i) || around.match(/(?:提取码|密码|访问码)[:：\s]*([0-9a-zA-Z]{4})/i) || [])[1] || "";
    links.push({ link: url, pwd });
  }
  return links;
}

/** 标题是否疑似资源型问答（决定要不要开问题页兜底） */
function looksResourceful(title) {
  return /求|资源|分享|网盘|链接|电影|电视剧|动漫|综艺|音乐|剧集|纪录片|4k|1080|全集|高清|夸克|阿里云盘/i.test(String(title || ""));
}

async function defaultFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Referer": `${PAN_HOST}/` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url.slice(0, 100)}`);
  return res.text();
}

/** myanswer 分页：单页（免登录已验证；rn 单页条数） */
async function fetchMyAnswerPage(uid, pn, rn, fetchImpl) {
  const url = `${PAN_HOST}/ihome/api/myanswer?pn=${pn}&rn=${rn}&t=${Date.now()}&uid=${uid}&type=default`;
  const body = await fetchImpl(url);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error("主页接口返回非 JSON（可能触发风控，请稍后再试）"); }
  if (json.errno !== 0) throw new Error(`主页接口 errno=${json.errno}`);
  const q = (json.data && json.data.question) || {};
  return { list: Array.isArray(q.list) ? q.list : [], listNum: Number(q.listNum) || 0 };
}

/** 翻页聚合全部回答（终止：空页 / 取满 / 安全上限 / shouldStop） */
async function crawlHomeAnswers(uid, { onPage, shouldStop, pageSize = 20, maxPages = 100, fetchImpl = defaultFetch, pageDelayMs = 800 } = {}) {
  const all = [];
  let total = 0;
  for (let pn = 0; pn < maxPages; pn += 1) {
    if (shouldStop && shouldStop()) break;
    const { list, listNum } = await fetchMyAnswerPage(uid, pn * pageSize, pageSize, fetchImpl);
    if (!total) total = listNum;
    if (!list.length) break;
    all.push(...list);
    onPage && onPage({ page: pn + 1, got: list.length, accumulated: all.length, total: listNum });
    if (all.length >= listNum) break;
    await sleep(pageDelayMs);
  }
  return { items: all, total };
}

/** 问题页（SSR）全文兜底提取：摘要被截断时从完整回答正文找链接 */
async function fetchQuestionResources(qid, fetchImpl = defaultFetch) {
  const html = await fetchImpl(`${PAN_HOST}/question/${qid}`);
  return extractPanLinks(html);
}

/**
 * 主入口：一批主页 → 资源表格行。
 * @returns {{rows:Array, stats:{answers:number, direct:number, enriched:number, failed:number}}}
 * rows: { name, link, pwd, questionUrl, source }
 */
async function crawlHomeResources({ homepages, limit = 0, enrichLimit = 50, onLog = () => {}, onPage, shouldStop, fetchImpl = defaultFetch, questionDelayMs = 1500 } = {}) {
  if (!Array.isArray(homepages) || !homepages.length) throw new Error("请填写至少一个答主主页地址");
  const rows = [];
  const seenLinks = new Set();   // 同一资源跨主页/跨问答只出一次
  const seenAnswers = new Set(); // 同一问题（同人重复出现）只处理一次
  const stats = { answers: 0, direct: 0, enriched: 0, failed: 0 };
  let enrichUsed = 0;

  for (const hp of homepages) {
    if (shouldStop && shouldStop()) break;
    const uid = parseHomepage(hp);
    onLog(`拉取主页回答列表：uid=${uid}`);
    const { items, total } = await crawlHomeAnswers(uid, { onPage, shouldStop, fetchImpl });
    onLog(`该答主共 ${total || items.length} 条回答，开始筛选资源型问答`);
    stats.answers += items.length;

    for (const item of items) {
      if (shouldStop && shouldStop()) break;
      if (limit && rows.length >= limit) break;
      const qid = String(item.qid || "");
      if (!qid || seenAnswers.has(qid)) continue;
      seenAnswers.add(qid);
      if (Number(item.isDeleted) === 1) continue;

      const title = String(item.title || "").trim() || `问题${qid}`;
      // 第一优先：回答摘要里直接带链接
      let links = extractPanLinks(item.replyContent);
      const fromSummary = links.length > 0;
      // 兜底：摘要被截断的疑似资源问答，开问题页全文提取
      if (!links.length && looksResourceful(title) && enrichUsed < enrichLimit) {
        enrichUsed += 1;
        try {
          links = await fetchQuestionResources(qid, fetchImpl);
          if (links.length) stats.enriched += 1;
          await sleep(questionDelayMs);
        } catch (e) {
          stats.failed += 1;
          onLog(`⚠️ 问题页打开失败（跳过）：${title} — ${e.message}`);
        }
      }
      for (const { link, pwd } of links) {
        if (seenLinks.has(link)) continue;
        seenLinks.add(link);
        rows.push({ name: title, link, pwd, questionUrl: `${PAN_HOST}/question/${qid}`, source: uid });
        if (fromSummary) stats.direct += 1;
      }
    }
    if (limit && rows.length >= limit) break;
  }

  if (!rows.length) throw new Error("这些主页里没有找到带百度网盘资源的问答（或都已被处理过）");
  onLog(`筛选完成：浏览回答 ${stats.answers} 条，产出资源 ${rows.length} 条（摘要直提 ${stats.direct} 处、问题页兜底 ${stats.enriched} 次）`);
  return { rows, stats };
}

module.exports = {
  parseHomepage,
  extractPanLinks,
  looksResourceful,
  fetchMyAnswerPage,
  crawlHomeAnswers,
  fetchQuestionResources,
  crawlHomeResources,
};
