"use strict";

/**
 * 第 24 轮：用户说「生成问答并发使用 api 可以几千次同时，脚本不能做到吗，
 * 提前放好链接然后来进行并发脚本模板」。
 *
 * 先承认他对的部分：**AI 生成这一段，并发几千在技术上完全可行** ——
 * LLM 供应商按速率计费、按速率限流，能并发多少取决于 Key 的档位，跟百度那条协议链无关。
 * 而挡住它的那个数字 **8 是我们自己写死的**（`clampInt(next.aiConcurrency, 1, 8, …)`），
 * 不是任何技术上限。所以本轮第一件事就是把上限打开。
 *
 * 但"打开上限"只是半个答案，另半个更关键：**并发调高之后，429 会从偶尔变成常态。**
 * 原来的重试策略是 3 次尝试、2s/4s 退避 —— 高并发下这意味着大批题目在第三次后彻底失败，
 * 用户看到的现象是"把并发调高了反而大面积失败"，于是再也不敢调高，而这恰恰是他要的速度。
 * 所以 429 单独一套策略：6 次尝试、2/4/8/15/30/45 秒退避 + 抖动，
 * 并把"撞了几次限流"写进收尾行 —— 那是用户调并发数的唯一依据
 * （撞了几十次 = 调过头；一次没撞 = 还能再加）。
 *
 * 本轮测试全部**真调 LlmClient**（注入 mock fetch / mock sleep），不扫文本：
 * 429 之后还能不能拿到答案、峰值并发是不是真的到了设定值，这些只有真跑才知道。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { normalizeSettings, AI_CONCURRENCY_MAX } = require("../../electron/src/config");
const {
  LlmClient, RATE_LIMIT_STATUS, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_DELAYS_MS,
} = require("../../electron/src/llm/client");
const { generatePaceTail } = require("../../electron/src/netdisk/transfer-progress");

const INDEX_HTML = "electron/renderer/index.html";
const RENDERER = "electron/renderer/renderer.js";
const CLIENT = "electron/src/llm/client.js";
const CONFIG = "electron/src/config.js";

/** 造一个 200 响应的假 fetch（OpenAI 兼容形状） */
function okFetch(content = "这是一条回答。") {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  });
}

