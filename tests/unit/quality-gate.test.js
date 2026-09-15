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
