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

async function defaultFetch(url, { referer } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Referer": referer || `${PAN_HOST}/` },
      redirect: "follow",
      signal: AbortSignal.timeout(20000), // 无默认超时：单个请求挂起会卡死整个任务且无法停止
    });
  } catch (e) {
    // 超时的原生报错是 "The operation was aborted..."，用户看不懂
    if (e && (e.name === "TimeoutError" || /timeout|abort/i.test(e.message || ""))) {
      throw new Error("请求超时（20 秒无响应）");
    }
    throw e;
  }
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

/** 翻页聚合全部回答（终止：空页 / 取满 / 安全上限 / shouldStop；pn=偏移量，已实测确认） */
async function crawlHomeAnswers(uid, { onPage, shouldStop, pageSize = 20, maxPages = 100, fetchImpl = defaultFetch, pageDelayMs = 800, onLog = () => {} } = {}) {
  const all = [];
  let total = 0;
  let truncated = false;
  let partial = false;
  for (let pn = 0; pn < maxPages; pn += 1) {
    if (shouldStop && shouldStop()) break;
    let page;
    try {
      page = await fetchMyAnswerPage(uid, pn * pageSize, pageSize, fetchImpl);
    } catch (e) {
      // 翻页中途失败：保留已拉取的部分继续筛，不整主页作废（用户不知情的数据截断最危险）
      if (all.length) {
        partial = true;
        onLog(`⚠️ 翻页中断（已取 ${all.length}/${total || "?"} 条，按已取部分继续）：${e.message}`);
        break;
      }
      throw e; // 第一页就失败：没有任何部分成果，向上抛由调用方跳过该答主
    }
    const { list, listNum } = page;
    if (!total) total = listNum;
    if (!list.length) break;
    all.push(...list);
    onPage && onPage({ page: pn + 1, got: list.length, accumulated: all.length, total: listNum });
    if (all.length >= listNum) break;
    await sleep(pageDelayMs);
  }
  // 仅"达到安全上限仍有剩余"才标 truncated（停止/数据波动不算，避免日志文案误导）
  if (total && all.length < total && !(shouldStop && shouldStop())) truncated = true;
  return { items: all, total, truncated, partial };
}

/**
 * 识别"不是正常问答内容"的响应（错误提示页 / 验证页 / 空响应）。
 *
 * 为什么要有这个：百度出错或拦截时返回的是 HTTP 200 + 一张占位页，
 * 里面自然一个网盘链接也没有。extractPanLinks 于 是返回空数组——**和"这题真的没资源"
 * 完全无法区分**，调用方当成正常情况继续，通道失效了日志里还一个字都没有。
 *
 * 已知形态：「百度知道 - 信息提示」占位页（问题不存在/路径不对时返回的也是这个）、验证页。
 * 只认**确定**的异常特征，不做"必须包含某某结构"的正面校验——正面校验写错会把正常页面
 * 也判成异常，反而更糟。
 *
 * @returns {string} 异常原因；正常内容返回空串
 */
function detectBlockedPage(html) {
  const text = String(html || "");
  if (!text.trim()) return "空响应";
  if (/<title>\s*百度知道\s*[-–—]\s*信息提示\s*<\/title>/i.test(text)) return "「百度知道 - 信息提示」占位页";
  if (/wappass\.baidu\.com|verify\.baidu\.com|安全验证|请输入验证码/i.test(text)) return "风控/验证页";
  return "";
}

/**
 * 抽出一条回答的正文。
 * 接口把正文放在 contentList[段落][片段].value，段落/片段都是二维的，逐层取。
 */
function replyTextOf(reply) {
  const parts = [];
  for (const group of Array.isArray(reply && reply.contentList) ? reply.contentList : []) {
    for (const piece of Array.isArray(group) ? group : []) {
      if (piece && typeof piece.value === "string") parts.push(piece.value);
    }
  }
  return parts.join("\n");
}

/** 问题页（全文）兜底提取：摘要被截断时从完整回答正文找链接。
 *
 *  为什么走 JSON 接口、而不是抓问题页 HTML：
 *    1) 问题页现在是**客户端渲染**。裸请求 /question/hx/{qid} 只拿到 4.6KB 空壳
 *       （真浏览器渲染后是 1.38MB），HTML 里根本没有回答正文。
 *    2) 而且旧代码拼的是 /question/{qid}（不带 hx），对这些题是个 404 页——
 *       拿回来的是「百度知道 - 信息提示」，extractPanLinks 于 是返回空数组，
 *       调用方当成"这题没资源"，兜底通道**静默失效**了很多轮。
 *  接口实测**不需要登录 Cookie**，纯协议可用。
 */
async function fetchQuestionResources(qid, fetchImpl = defaultFetch) {
  const referer = `${PAN_HOST}/question/hx/${qid}`;
  // Referer 必须指向具体问题页：指向根路径时接口会返回 0 条回复（已实测）
  const url = `${PAN_HOST}/swan/ajax/replies?qid=${encodeURIComponent(qid)}&pn=0&rn=20&merge_newbest=1&evaluate=1&from_source=hx&platform=pc`;
  const body = await fetchImpl(url, { referer });

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    // 解析不了通常意味着被换成了 HTML（拦截页 / 改版），给出能定位的错误而不是空数组
    const blocked = detectBlockedPage(body);
    throw new Error(blocked
      ? `问题页接口返回的是拦截页（${blocked}）而不是 JSON，可能是风控或接口改版`
      : `问题页接口返回的不是 JSON（前 80 字：${String(body).slice(0, 80)}）`);
  }
  const replies = Array.isArray(json.replies) ? json.replies : [];
  if (!replies.length) return []; // 这题确实没有回答——与"被拦截"是两回事
  return extractPanLinks(replies.map(replyTextOf).join("\n"));
}

