"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  QUESTION_STATES,
  canTransitionQuestion,
  questionFingerprint,
  toQuestionModel,
  advanceQuestionLifecycle,
} = require("../../electron/src/domain/question");

test("fingerprint：URL 参数不同但 pathname 相同 → 同一指纹", () => {
  const a = questionFingerprint({ questionUrl: "https://zhidao.baidu.com/question/hx/3124836956?activity=21th", title: "读书" });
  const b = questionFingerprint({ questionUrl: "https://zhidao.baidu.com/question/hx/3124836956?activity=21th&autoOpenAnswer=voice", title: "读书" });
  assert.equal(a, b, "activity 参数不应影响指纹");
  const c = questionFingerprint({ questionUrl: "https://zhidao.baidu.com/question/hx/999", title: "读书" });
  assert.notEqual(a, c);
});

test("fingerprint：非法 URL 回退标题", () => {
  const a = questionFingerprint({ questionUrl: "不是链接", title: "T" });
  const b = questionFingerprint({ questionUrl: "", title: "T" });
  assert.ok(a && b);
});

test("生命周期：合法主路径", () => {
  assert.ok(canTransitionQuestion(QUESTION_STATES.READY, QUESTION_STATES.ANSWERING));
  assert.ok(canTransitionQuestion(QUESTION_STATES.ANSWERING, QUESTION_STATES.ANSWERED));
  assert.ok(canTransitionQuestion(QUESTION_STATES.ANSWERED, QUESTION_STATES.REVIEW_REQUIRED));
  assert.ok(canTransitionQuestion(QUESTION_STATES.REVIEW_REQUIRED, QUESTION_STATES.APPROVED));
  assert.ok(canTransitionQuestion(QUESTION_STATES.APPROVED, QUESTION_STATES.SUBMITTING));
  assert.ok(canTransitionQuestion(QUESTION_STATES.SUBMITTING, QUESTION_STATES.SUBMITTED));
});

test("生命周期：非法跳转被拒", () => {
  assert.equal(canTransitionQuestion(QUESTION_STATES.DISCOVERED, QUESTION_STATES.SUBMITTED), false);
  assert.equal(canTransitionQuestion(QUESTION_STATES.SUBMITTED, QUESTION_STATES.READY), false);
});

test("toQuestionModel：旧记录 → 已提交模型", () => {
  const model = toQuestionModel({
    category: "情感类",
    title: "T1",
    questionUrl: "https://zhidao.baidu.com/question/hx/1?activity=21th",
    answer: "内容",
    status: "已提交",
    submittedAt: "2026/9/15 01:00:00",
    confirmed: true,
  });
  assert.equal(model.lifecycle, QUESTION_STATES.SUBMITTED);
  assert.equal(model.answer.state, "GENERATED");
  assert.equal(model.submission.state, "SUBMITTED");
  assert.equal(model.submission.confirmed, true);
  assert.ok(model.id.startsWith("q_"));
  assert.ok(model.fingerprint.length === 24);
});

test("toQuestionModel：仅有题干的旧记录 → READY", () => {
  const model = toQuestionModel({ title: "T", questionUrl: "https://x/1", category: "情感类" });
  assert.equal(model.lifecycle, QUESTION_STATES.READY);
  assert.equal(model.answer.state, "NONE");
  assert.equal(model.submission.state, "NOT_SUBMITTED");
});

test("toQuestionModel：质检问题回答 → REVIEW_REQUIRED", () => {
  const model = toQuestionModel({ title: "T", answer: "短", quality: "过短（2 字）；含 AI 痕迹词", status: "已生成回答" });
  assert.equal(model.lifecycle, QUESTION_STATES.REVIEW_REQUIRED);
});

test("toQuestionModel：显式 lifecycle 优先", () => {
  const model = toQuestionModel({ title: "T", lifecycle: QUESTION_STATES.ANSWER_FAILED });
  assert.equal(model.lifecycle, QUESTION_STATES.ANSWER_FAILED);
  assert.equal(model.answer.state, "FAILED");
});

test("advanceQuestionLifecycle：合法推进返回来源；非法抛错", () => {
  const record = { title: "T", questionUrl: "https://x/1" };
  assert.equal(advanceQuestionLifecycle(record, QUESTION_STATES.ANSWERING), QUESTION_STATES.READY);
  assert.throws(() => advanceQuestionLifecycle(record, QUESTION_STATES.SUBMITTED), /非法题目生命周期迁移/);
});
