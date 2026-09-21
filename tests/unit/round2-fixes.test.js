"use strict";

/**
 * 第 2 轮审查（质检门 / 采样 / 跨进程写入 / 页面层）回归用例。
 * 每条对应一个实测复现过的缺陷。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const { buildQualityGate } = require("../../electron/src/quality/gate");
const { randomPickQuestions } = require("../../electron/src/tasks/random-pick");
const { Store } = require("../../electron/src/storage/store");
const { LlmClient } = require("../../electron/src/llm/client");
const zhidao = require("../../electron/src/pages/zhidao");

const gate = buildQualityGate({});
const QUESTION = { title: "男朋友总是打游戏不陪我，该怎么办？", questionContent: "在一起两年了，他下班就打游戏，说他也需要放松，可是我觉得被冷落了。" };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "r2-"));
}

/** 起一个会活 8 秒的子进程，拿它的 pid 当"另一个存活写入者" */
function liveChildPid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(function(){},8000)"], { stdio: "ignore" });
  return child.pid;
}

function killPid(pid) {
  try { process.kill(pid); } catch { /* 已经退出 */ }
}

// ---------- 质检门 ----------

test("质检门：超长答案是硬伤而不是扣 10 分", () => {
  const answer = "先把陪伴拆成具体的时段，再谈各自要的自由。".repeat(500);
  assert.ok(answer.length > gate.options.maxLength * 20, "样本需要超过短路阈值");
  const result = gate.evaluate(answer, QUESTION);
  assert.equal(result.decision, "REVIEW");
  assert.equal(result.checks.skippedForLength, true, "超长应先短路，不再跑后续扫描");
  assert.match(result.reviewReason, /超长/);
});

test("质检门：适度偏长（上限 1~20 倍）仍走完整检查", () => {
  const answer = "男朋友下班就打游戏不陪你，问题不在游戏而在陪伴时段没有谈拢，先约定各自的自由时间再谈别的。".repeat(15);
  assert.ok(answer.length > gate.options.maxLength, "样本需要超过长度上限");
  assert.ok(answer.length < gate.options.maxLength * 20, "样本不能触发短路");
  const result = gate.evaluate(answer, QUESTION);
  assert.equal(result.checks.skippedForLength, undefined);
  assert.equal(result.decision, "REVIEW");
  assert.match(result.reviewReason, /超长/);
});

test("质检门：AI 拒答话术的常见变体都要判硬伤", () => {
  const tail = "你可以把自己的感受写成三条具体请求，再约一个双方都清醒的时间谈，需求被说出来才有商量余地。";
  const variants = [
    `作为一个人工智能，我并不能体会你的心情。${tail}`,
    `抱歉，我无法访问你的聊天记录，只能给一点通用建议。${tail}`,
    `我没有最新的数据更新，下面内容仅供参考。${tail}`,
    `我的训练数据里缺少这类案例，建议你自己判断。${tail}`,
    `我只是语言模型，给不出针对你们俩的答案。${tail}`,
  ];
  for (const text of variants) {
    const result = gate.evaluate(text, QUESTION);
    assert.equal(result.checks.format.riskWords, true, `应命中 AI 痕迹：${text.slice(0, 20)}`);
    assert.equal(result.decision, "REVIEW", `应 REVIEW：${text.slice(0, 20)}`);
  }
});

test("质检门：AI 痕迹词表不误伤把 AI 当话题的正常回答", () => {
  const answer = "人工智能现在确实能陪聊，但它给不了你真实的拥抱。感情里的问题还是得两个人坐下来谈，把期待讲清楚，比谁都猜来猜去强。";
  const result = gate.evaluate(answer, QUESTION);
  assert.equal(result.checks.format.riskWords, false, "「人工智能」作为话题词不应判成 AI 自述");
});

test("质检门：Markdown 列表/引用/链接语法也算格式残留", () => {
  const answer = "- 先约定游戏时段\n> 陪伴质量比时长重要\n参见[这篇文章](https://example.com)\n把需求说清楚比生闷气管用得多，两个人都退一步就能谈拢。";
  const result = gate.evaluate(answer, QUESTION);
  assert.equal(result.checks.format.markdownResidue, true);
  assert.match(result.reviewReason, /Markdown/);
});

