"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { pickTitleKey, pickTopicColumn, safeFileToken } = require("../../electron/src/tasks/upload-batch");

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

test("pickTopicColumn：只认「一级分类」/「备注」这两个已存在的列", () => {
  assert.equal(pickTopicColumn(["qid", "问题标题", "一级分类", "回答内容"]), "一级分类");
  assert.equal(pickTopicColumn(["qid", "问题标题", "备注"]), "备注");
});

test("pickTopicColumn：没有分类列时返回空串——绝不新增列", () => {
  // 上传模板是平台约定的，凭空多一列可能整批被拒收
  assert.equal(pickTopicColumn(["qid", "问题标题", "回答内容"]), "");
  assert.equal(pickTopicColumn(["二级分类"]), "", "二级分类不是写回目标");
});

test("safeFileToken：账号名里的路径非法字符被净化", () => {
  assert.equal(safeFileToken("测试/组*1:号"), "测试_组_1_号");
  assert.equal(safeFileToken(""), "account", "空名回退到默认，避免生成 .xlsx 这种隐藏文件");
  assert.equal(safeFileToken("a".repeat(80)).length, 40, "超长截断，避免路径过长");
});
