"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  parseHomepage,
  extractPanLinks,
  looksResourceful,
  crawlHomeAnswers,
  crawlHomeResources,
} = require("../../electron/src/netdisk/home-crawler");

// ---------- parseHomepage ----------

test("主页解析：usercenter 完整链接 / 裸 uid / 非法输入", () => {
  assert.equal(parseHomepage("https://zhidao.baidu.com/usercenter?uid=2e374069236f25705e79900e&role=ugc"), "2e374069236f25705e79900e");
  assert.equal(parseHomepage("2e374069236f25705e79900e"), "2e374069236f25705e79900e");
  assert.throws(() => parseHomepage(""), /请填写/);
  assert.throws(() => parseHomepage("https://example.com/a"), /无法识别/);
});

// ---------- extractPanLinks ----------

test("链接提取：pwd= 形态、提取码：形态、无提取码、重复链接去重", () => {
  const r1 = extractPanLinks("链接：https://pan.baidu.com/s/1uY9iRAXSwjf6flf1oDluXg?pwd=2026 提取: 2026");
  assert.equal(r1.length, 1);
  assert.equal(r1[0].link, "https://pan.baidu.com/s/1uY9iRAXSwjf6flf1oDluXg");
  assert.equal(r1[0].pwd, "2026");

  const r2 = extractPanLinks("pan.baidu.com/s/1gC1OgIyKkveGDZzi72ND_g 提取码：p666");
  assert.equal(r2[0].pwd, "p666");

  const r3 = extractPanLinks("pan.baidu.com/s/abcdefghijk 没有提取码");
  assert.equal(r3.length, 1);
  assert.equal(r3[0].pwd, "");

  const r4 = extractPanLinks("pan.baidu.com/s/aaa111 pan.baidu.com/s/aaa111 两个相同");
  assert.equal(r4.length, 1);
});

// ---------- looksResourceful ----------

test("资源型标题判断", () => {
  assert.ok(looksResourceful("求《XX电影》4K资源"));
  assert.ok(looksResourceful("有没有热播剧全集分享"));
  assert.ok(!looksResourceful("如何安慰心情不好的人"));
});

// ---------- crawlHomeAnswers 翻页 ----------

function makeApiFetch(pages, log = []) {
  return async (url) => {
    log.push(url);
    const pn = Number(new URL(url).searchParams.get("pn"));
    const page = pages[pn / 20] || { list: [], listNum: 0 };
    return JSON.stringify({ errno: 0, data: { question: { list: page.list, listNum: page.listNum } } });
  };
}

test("翻页聚合：取满 listNum 即停；shouldStop 可中止", async () => {
  const pages = [
    { list: [{ qid: "1" }, { qid: "2" }], listNum: 3 },
    { list: [{ qid: "3" }], listNum: 3 },
  ];
  const { items, total } = await crawlHomeAnswers("uid123", { fetchImpl: makeApiFetch(pages), pageDelayMs: 0 });
  assert.equal(total, 3);
  assert.deepEqual(items.map((x) => x.qid), ["1", "2", "3"]);

  const { items: stopped } = await crawlHomeAnswers("uid123", { fetchImpl: makeApiFetch(pages), pageDelayMs: 0, shouldStop: () => true });
  assert.equal(stopped.length, 0, "shouldStop 立即为真时一页都不拉");
});

// ---------- crawlHomeResources 端到端 ----------

function makeE2EFetch({ apiPages, questionHtml }) {
  return async (url) => {
    if (url.includes("/ihome/api/myanswer")) {
      const pn = Number(new URL(url).searchParams.get("pn"));
      const page = apiPages[pn / 20] || { list: [], listNum: 0 };
      return JSON.stringify({ errno: 0, data: { question: { list: page.list, listNum: page.listNum } } });
    }
    const qid = url.match(/question\/(\d+)/)[1];
    return questionHtml[qid] || "<html></html>";
  };
}

test("端到端：摘要直提 + 问题页兜底 + 跨问答链接去重 + 删除题跳过", async () => {
  const apiPages = [{
    listNum: 4,
    list: [
      { qid: "111", title: "求资源A", replyContent: "链接 pan.baidu.com/s/directA1 提取码：ab12", isDeleted: 0 },
      { qid: "222", title: "求资源B全集", replyContent: "资源已失效…" , isDeleted: 0 },
      { qid: "333", title: "如何安慰", replyContent: "纯情感回答没有链接", isDeleted: 0 },
      { qid: "444", title: "已删除的资源题", replyContent: "pan.baidu.com/s/deletedX", isDeleted: 1 },
    ],
  }];
  const questionHtml = {
    // 资源B：摘要没链接 → 问题页兜底；与 111 的资源不同
    "222": "<div>pan.baidu.com/s/fullB2 提取码：cd34</div>",
  };
  const { rows, stats } = await crawlHomeResources({
    homepages: ["https://zhidao.baidu.com/usercenter?uid=abcdef0123456789"],
    fetchImpl: makeE2EFetch({ apiPages, questionHtml }),
    questionDelayMs: 0,
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.link), ["https://pan.baidu.com/s/directA1", "https://pan.baidu.com/s/fullB2"]);
  assert.equal(rows[0].pwd, "ab12");
  assert.equal(rows[1].pwd, "cd34");
  assert.ok(rows[0].questionUrl.includes("/question/111"));
  assert.equal(stats.enriched, 1, "资源B 走了问题页兜底");
  assert.ok(stats.direct >= 1, "资源A 摘要直提");
});