test("质检门：标题之间插标点绕不过复读检测", () => {
  const answer = "男、朋友、总是、打游戏、不陪我、该怎么办？把这话说清楚之前别急着吵架。他下班打游戏是减压出口，不是不在意你。";
  const result = gate.evaluate(answer, QUESTION);
  assert.equal(result.checks.titleEcho, true, "把标题按标点拆开复述也应识别为复读");
});

test("质检门：明显同域离题判硬伤，转述类真回答不误杀", () => {
  const offTopic = "异地恋维持感情需要双方共同努力，建立稳定的沟通节奏很重要，比如每天固定视频时间，把生活细节分享给对方，遇到分歧时先处理情绪再处理问题，这样安全感才会慢慢积累起来。";
  const off = gate.evaluate(offTopic, QUESTION);
  assert.equal(off.decision, "REVIEW", "整段搬运别处答案应 REVIEW");
  assert.match(off.reviewReason, /答非所问/);

  const paraphrase = "两年感情里他把游戏当解压出口，你把陪伴当安全需求，不是谁对谁错，是节奏没对上。可以约一个都舒服的时段，他打两把你陪看一集剧，再约定每周一次的固定出门日。";
  const real = gate.evaluate(paraphrase, QUESTION);
  assert.equal(real.decision, "PASS", `转述式真回答不应误杀：${real.reviewReason}`);
});

test("质检门：真实历史答案样本不被新规则误伤", () => {
  const samples = [
    "讨好型性格不是天生的，是孩子在早期经验里学会的生存策略。要纠正的方向不是让他别这么乖，而是给他试错的安全感，让他知道表达不同意见不会失去爱。",
    "考证这件事要看你后面三年的规划。如果只是简历上多一行字，C2 完全够用；如果想开手动挡或者以后可能换车型，增驾的成本比到时候现学低。",
  ];
  for (const text of samples) {
    const result = gate.evaluate(text, { title: "考完 C2 驾照还有必要增驾 C1 吗？", questionContent: "平时基本开自动挡，偶尔想试试手动。" });
    assert.equal(result.checks.length.tooLong, false, "正常长度不应被判超长");
    assert.equal(result.checks.format.riskWords, false);
    assert.equal(result.checks.duplicate, 0, "未给既有回答时重复度应为 0");
  }
});

// ---------- 生成任务：重复度窗口 ----------

test("生成任务：质检门拿到既有回答，整段照抄会被标出来", async () => {
  const { runGenerateTask } = require("../../electron/src/tasks/generate");
  const existing = "感情里陪伴和自由不是二选一，把需求说清楚比冷战有效得多，先谈各自期望的时段再谈别的。";
  const store = new Store(tempDir());
  store.upsertAnswer({ title: "旧题", questionUrl: "https://x/old", answer: existing });

  const llm = new LlmClient({
    apiKey: "k",
    baseUrl: "https://mock.test/v1/chat/completions",
    model: "mock-model",
    concurrency: 1,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: existing } }] }),
    }),
  });
  const ctx = {
    payload: { results: [{ title: "新题", questionUrl: "https://x/new" }], aiDailyTokenBudget: 0 },
    shouldStop: () => false,
    livePayload() { return this.payload; },
    delay: async () => {},
    report: () => {},
    emitItem: () => {},
  };
  const result = await runGenerateTask(ctx, { store, llm, log: () => {} });
  const quality = result.results[0].quality || "";
  assert.match(quality, /REVIEW/, `照抄既有回答应判 REVIEW，实际：${quality}`);
  assert.match(quality, /重复/);
});

// ---------- 采样 ----------

test("抽题：options/usedKeys 传 null、题库里混进 null 条目都不应崩", () => {
  const bank = [null, undefined, { title: "题目甲", questionUrl: "https://x/1", category: "情感类" }, 42];
  assert.doesNotThrow(() => randomPickQuestions(bank, null, null));
  const picked = randomPickQuestions(bank, ["url:https://x/1"], { categories: ["情感类"], count: 5 });
  assert.equal(picked.picked.length, 1, "唯一的题已被抽过 → 重开新一轮");
});

