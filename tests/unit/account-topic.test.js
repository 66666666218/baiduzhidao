"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  topicKey,
  normalizeAccountTopics,
  topicOf,
  accountsForTopic,
  unboundAccounts,
  buildAllocation,
} = require("../../electron/src/domain/account-topic");
const { classifyAnswerKind, splitRowsByKind, extractUrls } = require("../../electron/src/domain/answer-kind");
const { normalizeAccountTopicsSetting, normalizeSettings } = require("../../electron/src/config");

// ---------- 答案形态判定 ----------

test("classifyAnswerKind：网盘链接/普通外链/提取码都算带链接，纯文本不算", () => {
  assert.equal(classifyAnswerKind({ answer: "点击链接获取：https://pan.baidu.com/s/1abc?pwd=1a2b" }), "link");
  assert.equal(classifyAnswerKind({ answer: "详见 https://example.com/article" }), "link", "任意外链也算带链接（保守口径）");
  assert.equal(classifyAnswerKind({ answer: "资源已整理好，提取码：ab12" }), "link", "只有提取码也判定为链接答案");
  assert.equal(classifyAnswerKind({ answer: "先接纳自己的情绪，再和对方沟通。" }), "plain");
  assert.equal(classifyAnswerKind({ answer: "" }), "plain");
  assert.equal(classifyAnswerKind(null), "plain");
});

test("classifyAnswerKind：链接只出现在复制用答案里也要能识别", () => {
  assert.equal(classifyAnswerKind({ answer: "见链接", copyText: "https://pan.quark.cn/s/xyz" }), "link");
});

test("extractUrls：中文标点紧跟链接时不被吞进 URL", () => {
  assert.deepEqual(extractUrls("看这个https://pan.baidu.com/s/1a?pwd=1b2c。"), ["https://pan.baidu.com/s/1a?pwd=1b2c"]);
});

test("splitRowsByKind：按形态分两拨", () => {
  const rows = [
    { answer: "https://pan.baidu.com/s/1a?pwd=1b2c" },
    { answer: "普通回答" },
    { answer: "https://example.com" },
  ];
  const { link, plain } = splitRowsByKind(rows);
  assert.equal(link.length, 2);
  assert.equal(plain.length, 1);
});

// ---------- 绑定表归一化 ----------

test("normalizeAccountTopics：对象/数组/文本三种输入等价", () => {
  const expected = { 环境A: "情感类", 环境B: "教育类" };
  assert.deepEqual(normalizeAccountTopics({ 环境A: "情感类", 环境B: "教育类" }), expected);
  assert.deepEqual(normalizeAccountTopics([{ account: "环境A", topic: "情感类" }, { label: "环境B", topic: "教育类" }]), expected);
  assert.deepEqual(normalizeAccountTopics("环境A=情感类\n环境B：教育类"), expected);
});

test("normalizeAccountTopics：空值与非法项被丢弃而非抛错", () => {
  assert.deepEqual(normalizeAccountTopics(null), {});
  assert.deepEqual(normalizeAccountTopics({ 环境A: "", 环境B: "教育类" }), { 环境B: "教育类" });
  assert.deepEqual(normalizeAccountTopics([null, "乱写", { account: "环境C" }]), {});
});

test("normalizeAccountTopicsSetting：题材收敛到规范分类，收敛不了的丢弃", () => {
  const result = normalizeAccountTopicsSetting({ 环境A: "情感", 环境B: "教育类", 环境C: "不存在的题材" });
  assert.deepEqual(result, { 环境A: "情感类", 环境B: "教育类" }, "「情感」补全为「情感类」，未知题材丢弃");
});

test("normalizeSettings：accountTopics 与 linkRouting 有默认值且非法值回退", () => {
  const settings = normalizeSettings({ linkRouting: "瞎写" });
  assert.deepEqual(settings.accountTopics, {});
  assert.equal(settings.linkRouting, "strict");
  assert.equal(normalizeSettings({ linkRouting: "off" }).linkRouting, "off");
});

// ---------- 账号 ↔ 题材查询 ----------

test("topicOf / accountsForTopic / unboundAccounts", () => {
  const map = { 环境A: "情感类", 环境B: "教育类" };
  assert.equal(topicOf("环境A", map), "情感类");
  assert.equal(topicOf("环境C", map), "", "未绑定返回空串");
  assert.deepEqual(accountsForTopic("情感", ["环境A", "环境B", "环境C"], map), ["环境A"], "「情感」与「情感类」视为同一题材");
  assert.deepEqual(accountsForTopic("人物类", ["环境A", "环境B"], map), []);
  assert.deepEqual(unboundAccounts(["环境A", "环境C"], map), ["环境C"]);
});