/**
 * 主入口：一批主页 → 资源表格行。
 * @returns {{rows:Array, stats:{answers:number, direct:number, enriched:number, failed:number}}}
 * rows: { name, link, pwd, questionUrl, source }
 */
async function crawlHomeResources({ homepages, limit = 0, enrichLimit = 50, onLog = () => {}, onPage, shouldStop, fetchImpl = defaultFetch, questionDelayMs = 1500 } = {}) {
  if (!Array.isArray(homepages) || !homepages.length) throw new Error("请填写至少一个答主主页地址");
  const rows = [];
  const seenLinks = new Set();          // 同一资源跨主页/跨问答只出一次
  const enrichedQuestions = new Set();  // 开过问题页的 qid（跨主页复用，避免重复开页）；不影响摘要直提
  const stats = { answers: 0, direct: 0, enriched: 0, failed: 0, enrichAttempted: 0, enrichEmpty: 0, enrichFailed: 0 };
  let enrichUsed = 0;

  for (const hp of homepages) {
    if (shouldStop && shouldStop()) break;
    let uid;
    try {
      uid = parseHomepage(hp);
    } catch (e) {
      stats.failed += 1;
      onLog(`⚠️ 跳过无效主页：${e.message}`);
      continue;
    }
    onLog(`拉取主页回答列表：uid=${uid}`);
    let answerBatch;
    try {
      answerBatch = await crawlHomeAnswers(uid, { onPage, shouldStop, fetchImpl, onLog });
    } catch (e) {
      // 单主页失败（网络/风控）只跳过该答主，不丢掉已爬主页的成果
      stats.failed += 1;
      onLog(`⚠️ 该主页拉取失败（跳过此答主，继续下一个）：${e.message}`);
      continue;
    }
    const { items, total, truncated, partial } = answerBatch;
    if (truncated) onLog(`⚠️ 该答主回答超过安全上限（${100 * 20} 条），只处理前 ${items.length} 条`);
    else if (partial) onLog(`该答主翻页中断，按已取得的 ${items.length} 条继续筛选`);
    onLog(`该答主共 ${total || items.length} 条回答，开始筛选资源型问答`);
    stats.answers += items.length;

    for (const item of items) {
      if (shouldStop && shouldStop()) break;
      if (limit && rows.length >= limit) break;
      const qid = String(item.qid || "");
      if (!qid) continue;
      if (Number(item.isDeleted) === 1) continue;

      const title = String(item.title || "").trim() || `问题${qid}`;
      // 第一优先：回答摘要里直接带链接（不做 qid 去重——不同答主答同一问题，
      // 摘要里可能是不同资源，跳过会漏）
      let links = extractPanLinks(item.replyContent);
      const fromSummary = links.length > 0;
      // 兜底：摘要被截断的疑似资源问答，开问题页全文提取（同一问题页只开一次）
      if (!links.length && looksResourceful(title) && enrichUsed < enrichLimit && !enrichedQuestions.has(qid)) {
        enrichedQuestions.add(qid);
        enrichUsed += 1;
        stats.enrichAttempted += 1;
        try {
          links = await fetchQuestionResources(qid, fetchImpl);
          if (links.length) stats.enriched += 1;
          else stats.enrichEmpty += 1; // 页面正常但这题确实没链接——与"被拦截"区分开
          await sleep(questionDelayMs);
        } catch (e) {
          stats.enrichFailed += 1;
          stats.failed += 1;
          onLog(`⚠️ 问题页打开失败（跳过）：${title} — ${e.message}`);
        }
      }
      for (const { link, pwd } of links) {
        if (limit && rows.length >= limit) break;
        if (seenLinks.has(link)) continue;
        seenLinks.add(link);
        rows.push({ name: title, link, pwd, questionUrl: `${PAN_HOST}/question/${qid}`, source: uid });
        if (fromSummary) stats.direct += 1;
      }
    }
    if (limit && rows.length >= limit) break;
  }

  // 兜底通道整体失效时必须说出来。这是最后一道防线：万一将来出现某种我没覆盖到的
  // 拦截页（detectBlockedPage 认不出来、静态返回空），"开了 N 次一条都没取到"这个
  // 统计仍然会露出来——本次结果其实只有回答摘要那半条腿在工作。
  if (stats.enrichAttempted >= 3 && stats.enriched === 0) {
    onLog(`⚠️ 问题页兜底开了 ${stats.enrichAttempted} 次，一条链接都没取到`
      + `（其中失败 ${stats.enrichFailed} 次、页面正常但无链接 ${stats.enrichEmpty} 次）。`
      + `这几乎必然是兜底通道失效，不是"这些题恰好都没资源"——本次产出只来自回答摘要。`);
  }

  if (!rows.length) {
    // 用户主动停止≠失败：正常收尾，不抛错误导为任务失败
    if (shouldStop && shouldStop()) {
      onLog("已按要求停止，未产出资源。");
      return { rows, stats, stopped: true };
    }
    throw new Error("这些主页里没有找到带百度网盘资源的问答（或都已被处理过）");
  }
  onLog(`筛选完成：浏览回答 ${stats.answers} 条，产出资源 ${rows.length} 条（摘要直提 ${stats.direct} 处、问题页兜底 ${stats.enriched} 次、失败跳过 ${stats.failed} 次）`);
  return { rows, stats, stopped: false };
}

module.exports = {
  parseHomepage,
  extractPanLinks,
  looksResourceful,
  fetchMyAnswerPage,
  crawlHomeAnswers,
  fetchQuestionResources,
  detectBlockedPage,
  replyTextOf,
  crawlHomeResources,
};
