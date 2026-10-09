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
    // 问题页兜底现在走 JSON 接口（swan/ajax/replies）：把 fixture 里的纯文本塞进 contentList。
    // 以前这里返回 HTML——正说明旧测试是从"抓页面 HTML"那个已失效的实现倒推出来的。
    const qid = new URL(url).searchParams.get("qid");
    const text = questionHtml[qid];
    return JSON.stringify({ errno: 0, replies: text ? [{ contentList: [[{ value: text }]] }] : [] });
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

// ---------- 二轮审查回归（2026-10-01） ----------

test("翻页中途失败：保留已拉取部分继续（partial=true），第一页失败才向上抛", async () => {
  const p1 = { listNum: 60, list: Array.from({ length: 20 }, (_v, i) => ({ qid: `a${i}` })) };
  let calls = 0;
  const flakyFetch = async (url) => {
    calls += 1;
    if (calls === 1) return JSON.stringify({ errno: 0, data: { question: p1 } });
    throw new Error("模拟中途网络断开");
  };
  const logs = [];
  const r1 = await crawlHomeAnswers("abcdef0123456789", { fetchImpl: flakyFetch, pageDelayMs: 0, onLog: (m) => logs.push(m) });
  assert.equal(r1.partial, true);
  assert.equal(r1.items.length, 20, "中断后保留第一页成果");
  assert.ok(logs.some((m) => m.includes("翻页中断")), "中断要写日志");

  const alwaysFail = async () => { throw new Error("首页即失败"); };
  await assert.rejects(
    () => crawlHomeAnswers("abcdef0123456789", { fetchImpl: alwaysFail, pageDelayMs: 0 }),
    /首页即失败/
  );
});

test("shouldStop 中断不算 truncated（截断特指达安全上限）", async () => {
  const page = { listNum: 100, list: Array.from({ length: 20 }, (_v, i) => ({ qid: String(i) })) };
  const { truncated } = await crawlHomeAnswers("abcdef0123456789", {
    fetchImpl: makeApiFetch([page, page, page]), pageDelayMs: 0, shouldStop: () => true,
  });
  assert.equal(truncated, false);
});

// ---------- 问题页被拦截的识别（回归：这条通道曾静默失效） ----------
//
// 背景：百度拦截时返回 HTTP 200 + 「百度知道 - 信息提示」占位页，里面自然没有链接。
// 旧代码把它当成"这题没资源"继续跑，兜底通道整条失效而日志里一个字都没有。
// 下面用的 fixture 是**真实抓下来的拦截页**，不是手写的合成 HTML——
// 原测试正是因为用合成 HTML，才让这个 bug 一路绿着进了生产。

const fs = require("fs");
const path = require("path");
const { fetchQuestionResources, detectBlockedPage, replyTextOf } = require("../../electron/src/netdisk/home-crawler");

const BLOCKED_PAGE = fs.readFileSync(path.join(__dirname, "..", "fixtures", "blocked-question-page.html"), "utf8");

test("detectBlockedPage：认出真实拦截页（信息提示占位页）", () => {
  assert.match(BLOCKED_PAGE, /百度知道 - 信息提示/, "fixture 应该是真实的拦截页");
  assert.notEqual(detectBlockedPage(BLOCKED_PAGE), "", "必须识别为异常页，不能返回空串");
});

test("detectBlockedPage：正常问题页不误判", () => {
  const normal = "<html><head><title>如何安慰失恋的朋友_百度知道</title></head><body><div class=\"question-content\">…</div></body></html>";
  assert.equal(detectBlockedPage(normal), "");
});

test("detectBlockedPage：空响应单独识别", () => {
  assert.equal(detectBlockedPage(""), "空响应");
  assert.equal(detectBlockedPage("   "), "空响应");
  assert.equal(detectBlockedPage(null), "空响应");
});

test("fetchQuestionResources：接口返回拦截页时必须抛错，不能静默返回空数组", async () => {
  const fetchImpl = async () => BLOCKED_PAGE;
  await assert.rejects(
    () => fetchQuestionResources("2988409911", fetchImpl),
    /拦截页/,
    "拦截时抛错——旧行为是返回 []，调用方误判为『这题没资源』"
  );
});

test("replyTextOf：从 contentList 二维结构里取出回答正文", () => {
  const reply = { contentList: [[{ ctype: 1, value: "第一段" }], [{ ctype: 1, value: "第二段" }]] };
  assert.equal(replyTextOf(reply), "第一段\n第二段");
  assert.equal(replyTextOf({}), "");
  assert.equal(replyTextOf(null), "");
});

test("fetchQuestionResources：接口正常返回时提取链接", async () => {
  const fetchImpl = async () => JSON.stringify({
    errno: 0,
    replies: [{ contentList: [[{ value: "资源在这 pan.baidu.com/s/okLink 提取码：ab12" }]] }],
  });
  const links = await fetchQuestionResources("111", fetchImpl);
  assert.equal(links.length, 1);
});

test("fetchQuestionResources：接口正常但没有回答时返回空数组（不是错误）", async () => {
  const fetchImpl = async () => JSON.stringify({ errno: 0, replies: [] });
  assert.deepEqual(await fetchQuestionResources("111", fetchImpl), []);
});

