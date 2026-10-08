"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
  buildSearchUrl,
  cleanText,
  normalizeQuestionUrl,
  parseSearchResults,
  splitByShareCode,
  crawlSearchResources,
} = require("../../electron/src/netdisk/search-crawler");
const { extractPanLinks } = require("../../electron/src/netdisk/home-crawler");

// 真实抓下来的搜索结果页（关键词「流浪地球 网盘」），不是合成 HTML——
// 上一轮「问题页兜底」正是因为测试用合成 HTML，才让通道静默失效一路绿着进了生产。
const SEARCH_PAGE = fs.readFileSync(path.join(__dirname, "..", "fixtures", "search-result-page.html"), "utf8");

test("parseSearchResults：从真实搜索页解析出结果条目", () => {
  const results = parseSearchResults(SEARCH_PAGE);
  assert.ok(results.length >= 8, `应解析出多条结果，实际 ${results.length}`);
  for (const r of results) {
    assert.match(r.questionUrl, /^https:\/\/zhidao\.baidu\.com\/question\/\d+/, "问题链接已归一化");
    assert.ok(r.title.length > 0, "标题非空");
    assert.doesNotMatch(r.title, /<|>/, "标题里的高亮标签已剥掉");
  }
});

test("parseSearchResults：真实页面里能提出带提取码的网盘链接", () => {
  const results = parseSearchResults(SEARCH_PAGE);
  const links = results.flatMap((r) => extractPanLinks(`${r.title}\n${r.snippet}`));
  assert.ok(links.length >= 5, `应提到多条网盘链接，实际 ${links.length}`);
  assert.ok(links.some((l) => l.pwd), "至少有一条带提取码");
  for (const l of links) assert.match(l.link, /^https:\/\/pan\.baidu\.com\/s\//);
});

test("normalizeQuestionUrl：去掉查询串、统一 https", () => {
  assert.equal(
    normalizeQuestionUrl("http://zhidao.baidu.com/question/406015899790834405.html?fr=iks&word=xxx"),
    "https://zhidao.baidu.com/question/406015899790834405.html"
  );
  assert.equal(normalizeQuestionUrl("没有链接"), "");
});

test("cleanText：去标签、还原实体、压平空白", () => {
  assert.equal(cleanText("<em>流浪地球</em>&nbsp;2&nbsp;&amp;&nbsp;3"), "流浪地球 2 & 3");
});

test("buildSearchUrl：分页用 pn 偏移，每页 10 条", () => {
  assert.match(buildSearchUrl("流浪地球 网盘", 0), /pn=0$/);
  assert.match(buildSearchUrl("流浪地球 网盘", 2), /pn=20$/);
  assert.match(buildSearchUrl("流浪地球 网盘", 0), /word=%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83%20%E7%BD%91%E7%9B%98/);
});

test("splitByShareCode：截断的残码被丢弃并计数", () => {
  const { usable, truncated } = splitByShareCode([
    { link: "https://pan.baidu.com/s/14LKDuGld9hYhY9qqKwjO-Q", pwd: "bv54" }, // 23 位，正常
    { link: "https://pan.baidu.com/s/1U237Pl", pwd: "" },                     // 7 位，被截断
  ]);
  assert.equal(usable.length, 1);
  assert.equal(truncated, 1);
});

test("crawlSearchResources：端到端（stub 返回真实页面），链接去重", async () => {
  const logs = [];
  const r = await crawlSearchResources({
    keywords: ["流浪地球 网盘", "流浪地球 网盘"], // 同一关键词两次，验证跨关键词去重
    pages: 1,
    fetchImpl: async () => SEARCH_PAGE,
    pageDelayMs: 0,
    onLog: (m) => logs.push(m),
  });
  assert.ok(r.rows.length > 0, "有产出");
  const links = r.rows.map((x) => x.link);
  assert.equal(new Set(links).size, links.length, "链接不重复");
  assert.equal(r.stats.keywords, 2);
  assert.equal(r.stats.pagesFetched, 2);
  assert.ok(r.rows.every((x) => x.source.startsWith("搜索:")));
  assert.ok(r.rows.every((x) => x.questionUrl.includes("/question/")));
});

test("crawlSearchResources：搜索结果页是异常页时报失败，不静默产出", async () => {
  const logs = [];
  const blocked = fs.readFileSync(path.join(__dirname, "..", "fixtures", "blocked-question-page.html"), "utf8");
  await assert.rejects(
    () => crawlSearchResources({ keywords: ["随便"], fetchImpl: async () => blocked, pageDelayMs: 0, onLog: (m) => logs.push(m) }),
    /没有搜到/,
    "异常页 → 无产出 → 明确报错"
  );
  assert.match(logs.join("\n"), /异常页/, "要说清是异常页而不是『没搜到』");
});

test("crawlSearchResources：关键词为空直接抛错", async () => {
  await assert.rejects(() => crawlSearchResources({ keywords: [] }), /至少一个搜索关键词/);
  await assert.rejects(() => crawlSearchResources({}), /至少一个搜索关键词/);
});

test("crawlSearchResources：单页失败不拖垮其他关键词", async () => {
  const logs = [];
  let call = 0;
  const r = await crawlSearchResources({
    keywords: ["关键词A", "关键词B"],
    fetchImpl: async () => {
      call += 1;
      if (call === 1) throw new Error("网络超时");
      return SEARCH_PAGE;
    },
    pageDelayMs: 0,
    onLog: (m) => logs.push(m),
  });
  assert.ok(r.rows.length > 0, "第二个关键词仍然产出");
  assert.equal(r.stats.failed, 1);
  assert.match(logs.join("\n"), /搜索失败（跳过）/);
});

// ---------- 按账号题材生成搜索词 ----------

const { buildTopicSearchTerms, DEFAULT_SEARCH_KEYWORDS } = require("../../electron/src/netdisk/search-crawler");

test("buildTopicSearchTerms：按题材取搜索词，保持规则顺序", () => {
  const { terms } = buildTopicSearchTerms(["影视"], "影视=电影 网盘|电视剧 网盘");
  assert.deepEqual(terms, [
    { topic: "影视", term: "电影 网盘" },
    { topic: "影视", term: "电视剧 网盘" },
  ]);
});

test("buildTopicSearchTerms：同题材多账号只出一份（结果本就一样，重复搜是白费请求）", () => {
  const { terms } = buildTopicSearchTerms(["影视", "影视", "影视"], "影视=电影 网盘");
  assert.equal(terms.length, 1, "三个账号绑同一题材 → 只搜一次");
});

test("buildTopicSearchTerms：不同题材各自出词，跨题材也不重复", () => {
  const { terms } = buildTopicSearchTerms(["影视", "游戏"], "影视=电影 网盘\n游戏=电影 网盘|手游 网盘");
  const list = terms.map((t) => t.term);
  assert.deepEqual(list, ["电影 网盘", "手游 网盘"], "同名词跨题材只搜一次");
});

test("buildTopicSearchTerms：没配搜索词的题材要回报出来，不硬凑", () => {
  const { terms, uncovered } = buildTopicSearchTerms(["影视", "小说"], "影视=电影 网盘");
  assert.deepEqual(uncovered, ["小说"]);
  assert.equal(terms.length, 1);
});

test("buildTopicSearchTerms：空输入/空规则不炸", () => {
  assert.deepEqual(buildTopicSearchTerms([], "").terms, []);
  assert.deepEqual(buildTopicSearchTerms(null, null).terms, []);
  assert.deepEqual(buildTopicSearchTerms(["影视"], "").uncovered, ["影视"]);
});

test("DEFAULT_SEARCH_KEYWORDS：能解析出多个题材，格式与分类规则一致", () => {
  const { parseTopicRules } = require("../../electron/src/domain/topic-rules");
  const rules = parseTopicRules(DEFAULT_SEARCH_KEYWORDS);
  assert.ok(rules.length >= 6, `默认搜索词应覆盖多个题材，实际 ${rules.length}`);
  assert.ok(rules.every((r) => r.keywords.length >= 2), "每个题材至少两个搜索词");
  assert.ok(rules.every((r) => r.keywords.every((k) => /网盘|资源/.test(k))), "默认词应指向网盘资源");
});