test("抽题：newest 在时间戳并列时不再每轮固定抽同一批", () => {
  const bank = Array.from({ length: 20 }, (_, i) => ({
    title: `题${i}`,
    questionUrl: `https://x/${i}`,
    category: "情感类",
    createdAt: "2026-09-20 10:00:00",
  }));
  const firsts = new Set();
  for (let i = 0; i < 30; i += 1) {
    firsts.add(randomPickQuestions(bank, [], { categories: ["情感类"], count: 5, strategy: "newest" }).picked[0].title);
  }
  assert.ok(firsts.size > 3, `并列时间戳应随机化首条，实际只见到 ${[...firsts].join(",")}`);
});

// ---------- 跨进程写入者 ----------

test("Store：另一个存活进程持有新鲜锁时，命令行工具拒绝启动", () => {
  const dir = tempDir();
  const live = liveChildPid();
  try {
    fs.writeFileSync(path.join(dir, ".store.lock"), JSON.stringify({ pid: live, owner: "gui", at: Date.now() }));
    const store = new Store(dir, { owner: "cli:test" });
    assert.ok(store.foreignWriter, "应识别出外来写入者");
    assert.throws(() => store.assertExclusive("测试脚本"), /正被另一个程序写入/);
  } finally {
    killPid(live);
  }
});

test("Store：锁的进程已死或心跳过期时不拦后来者", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, ".store.lock"), JSON.stringify({ pid: 999999, owner: "gui", at: Date.now() }));
  const dead = new Store(dir, { owner: "cli:test" });
  assert.equal(dead.foreignWriter, null, "pid 不存在应视为过期锁");
  assert.doesNotThrow(() => dead.assertExclusive("测试脚本"));

  const dir2 = tempDir();
  const live = liveChildPid();
  try {
    fs.writeFileSync(path.join(dir2, ".store.lock"), JSON.stringify({ pid: live, owner: "gui", at: Date.now() - 10 * 60 * 1000 }));
    const stale = new Store(dir2, { owner: "cli:test" });
    assert.equal(stale.foreignWriter, null, "心跳过期应视为已死");
    assert.doesNotThrow(() => stale.assertExclusive("测试脚本"));
  } finally {
    killPid(live);
  }
});

test("Store：释放锁只删自己那把", () => {
  const dir = tempDir();
  const a = new Store(dir, { owner: "cli:a" });
  a.releaseLock();
  assert.equal(fs.existsSync(path.join(dir, ".store.lock")), false, "自己的锁应删掉");
});

// ---------- 页面层 ----------

test("readQuestionTitle：剥掉「 - 百度知道」站点后缀", async () => {
  const page = {
    locator: () => ({ first: () => ({ textContent: async () => "" }) }),
    title: async () => "男朋友总说需要空间，是不是不爱了 - 百度知道",
  };
  const title = await zhidao.readQuestionTitle(page);
  assert.equal(title, "男朋友总说需要空间，是不是不爱了");
});

test("readQuestionTitle：标题里本身含「百度知道」时不被切坏", async () => {
  const page = {
    locator: () => ({ first: () => ({ textContent: async () => "" }) }),
    title: async () => "百度知道为什么一直无法采纳别人的回答？",
  };
  const title = await zhidao.readQuestionTitle(page);
  assert.equal(title, "百度知道为什么一直无法采纳别人的回答？");
});

test("爬题：bitEnvs 不是数组时给可读错误，而不是 TypeError", async () => {
  const { runCrawlTask } = require("../../electron/src/tasks/crawl");
  const ctx = { payload: { bitEnvs: "测试组1" }, shouldStop: () => false };
  await assert.rejects(
    () => runCrawlTask(ctx, { log: () => {}, store: {}, config: {}, browserPool: {} }),
    /至少一个比特浏览器环境/
  );
});