test("fetchQuestionResources：Referer 必须指向具体问题页", async () => {
  // 指向根路径时接口返回 0 条回复（已实测），这个参数不能省
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = opts; return JSON.stringify({ replies: [] }); };
  await fetchQuestionResources("2988409911", fetchImpl);
  assert.match(seen.referer, /\/question\/hx\/2988409911$/);
});

test("兜底全被拦截时：计入 enrichFailed、写日志、并给出通道失效告警", async () => {
  const logs = [];
  const apiPage = {
    listNum: 3,
    list: [
      { qid: "1", title: "求资源A", replyContent: "摘要没有链接", isDeleted: 0 },
      { qid: "2", title: "求资源B", replyContent: "摘要没有链接", isDeleted: 0 },
      { qid: "3", title: "求资源C", replyContent: "摘要没有链接", isDeleted: 0 },
    ],
  };
  const fetchImpl = async (url) => (url.includes("/swan/ajax/replies") ? BLOCKED_PAGE : JSON.stringify({ errno: 0, data: { question: apiPage } }));

  await assert.rejects(
    () => crawlHomeResources({ homepages: ["abcdef0123456789"], fetchImpl, questionDelayMs: 0, onLog: (m) => logs.push(m) }),
    /没有找到/,
    "三条全被拦截 → 无产出，报『没有找到』"
  );

  const joined = logs.join("\n");
  assert.match(joined, /问题页打开失败/, "每次拦截都要有失败日志，不再静默");
  assert.match(joined, /一条链接都没取到/, "必须发出通道整体失效的告警");
  assert.match(joined, /只来自回答摘要/, "告警要说清楚产出只有半条腿在工作");
});

test("兜底有效时不误报告警", async () => {
  const logs = [];
  const apiPage = {
    listNum: 3,
    list: [
      { qid: "1", title: "求资源A", replyContent: "摘要没有链接", isDeleted: 0 },
      { qid: "2", title: "求资源B", replyContent: "摘要没有链接", isDeleted: 0 },
      { qid: "3", title: "求资源C", replyContent: "摘要没有链接", isDeleted: 0 },
    ],
  };
  const fetchImpl = async (url) => (url.includes("/swan/ajax/replies")
    ? JSON.stringify({ errno: 0, replies: [{ contentList: [[{ value: "资源在这 pan.baidu.com/s/full1 提取码：aa11" }]] }] })
    : JSON.stringify({ errno: 0, data: { question: apiPage } }));

  const r = await crawlHomeResources({ homepages: ["abcdef0123456789"], fetchImpl, questionDelayMs: 0, onLog: (m) => logs.push(m) });
  assert.ok(r.rows.length > 0, "兜底取到了链接");
  assert.doesNotMatch(logs.join("\n"), /一条链接都没取到/, "正常工作不能误报告警");
});

// ---------- 提取码解析：窗口太窄会**静默丢码**（2026-10-10 真机现场） ----------

test("提取码：写在链接后面较远处也要能抓到", () => {
  // 真机现场：搜到的 10 条里有 1 条提取码为空，而那是一条**确实需要提取码**的分享
  //（抓页面确认过标题就是"请输入提取码"）—— 这一行注定转存失败，且当时毫无提示。
  // 原因是解析窗口只有「链接后 120 字符」，答主把码写在 150 字符后就丢了。
  const far = `链接：https://pan.baidu.com/s/1abcdefghij${" ".repeat(150)}提取码：ab12`;
  const r = extractPanLinks(far);
  assert.equal(r.length, 1);
  assert.equal(r[0].pwd, "ab12", "150 字符外的码也该抓到");
  assert.equal(r[0].pwdMissing, false, "抓到了就不该标成缺码");
});

test("提取码：常见写法都要认（提取码/提取密码/访问码/访问密码/密码/口令/pwd）", () => {
  const link = "https://pan.baidu.com/s/1abcdefghij";
  for (const [text, want] of [
    [`${link} 提取码：ab12`, "ab12"],
    [`${link} 提取密码 cd34`, "cd34"],
    [`${link} 访问码:ef56`, "ef56"],
    [`${link} 访问密码 gh78`, "gh78"],
    [`${link} 密码 ij90`, "ij90"],
    [`${link} 口令 kl12`, "kl12"],
    [`${link}?pwd=mn34`, "mn34"],
  ]) {
    assert.equal(extractPanLinks(text)[0].pwd, want, `「${text.slice(-14)}」应解析出 ${want}`);
  }
});

test("提取码：提到了码却没抓到 → 必须标 pwdMissing（否则会一路走到转存才失败）", () => {
  const link = "https://pan.baidu.com/s/1abcdefghij";
  assert.equal(extractPanLinks(`${link} 提取码请私信我`)[0].pwdMissing, true, "提了没抓到要标记");
  assert.equal(extractPanLinks(`${link} 资源很清晰`)[0].pwdMissing, false, "压根没提码就不该标");
});

test("提取码：抓不到时也不能编一个出来（宁可空着，等 verify 去拒）", () => {
  const r = extractPanLinks("https://pan.baidu.com/s/1abcdefghij 提取码：请私信");
  assert.equal(r[0].pwd, "", "解析不出就必须留空，不能瞎猜");
});
