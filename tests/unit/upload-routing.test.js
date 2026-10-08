"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { pickTitleKey, safeFileToken, collectTopicRows } = require("../../electron/src/tasks/upload-batch");

test("pickTitleKey：认出「问题标题」列（SOP 六列格式）", () => {
  assert.equal(pickTitleKey(["qid", "问题标题", "一级分类", "二级分类", "问题发布时间", "回答内容"]), "问题标题");
});

test("pickTitleKey：兼容「资源名」与「标题」两种上游列名", () => {
  assert.equal(pickTitleKey(["qid", "资源名", "链接"]), "资源名");
  assert.equal(pickTitleKey(["标题", "回答内容"]), "标题");
});

test("pickTitleKey：都不认识时退回第一列，不返回空串", () => {
  assert.equal(pickTitleKey(["colA", "colB"]), "colA");
  assert.equal(pickTitleKey([]), "");
});

test("safeFileToken：账号名里的路径非法字符被净化", () => {
  assert.equal(safeFileToken("测试/组*1:号"), "测试_组_1_号");
  assert.equal(safeFileToken(""), "account", "空名回退到默认，避免生成 .xlsx 这种隐藏文件");
  assert.equal(safeFileToken("a".repeat(80)).length, 40, "超长截断，避免路径过长");
});

// ---------- 拆表（分类产出） ----------

test("collectTopicRows：按题材合回桶，一个题材一张表", () => {
  const slots = [
    { envLabel: "环境A", topic: "游戏", rows: [{ id: 1 }, { id: 2 }] },
    { envLabel: "环境B", topic: "影视", rows: [{ id: 3 }] },
  ];
  const byTopic = collectTopicRows(slots);
  assert.deepEqual([...byTopic.keys()], ["游戏", "影视"]);
  assert.equal(byTopic.get("游戏").length, 2);
  assert.equal(byTopic.get("影视").length, 1);
});

test("collectTopicRows：同题材多账号的行会合并——分表按题材切，不按账号切", () => {
  const slots = [
    { envLabel: "环境A", topic: "游戏", rows: [{ id: 1 }] },
    { envLabel: "环境B", topic: "游戏", rows: [{ id: 2 }] },
  ];
  const byTopic = collectTopicRows(slots);
  assert.equal(byTopic.size, 1, "两个账号同题材只出一张表");
  assert.deepEqual(byTopic.get("游戏").map((r) => r.id), [1, 2]);
});

test("collectTopicRows：未绑定题材的账号、空行都不产出表", () => {
  const slots = [
    { envLabel: "环境A", topic: "", rows: [{ id: 1 }] },
    { envLabel: "环境B", topic: "影视", rows: [] },
    { envLabel: "环境C", topic: "游戏", rows: [{ id: 2 }] },
  ];
  const byTopic = collectTopicRows(slots);
  assert.deepEqual([...byTopic.keys()], ["游戏"]);
});

test("collectTopicRows：空输入不炸", () => {
  assert.equal(collectTopicRows([]).size, 0);
  assert.equal(collectTopicRows(null).size, 0);
  assert.equal(collectTopicRows([null]).size, 0);
});
