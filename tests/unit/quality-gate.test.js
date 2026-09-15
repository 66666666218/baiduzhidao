"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { buildQualityGate } = require("../../electron/src/quality/gate");

const gate = buildQualityGate({});

const GOOD_ANSWER = "对普通家庭的孩子来说，读书大概率还是最公平、成本最低的那条路。它不保证大富大贵，但能给你更多选择的权利。建议把书读好的同时，也别放弃探索自己真正擅长的事，两条腿走路会更稳。";
const QUESTION = { title: "读书是不是唯一的出路？", questionContent: "普通家庭的孩子如何选择未来方向" };

test("Quality Gate：优质回答 PASS 且高分行", () => {
  const result = gate.evaluate(GOOD_ANSWER, QUESTION);
  assert.equal(result.decision, "PASS");
  assert.ok(result.score >= 60);
  assert.equal(result.checks.length.tooShort, false);
  assert.equal(result.checks.format.riskWords, false);
});

test("Quality Gate：空回答 REVIEW", () => {
  const result = gate.evaluate("", QUESTION);
  assert.equal(result.decision, "REVIEW");
  assert.equal(result.score, 0);
});

test("Quality Gate：过短 REVIEW", () => {
  const result = gate.evaluate("挺好的。", QUESTION);
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.issues.some((issue) => issue.includes("过短")));
});

test("Quality Gate：AI 痕迹词硬伤 REVIEW", () => {
  const result = gate.evaluate(GOOD_ANSWER + " 作为一个AI语言模型，我无法访问互联网。", QUESTION);
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.issues.some((issue) => issue.includes("AI 痕迹")));
});

test("Quality Gate：Markdown 残留扣分", () => {
  const result = gate.evaluate("# 结论\n\n" + GOOD_ANSWER, QUESTION);
  assert.equal(result.checks.format.markdownResidue, true);
  assert.ok(result.issues.some((issue) => issue.includes("Markdown")));
});

test("Quality Gate：与问题完全无关 → REVIEW", () => {
  const result = gate.evaluate("今天天气不错适合出门散步运动一下身体好。", { title: "如何备考注册会计师", questionContent: "" });
  assert.equal(result.decision, "REVIEW");
});

test("Quality Gate：复读标题 → REVIEW", () => {
  const result = gate.evaluate("读书是不是唯一的出路？读书是不是唯一的出路？这个问题很常见，我的看法是可以考虑别的路。", QUESTION);
  assert.equal(result.checks.titleEcho, true);
  assert.equal(result.decision, "REVIEW");
});

test("Quality Gate：与既有回答高度重复 → REVIEW", () => {
  const result = gate.evaluate(GOOD_ANSWER, { ...QUESTION, existingAnswers: [GOOD_ANSWER] });
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.checks.duplicate >= 0.9);
});

test("Quality Gate：自定义阈值", () => {
  const strict = buildQualityGate({ minLength: 100 });
  const result = strict.evaluate("这个回答中等长度，有五十个字符左右吧，大概就是这样了。", QUESTION);
  assert.equal(result.decision, "REVIEW");
});

test("Quality Gate：不确定词密集 → REVIEW（规则红线）", () => {
  const result = gate.evaluate(
    "这个问题可能有很多答案。通常来说要看情况，大概也许每个人都有不同的可能吧，通常大家的选择都不一样。",
    QUESTION
  );
  assert.equal(result.checks.format.uncertainWords, true);
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.issues.some((issue) => issue.includes("不确定词")));
});

test("Quality Gate：官方示例结构（结论/真实细节/观点升华）不被误杀", () => {
  const official =
    "结论：真正有效的安慰，不是讲道理，而是先让对方觉得被理解了。真实细节：我以前状态很差的时候，有个朋友只是陪我在楼下坐了两个小时，问了一句你最近是不是撑太久了。问题本质：人真正需要的不是被教育，而是被接住。实操建议：先听，别急着评判；先接情绪，再聊解决办法。观点升华：一句最近是不是很累，比十句你要坚强更有用。";
  const result = gate.evaluate(official, { title: "如何安慰心情不好的人", questionContent: "" });
  assert.equal(result.decision, "PASS", JSON.stringify(result.issues));
});