test("topicKey：忽略空白与尾部「类」", () => {
  assert.equal(topicKey(" 情感类 "), "情感");
  assert.equal(topicKey("情感"), "情感");
  assert.equal(topicKey(""), "");
});

// ---------- 提交分配 ----------

const linkRow = (category, url) => ({ category, questionUrl: url, answer: `资源链接 https://pan.baidu.com/s/1x?pwd=ab12` });
const plainRow = (category, url) => ({ category, questionUrl: url, answer: "这是普通回答，没有链接。" });
const lengthOf = (allocation) => allocation.map((slot) => slot.rows.length);
const topicsOf = (slot) => slot.rows.map((row) => row.category);

test("buildAllocation：带链接答案严格一对一，账号只吃自己绑定的题材", () => {
  const rows = [
    linkRow("情感类", "u1"),
    linkRow("情感类", "u2"),
    linkRow("教育类", "u3"),
  ];
  const { slots, stats } = buildAllocation(rows, ["环境A", "环境B"], { 环境A: "情感类", 环境B: "教育类" });

  assert.deepEqual(lengthOf(slots), [2, 1]);
  assert.deepEqual(topicsOf(slots[0]), ["情感类", "情感类"]);
  assert.deepEqual(topicsOf(slots[1]), ["教育类"]);
  assert.equal(stats.link, 3);
  assert.equal(stats.orphanByTopic["人物"], undefined);
  assert.equal(stats.unrouted, 0);
});

test("buildAllocation：题材没有绑定账号 → 计入 orphanByTopic，不硬塞给别的账号", () => {
  const rows = [linkRow("情感类", "u1"), linkRow("人物类", "u2")];
  const { slots, stats, unrouted } = buildAllocation(rows, ["环境A"], { 环境A: "情感类" });

  assert.deepEqual(lengthOf(slots), [1], "环境A 只收情感类");
  assert.deepEqual(stats.orphanByTopic, { 人物: 1 });
  assert.equal(unrouted.length, 1);
  assert.equal(unrouted[0].questionUrl, "u2");
});

test("buildAllocation：纯文本答案宽松轮询，跨题材摊到所有账号（前期刷额度阶段）", () => {
  const rows = [
    plainRow("情感类", "u1"),
    plainRow("教育类", "u2"),
    plainRow("综合类", "u3"),
    plainRow("人物类", "u4"),
  ];
  const { slots, stats } = buildAllocation(rows, ["环境A", "环境B"], { 环境A: "情感类", 环境B: "教育类" });

  assert.deepEqual(lengthOf(slots), [2, 2], "未绑定的题材也能分到账号");
  assert.equal(stats.plain, 4);
  assert.equal(stats.unrouted, 0);
});

test("buildAllocation：链接行优先占额度，纯文本吃剩下的容量", () => {
  const rows = [linkRow("情感类", "u1"), linkRow("情感类", "u2"), plainRow("教育类", "u3")];
  const { slots, stats } = buildAllocation(rows, ["环境A"], { 环境A: "情感类" }, { accountDailyLimit: 2 });

  assert.deepEqual(topicsOf(slots[0]), ["情感类", "情感类"], "链接答案优先");
  assert.equal(stats.capacityDropped, 1, "容量用尽后纯文本被挤出");
  assert.equal(stats.unrouted, 1);
});

test("buildAllocation：容量上限取每账号每日限额与单轮限额的较小值", () => {
  const rows = Array.from({ length: 10 }, (_v, i) => plainRow("情感类", `u${i}`));
  const { stats } = buildAllocation(rows, ["环境A"], { 环境A: "情感类" }, { accountDailyLimit: 5, perEnvLimit: 3 });
  assert.equal(stats.capacity, 3);
  assert.equal(stats.planned, 3);
});

test("buildAllocation：linkRouting=off 时链接答案退回普通轮询", () => {
  const rows = [linkRow("人物类", "u1")];
  const { slots, stats } = buildAllocation(rows, ["环境A"], { 环境A: "情感类" }, { strictLinkRouting: false });
  assert.deepEqual(lengthOf(slots), [1], "关闭严格路由后，题材不匹配也能投递");
  assert.equal(stats.orphanByTopic["人物"], undefined);
});

test("buildAllocation：没有账号时不静默丢数据，全部计入 unrouted", () => {
  const rows = [linkRow("情感类", "u1")];
  const { slots, unrouted } = buildAllocation(rows, [], { 环境A: "情感类" });
  assert.deepEqual(slots, []);
  assert.equal(unrouted.length, 1);
});
