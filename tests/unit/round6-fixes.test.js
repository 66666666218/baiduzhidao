"use strict";

/**
 * 本轮修复的回归测试，三件事：
 *   1) 上传只跑用户选中的账号（且同名写两遍不会被跑两遍）
 *   2) 转存并发永远不超过账号数（"一线程一账号"是能不能并发的前提）
 *   3) 采资源「目标条数 + 自动补足」的计划正确：逐级加码、无效轮不跑
 */

const test = require("node:test");
const assert = require("node:assert");

const { dedupeEnvLabels } = require("../../electron/src/domain/account-topic");
const { resolveTransferParallelism, MAX_TRANSFER_PARALLELISM } = require("../../electron/src/tasks/batch-transfer");
const { buildSupplementPlan, buildGenericTerms, dedupeTerms, diffTerms, mergeRows } = require("../../electron/src/tasks/search-resources");
const { crawlSearchResources } = require("../../electron/src/netdisk/search-crawler");

// ---------- 1) 上传账号 ----------

test("dedupeEnvLabels：同一个账号写两遍只留一个（否则那个号会被上传两遍）", () => {
  const { labels, duplicated } = dedupeEnvLabels(["账号2", "账号2"]);
  assert.deepEqual(labels, ["账号2"]);
  assert.deepEqual(duplicated, ["账号2"]);
});

test("dedupeEnvLabels：兼容 {label} 对象、 trim 与[{label}]混写", () => {
  const { labels } = dedupeEnvLabels([{ label: "账号1" }, " 账号1 ", { name: "账号2" }, ""]);
  assert.deepEqual(labels, ["账号1", "账号2"]);
});

test("dedupeEnvLabels：只选账号2 时就只有账号2（用户报的那个 bug 的断言）", () => {
  const { labels } = dedupeEnvLabels(["账号2"]);
  assert.deepEqual(labels, ["账号2"]);
  assert.ok(!labels.includes("账号1"));
});

test("dedupeEnvLabels：空输入返回空，不抛错", () => {
  assert.deepEqual(dedupeEnvLabels([]).labels, []);
  assert.deepEqual(dedupeEnvLabels(undefined).labels, []);
});

// ---------- 2) 转存并发 ----------

test("resolveTransferParallelism：线程数永远不超过账号数", () => {
  // 以前 cc=2 而 creds=1（或两个 worker 抢同一个 creds[0]）就是这条 100% 失败的形态
  assert.equal(resolveTransferParallelism({ requested: 4, creds: 1, autoParallel: 1 }), 1);
  assert.equal(resolveTransferParallelism({ requested: 8, creds: 2, autoParallel: 1 }), 2);
  assert.equal(resolveTransferParallelism({ requested: 99, creds: 3, autoParallel: 1 }), 3);
});

test("resolveTransferParallelism：未给并发时用自动判定值（配了不同代理才 >1）", () => {
  assert.equal(resolveTransferParallelism({ requested: 0, creds: 2, autoParallel: 2 }), 2);
  assert.equal(resolveTransferParallelism({ requested: undefined, creds: 2, autoParallel: 1 }), 1);
});

test("resolveTransferParallelism：自动判定值也不许超过账号数（否则又退化成同账号并发）", () => {
  assert.equal(resolveTransferParallelism({ requested: 0, creds: 1, autoParallel: 4 }), 1);
});

test("resolveTransferParallelism：脏数据不会搞出 0 或超大值", () => {
  assert.equal(resolveTransferParallelism({ requested: 0, creds: 0, autoParallel: 0 }), 1);
  assert.equal(resolveTransferParallelism({ requested: NaN, creds: NaN, autoParallel: NaN }), 1);
  assert.ok(resolveTransferParallelism({ requested: 999, creds: 999, autoParallel: 999 }) <= MAX_TRANSFER_PARALLELISM);
});

// ---------- 3) 采集补足计划 ----------

test("buildSupplementPlan：没有提升空间的轮次会被省掉（首轮页数已到顶就不用第二轮）", () => {
  const plan = buildSupplementPlan({
    basePages: 5, maxPages: 5, baseHomepages: 3, maxHomepages: 20, baseEnrich: 10, maxEnrich: 50, topics: ["影视"],
  });
  const labels = plan.map((s) => s.label);
  assert.deepEqual(labels[0], "首轮·按当前设置");
  assert.ok(!labels.includes("补足①·搜索多翻几页"), "页数已到顶，不该再排一轮翻页");
  assert.ok(labels.includes("补足②·多爬几个答主主页"), "主页还能加");
});

test("buildSupplementPlan：补足②不再重抓已经看过的页（pageStart 从 basePages 起）", () => {
  const plan = buildSupplementPlan({
    basePages: 2, maxPages: 8, baseHomepages: 3, maxHomepages: 20, baseEnrich: 10, maxEnrich: 50, topics: ["影视"],
  });
  const first = plan[0];
  const second = plan.find((s) => s.label.startsWith("补足①"));
  assert.equal(first.pageStart, 0, "首轮从头抓");
  assert.equal(second.pageStart, 2, "补足轮跳过已经抓过的前 2 页");
  assert.equal(second.pages, 8);
});

test("buildSupplementPlan：没绑题材时不会排「补泛化词」这一轮", () => {
  const plan = buildSupplementPlan({
    basePages: 1, maxPages: 5, baseHomepages: 3, maxHomepages: 9, baseEnrich: 10, maxEnrich: 30, topics: [],
  });
  assert.ok(!plan.some((s) => s.label.startsWith("补足③")));
});