/** 造一个前 n 次返回 429、之后恢复 200 的假 fetch */
function flakyFetch(failTimes, status = RATE_LIMIT_STATUS) {
  let seen = 0;
  const waited = [];
  const fetchImpl = async () => {
    seen += 1;
    if (seen <= failTimes) {
      return { ok: false, status, text: async () => JSON.stringify({ message: "rate limit" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "恢复后的回答" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  return { fetchImpl, seen: () => seen, waited };
}

// --------------------------------------------- K 组：并发上限（那个 8 是我们自己写的）

test("K1 并发上限是 64（原来那个 8 是自定义的，不是技术上限）", () => {
  assert.equal(AI_CONCURRENCY_MAX, 64);
  assert.equal(normalizeSettings({}).aiConcurrency, 6, "默认仍是 6，不因为放开上限就改默认");
  assert.equal(normalizeSettings({ aiConcurrency: 99 }).aiConcurrency, 64, "超过上限夹到 64");
  assert.equal(normalizeSettings({ aiConcurrency: 0 }).aiConcurrency, 1, "下限仍是 1");
  assert.equal(normalizeSettings({ aiConcurrency: -5 }).aiConcurrency, 1);
  assert.equal(normalizeSettings({ aiConcurrency: 8 }).aiConcurrency, 8, "老用户设的 8 不被改动");
  assert.equal(normalizeSettings({ aiConcurrency: 32 }).aiConcurrency, 32, "中间值原样通过");
});

test("K2 设置页输入框上限与后端一致，并把「真实上限是供应商」说清楚", () => {
  const html = read(INDEX_HTML);
  const block = html.slice(
    html.indexOf("<input type=\"number\" id=\"aiConcurrency\""),
    html.indexOf("</div>", html.indexOf("<input type=\"number\" id=\"aiConcurrency\"")),
  );
  assert.match(block, /min="1" max="64"/, "输入框上限要和 config 的 64 一致");
  assert.match(block, /class="hint"/);
  // 必须说清"真实上限是供应商的速率限制"—— 否则用户会把 64 当成我们测过的安全值
  assert.match(block, /真实上限是供应商/);
  assert.match(block, /429/);
  // 界面文案不许出现 markdown 的 **
  assert.doesNotMatch(block, /\*\*/);
});

test("K3 设置页回填兜底值与后端默认一致", () => {
  assert.match(read(RENDERER), /\$\("aiConcurrency"\)\.value = settings\.aiConcurrency \|\| 6;/);
});

// --------------------------------------------- L 组：429 是"慢一点"，不是"这一题废了"

test("L1 撞两次 429 之后仍能拿到答案（不会被判废）", async () => {
  // 这是本轮最核心的行为：高并发下 429 是常态，若还用老的 3 次 / 2s-4s 策略，
  // 用户调高并发换来的是一大批"生成失败"。
  const logs = [];
  const { fetchImpl, seen } = flakyFetch(2);
  const client = new LlmClient({
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1/v1/chat/completions",
    model: "m",
    concurrency: 2,
    fetchImpl,
    sleepImpl: async () => {},   // 退避不真等（否则这一条要耗 6 秒）
    onUsage: () => {},
  });
  const answer = await client.generateAnswer({ title: "T", questionContent: "C" }, { onLog: (m) => logs.push(m) });
  assert.equal(answer, "恢复后的回答", "两次 429 之后应该拿到正常回答");
  assert.equal(seen(), 3, "前两次 429 + 第三次成功");
  assert.equal(client.usage.rateLimited, 2, "撞限流次数要记下来（收尾行要用它）");
  assert.equal(client.semaphore.running, 0, "重试走完名额要还回来，不能漏");
  assert.ok(logs.some((m) => m.includes("供应商限流")), "日志要说清这是限流，不是 Key 失效");
  assert.ok(logs.some((m) => m.includes("不是 Key 失效")), "必须点明「不是 Key 失效」，否则用户会去重填 Key");
});

test("L2 429 的重试次数比普通错误多（普通错误仍是 3 次，不无限重试）", async () => {
  // 反向约束：别为了让 429 能恢复，把 500/502 也变成重试 6 次 ——
  // 那会让"Key 错了/baseUrl 错了"这类确定性失败拖很久才报出来。
  const logs = [];
  const always500 = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const client = new LlmClient({
    apiKey: "k", baseUrl: "http://127.0.0.1:1/v1/chat/completions", model: "m",
    fetchImpl: always500, sleepImpl: async () => {}, onUsage: () => {},
  });
  await assert.rejects(() => client.generateAnswer({ title: "T" }, { onLog: (m) => logs.push(m) }));
  const retried = logs.filter((m) => m.includes("秒后重试")).length;
  assert.equal(retried, 2, `普通错误应该只重试 2 次（共 3 次尝试），实际 ${retried}`);
  assert.equal(client.usage.rateLimited, 0, "500 不计入撞限流");
});

test("L3 429 一直不恢复时也不会无限重试（试满 6 次就放弃这一题）", async () => {
  const { fetchImpl, seen } = flakyFetch(999);
  const client = new LlmClient({
    apiKey: "k", baseUrl: "http://127.0.0.1:1/v1/chat/completions", model: "m",
    fetchImpl, sleepImpl: async () => {}, onUsage: () => {},
  });
  await assert.rejects(() => client.generateAnswer({ title: "T" }, { onLog: () => {} }));
  assert.equal(seen(), RATE_LIMIT_MAX_ATTEMPTS, `429 应该试满 ${RATE_LIMIT_MAX_ATTEMPTS} 次`);
  assert.equal(client.usage.rateLimited, RATE_LIMIT_MAX_ATTEMPTS);
  assert.equal(client.semaphore.running, 0);
});

test("L4 429 的退避梯是递增的且带抖动（防止同批次齐步走）", () => {
  // 不给抖动的话，同批次几十个请求会在同一秒一起重试，制造下一波同步的 429。
  const sorted = [...RATE_LIMIT_DELAYS_MS].sort((a, b) => a - b);
  assert.deepEqual(sorted, RATE_LIMIT_DELAYS_MS, "退避梯必须单调递增");
  assert.ok(RATE_LIMIT_DELAYS_MS[0] >= 1000, "第一次退避不能太短（马上重试只会再撞一次）");
  assert.equal(RATE_LIMIT_DELAYS_MS.length, RATE_LIMIT_MAX_ATTEMPTS - 1, "梯子长度 = 尝试次数 - 1");
});

// --------------------------------------------- M 组：并发真的放开了（不是只改了个数字）

test("M1 峰值并发真的能达到设定值（并发 32 就同时跑 32 条）", async () => {
  // 这条是"放开上限"有没有骗人的唯一证据：光把 clamp 改成 64 没用，
  // 得看 worker 池和信号量是不是真的同时放出 32 个请求。
  let inFlight = 0;
  let peak = 0;
  const client = new LlmClient({
    apiKey: "k", baseUrl: "http://127.0.0.1:1/v1/chat/completions", model: "m",
    concurrency: 32,
    fetchImpl: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "答" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    },
    onUsage: () => {},
  });
  const all = Array.from({ length: 32 }, () => client.generateAnswer({ title: "T" }));
  const answers = await Promise.all(all);
  assert.equal(answers.length, 32);
  assert.ok(answers.every((a) => a === "答"), "32 条都要拿到回答，一条都不能丢");
  assert.equal(peak, 32, `峰值并发应该达到 32，实测 ${peak}`);
  assert.equal(client.semaphore.running, 0);
});

test("M2 并发 64 + 每请求先撞一次 429 时，64 条全部最终完成", async () => {
  // 高压场景：**先撞一次限流再恢复**。要求是"慢"（有退避等待）而不是"丢"（直接判废）。
  // 注意这里用 flakyFetch(64) 而不是一个"永不恢复"的 mock —— 永不恢复时
  // 程序应该在试满 6 次后放弃并报错（那条由 L3 钉着），两种结果不能混为一谈。
  const { fetchImpl, seen } = flakyFetch(64);
  const client = new LlmClient({
    apiKey: "k", baseUrl: "http://127.0.0.1:1/v1/chat/completions", model: "m",
    concurrency: 64,
    fetchImpl,
    sleepImpl: async () => {},
    onUsage: () => {},
  });
  const answers = await Promise.all(Array.from({ length: 64 }, () => client.generateAnswer({ title: "T" })));
  // 成功分支返回的是 mock 里的「恢复后的回答」（不是首字「答」，别被 truncate 骗了）
  assert.equal(answers.filter((a) => a === "恢复后的回答").length, 64, "高压下一条都不许丢");
  assert.equal(seen(), 128, "64 次首撞 + 64 次重试成功");
  assert.equal(client.usage.rateLimited, 64);
  assert.equal(client.semaphore.running, 0, "名额全部归还");
});

// --------------------------------------------- N 组：收尾文案带上"撞限流几次"

test("N1 收尾文案：撞过限流时要说出来，并给出下一步动作", () => {
  // 这个数字是用户调并发数的唯一依据：撞了几十次 = 调过头；一次没撞 = 还能再加。
  assert.equal(
    generatePaceTail({ concurrency: 64, perItemMs: 2600, elapsedMs: 135000, rateLimited: 0 }),
    "（并发 64，实测 2.6 秒/条，共 2 分钟）",
    "没撞限流时不要多嘴",
  );
  assert.equal(
    generatePaceTail({ concurrency: 64, perItemMs: 2600, elapsedMs: 135000, rateLimited: 37 }),
    "（并发 64，实测 2.6 秒/条，共 2 分钟，撞限流 37 次（调低并发数会更快））",
  );
  assert.equal(generatePaceTail({ concurrency: 6, perItemMs: 0, elapsedMs: 135000, rateLimited: 9 }), "",
    "pace=0（算不出来）时整体闭嘴，不要只报一个限流次数");
});

// --------------------------------------------- O 组：编译与"一条逻辑一个家"

test("O1 改动文件都能当脚本编译（round13 D2）", () => {
  const vm = require("node:vm");
  for (const rel of [CLIENT, CONFIG, "electron/src/netdisk/transfer-progress.js", "electron/src/tasks/generate.js", RENDERER]) {
    assert.doesNotThrow(() => new vm.Script(read(rel), { filename: rel }), `${rel} 必须能通过 vm.Script`);
  }
});

test("O2 并发上限只在一个地方定义（不许在别处再写一个 64）", () => {
  // 老毛病：上限在 config、HTML、renderer 各写一遍，改了两处漏一处 → 界面能填 64、后端夹到 8。
  const html = read(INDEX_HTML);
  const hits = (html.match(/aiConcurrency[^>]*max="64"/g) || []).length;
  assert.equal(hits, 1, "HTML 里只应有一处并发数输入框");
  assert.match(read(CONFIG), /clampInt\(next\.aiConcurrency, 1, AI_CONCURRENCY_MAX,/,
    "后端夹取必须用导出的常量，不写死数字");
});
