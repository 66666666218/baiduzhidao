"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { randomPickQuestions, normalizeStrategy } = require("../../electron/src/tasks/random-pick");

function makeBank(n, category = "情感类", withTime = false) {
  return Array.from({ length: n }, (_v, i) => ({
    title: `题${i}`,
    questionUrl: `https://x/${category}-${i}`,
    category,
    createdAt: withTime ? `2026/9/${(i % 28) + 1} 12:00` : "",
  }));
}

test("随机抽题：跨轮次去重与重置", () => {
  const bank = makeBank(10);
  const r1 = randomPickQuestions(bank, [], { categories: ["情感类"], count: 6 });
  assert.equal(r1.picked.length, 6);
  assert.equal(r1.remainingAfter, 4);
  const r2 = randomPickQuestions(bank, r1.usedKeys, { categories: ["情感类"], count: 6 });
  assert.equal(r2.picked.length, 4);
  const r3 = randomPickQuestions(bank, r2.usedKeys, { categories: ["情感类"], count: 6 });
  assert.equal(r3.picked.length, 6, "重开一轮");
  assert.equal(r3.resetRound, true);
});

test("随机抽题：分类过滤", () => {
  const bank = [...makeBank(5, "情感类"), ...makeBank(3, "教育类")];
  const result = randomPickQuestions(bank, [], { categories: ["教育类"], count: 10 });
  assert.equal(result.total, 3);
  assert.ok(result.picked.every((item) => item.category === "教育类"));
});

test("采样策略：unanswered 未答优先", () => {
  const bank = makeBank(4);
  bank[0].answer = "已有答案";
  bank[2].answer = "已有答案";
  const result = randomPickQuestions(bank, [], { categories: ["三类一起"], count: 2, strategy: "unanswered" });
  assert.ok(result.picked.every((item) => !item.answer), "应优先取无答案的题");
});

test("采样策略：newest 最新优先", () => {
  const bank = makeBank(5, "情感类", true);
  const result = randomPickQuestions(bank, [], { categories: ["三类一起"], count: 3, strategy: "newest" });
  const titles = result.picked.map((item) => Number(item.title.replace("题", "")));
  assert.deepEqual(titles.sort((a, b) => b - a), [4, 3, 2].sort((a, b) => b - a).slice(0, 3).sort((a, b) => b - a), "日期最大的排前");
});

test("采样策略：oldest 最早优先", () => {
  const bank = makeBank(5, "情感类", true);
  const result = randomPickQuestions(bank, [], { categories: ["三类一起"], count: 3, strategy: "oldest" });
  const titles = result.picked.map((item) => Number(item.title.replace("题", "")));
  assert.deepEqual(titles, [0, 1, 2], "索引小（日期早）的排前");
});

test("采样策略：category-balanced 分类均衡", () => {
  const bank = [...makeBank(6, "情感类"), ...makeBank(2, "教育类")];
  const result = randomPickQuestions(bank, [], { categories: ["三类一起"], count: 4, strategy: "category-balanced" });
  const byCat = {};
  for (const item of result.picked) byCat[item.category] = (byCat[item.category] || 0) + 1;
  assert.equal(byCat["情感类"], 2, "情感类 2 条");
  assert.equal(byCat["教育类"], 2, "教育类 2 条（轮转均衡）");
});

test("采样策略：未知策略回退 random", () => {
  assert.equal(normalizeStrategy("nonsense"), "random");
  assert.equal(normalizeStrategy("NEWEST"), "newest");
  const bank = makeBank(4);
  const result = randomPickQuestions(bank, [], { categories: ["三类一起"], count: 2, strategy: "nonsense" });
  assert.equal(result.picked.length, 2);
});