test("buildGenericTerms：每个题材出「题材名」与「题材名 网盘」两个兜底词", () => {
  const terms = buildGenericTerms(["影视", "游戏"]);
  assert.deepEqual(terms.map((t) => t.term), ["影视", "影视 网盘", "游戏", "游戏 网盘"]);
  assert.deepEqual(buildGenericTerms([]), []);
});

test("dedupeTerms：同一搜索词多个题材都配了也只跑一遍", () => {
  const out = dedupeTerms([{ topic: "A", term: "x" }, { topic: "B", term: "x" }, { topic: "A", term: "y" }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((t) => t.term), ["x", "y"]);
});

test("diffTerms：新词要和已有词区分开，否则那一轮会一条都搜不到", () => {
  const base = [{ topic: "影视", term: "电影 网盘" }];
  assert.deepEqual(diffTerms([{ topic: "影视", term: "电影 网盘" }, { topic: "影视", term: "影视" }], base).map((t) => t.term), ["影视"]);
  assert.deepEqual(diffTerms([], base), []);
  assert.deepEqual(diffTerms([{ topic: "A", term: "x" }], undefined).map((t) => t.term), ["x"]);
});

test("mergeRows：按链接去重、保留先来先到，返回新增条数", () => {
  const target = [];
  const seen = new Set();
  assert.equal(mergeRows(target, seen, [{ link: "a" }, { link: "b" }]), 2);
  assert.equal(mergeRows(target, seen, [{ link: "b" }, { link: "c" }]), 1, "已采过的 b 不再计入");
  assert.deepEqual(target.map((r) => r.link), ["a", "b", "c"]);
  assert.equal(mergeRows(target, seen, [{ link: "" }]), 0, "没有链接的行不入库");
});

// ---------- 4) 采集：并发与 pageStart ----------

/** 造一个假搜索页：返回值里带**一条独一无二的链接**（不同词/不同页都不一样，方便断言去重与顺序） */
function fakePage(keyword, pageIndex) {
  const seed = Array.from(String(keyword)).reduce((s, c) => s + c.charCodeAt(0), 0) * 100 + Number(pageIndex);
  const code = `1abcdefghijklmnopqrstuvw${String(seed).padStart(5, "0")}`;
  return `<html><body>
    <dl class="dl"><a class="ti" href="/question/100">${keyword}#${pageIndex}</a>
      <dd class="dd answer">https://pan.baidu.com/s/${code}?pwd=abcd</dd></dl>
  </body></html>`;
}

test("crawlSearchResources：pageStart 让补足轮跳过已经抓过的页", async () => {
  const asked = [];
  const res = await crawlSearchResources({
    keywords: ["kw"], pages: 5, pageStart: 3, pageDelayMs: 0, fetchImpl: async (url) => {
      asked.push(url);
      return fakePage("kw", Number((url.match(/pn=(\d+)/) || [])[1]) / 10);
    },
  });
  // pn 偏移应是 30 与 40 两页，而不是 0~40
  assert.deepEqual(asked.map((u) => Number((u.match(/pn=(\d+)/) || [])[1])), [30, 40]);
  assert.equal(res.rows.length, 2);
});

test("crawlSearchResources：并发时输出顺序仍与耗时无关（否则两次跑出两张不同的表）", async () => {
  const run = (slowFirst) => crawlSearchResources({
    keywords: ["kwA", "kwB", "kwC"], pages: 1, concurrency: 3, pageDelayMs: 0,
    fetchImpl: async (url) => {
      const isFirst = url.includes("kwA");
      if (isFirst === slowFirst) await new Promise((r) => setTimeout(r, 20));
      const kw = (url.match(/word=([^&]+)/) || [])[1];
      return fakePage(decodeURIComponent(kw), 0);
    },
  });
  const fast = await run(true);   // kwA 慢
  const slow = await run(false);  // kwA 快
  assert.deepEqual(
    fast.rows.map((r) => r.source),
    slow.rows.map((r) => r.source),
    "两个词谁先返回，都不该改变输出顺序"
  );
  assert.equal(fast.rows.length, 3);
});

test("crawlSearchResources：撞到异常页时自动降级并继续跑完剩下的", async () => {
  let blockedServed = false;
  const logs = [];
  const rows = await crawlSearchResources({
    keywords: ["kwA", "kwB", "kwC"], pages: 1, concurrency: 3, pageDelayMs: 0,
    onLog: (m) => logs.push(m),
    fetchImpl: async (url) => {
      if (!blockedServed && url.includes("kwA")) { blockedServed = true; return "请输入验证码 captcha"; }
      const kw = (url.match(/word=([^&]+)/) || [])[1];
      return fakePage(decodeURIComponent(kw), 0);
    },
  }).then((r) => r.rows);
  assert.ok(blockedServed, "应该真的撞到了异常页");
  assert.ok(logs.some((l) => l.includes("自动把并发降到 1")), "降级要说得出来");
  assert.ok(rows.length >= 2, `降级后剩下的仍要跑完，实际 ${rows.length} 条`);
});

test("crawlSearchResources：limit 生效且不再多请求", async () => {
  let calls = 0;
  const res = await crawlSearchResources({
    keywords: ["kwA", "kwB"], pages: 3, limit: 1, pageDelayMs: 0, fetchImpl: async (url) => {
      calls += 1;
      const kw = (url.match(/word=([^&]+)/) || [])[1];
      return fakePage(decodeURIComponent(kw), 0);
    },
  });
  assert.equal(res.rows.length, 1);
  assert.ok(calls < 6, `到上限就该停，实际发了 ${calls} 次请求`);
});