test("端到端：同资源跨问答/跨主页只出一次；全部无资源时报错", async () => {
  const apiPages = [{
    listNum: 2,
    list: [
      { qid: "111", title: "求资源A", replyContent: "pan.baidu.com/s/sameLink", isDeleted: 0 },
      { qid: "555", title: "求资源A复制版", replyContent: "pan.baidu.com/s/sameLink", isDeleted: 0 },
    ],
  }];
  const r1 = await crawlHomeResources({
    homepages: ["abcdef0123456789"],
    fetchImpl: makeE2EFetch({ apiPages, questionHtml: {} }),
    questionDelayMs: 0,
  });
  assert.equal(r1.rows.length, 1, "同一链接只出一次");

  const noResource = { listNum: 1, list: [{ qid: "999", title: "如何安慰", replyContent: "没有链接", isDeleted: 0 }] };
  await assert.rejects(
    () => crawlHomeResources({ homepages: ["abcdef0123456789"], fetchImpl: makeE2EFetch({ apiPages: [noResource], questionHtml: {} }), questionDelayMs: 0 }),
    /没有找到/
  );
});

// ---------- 审查修复回归（2026-10-01） ----------

test("enrichLimit=0 时不开问题页兜底（UI 承诺 0=不兜底）", async () => {
  const apiPages = [{ listNum: 1, list: [{ qid: "222", title: "求资源B全集", replyContent: "摘要没链接", isDeleted: 0 }] }];
  let questionPageOpened = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/question/")) { questionPageOpened += 1; return "<div>pan.baidu.com/s/fullB2</div>"; }
    return JSON.stringify({ errno: 0, data: { question: apiPages[0] } });
  };
  // 摘要无链接+不兜底 → 无产出报"没有找到"；关键断言是问题页一次都没开
  await assert.rejects(
    () => crawlHomeResources({ homepages: ["abcdef0123456789"], enrichLimit: 0, fetchImpl, questionDelayMs: 0 }),
    /没有找到/
  );
  assert.equal(questionPageOpened, 0, "不兜底：问题页一次都不开");
});

test("同一问题被多个答主回答：各自的摘要链接都不丢（qid 去重不挡摘要直提）", async () => {
  const pageOf = (qid, link) => ({ listNum: 1, list: [{ qid, title: "求资源X", replyContent: `pan.baidu.com/s/${link}`, isDeleted: 0 }] });
  const fetchImpl = async (url) => {
    const uid = new URL(url).searchParams.get("uid");
    return JSON.stringify({ errno: 0, data: { question: uid === "aaaa0000bbbb1111" ? pageOf("777", "fromA") : pageOf("777", "fromB") } });
  };
  const { rows } = await crawlHomeResources({
    homepages: ["aaaa0000bbbb1111", "cccc0000dddd2222"],
    fetchImpl, questionDelayMs: 0,
  });
  assert.deepEqual(rows.map((r) => r.link), ["https://pan.baidu.com/s/fromA", "https://pan.baidu.com/s/fromB"], "两个答主对同一问题的不同资源都要保留");
});

test("单个主页接口失败只跳过该答主，其余主页照常产出", async () => {
  const okPages = { listNum: 1, list: [{ qid: "888", title: "求资源OK", replyContent: "pan.baidu.com/s/okLink", isDeleted: 0 }] };
  const fetchImpl = async (url) => {
    const uid = new URL(url).searchParams.get("uid");
    if (uid === "badbad0000badbad1") throw new Error("模拟风控");
    return JSON.stringify({ errno: 0, data: { question: okPages } });
  };
  const { rows, stats } = await crawlHomeResources({
    homepages: ["badbad0000badbad1", "feed0000face0001"],
    fetchImpl, questionDelayMs: 0,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].link, "https://pan.baidu.com/s/okLink");
  assert.equal(stats.failed, 1, "失败主页计入 failed");
});

test("用户主动停止且无产出时返回 stopped 标记，不抛错", async () => {
  const apiPages = { listNum: 1, list: [{ qid: "999", title: "如何安慰", replyContent: "没有链接", isDeleted: 0 }] };
  const result = await crawlHomeResources({
    homepages: ["abcdef0123456789"],
    fetchImpl: makeE2EFetch({ apiPages: [apiPages], questionHtml: {} }),
    questionDelayMs: 0,
    shouldStop: () => true,
  });
  assert.equal(result.stopped, true);
  assert.equal(result.rows.length, 0);
});

test("翻页截断标记：总数超安全上限时 truncated=true", async () => {
  const bigPage = { listNum: 3000, list: Array.from({ length: 20 }, (_v, i) => ({ qid: String(i) })) };
  const { truncated, items } = await crawlHomeAnswers("abcdef0123456789", {
    fetchImpl: makeApiFetch([bigPage, bigPage, bigPage]), pageDelayMs: 0, maxPages: 3,
  });
  assert.equal(truncated, true);
  assert.equal(items.length, 60);
});
