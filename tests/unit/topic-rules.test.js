"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_TOPIC_RULES,
  parseTopicRules,
  keywordMatches,
  classifyByRules,
  groupRowsByRules,
} = require("../../electron/src/domain/topic-rules");

const rules = parseTopicRules(DEFAULT_TOPIC_RULES);

// ---------- 规则解析 ----------

test("parseTopicRules：解析「分类名=关键词|关键词」，顺序保持", () => {
  const parsed = parseTopicRules("游戏=游戏|手游\n影视=电影|剧集");
  assert.deepEqual(parsed, [
    { name: "游戏", keywords: ["游戏", "手游"] },
    { name: "影视", keywords: ["电影", "剧集"] },
  ]);
});

test("parseTopicRules：忽略空行与注释行，容忍全角分隔符", () => {
  const parsed = parseTopicRules("# 注释\n\n// 也是注释\n软件＝安卓｜app\n");
  assert.deepEqual(parsed, [{ name: "软件", keywords: ["安卓", "app"] }]);
});

test("parseTopicRules：没有竖线时退回逗号/顿号分隔", () => {
  assert.deepEqual(parseTopicRules("音乐=歌曲,专辑、无损"), [{ name: "音乐", keywords: ["歌曲", "专辑", "无损"] }]);
});

test("parseTopicRules：坏行跳过而不是抛错（设置页允许随手粘贴）", () => {
  const parsed = parseTopicRules("没有等号\n=没有分类名\n分类=\n正常=关键词");
  assert.deepEqual(parsed, [{ name: "正常", keywords: ["关键词"] }]);
});

test("parseTopicRules：空/非法输入返回空数组", () => {
  assert.deepEqual(parseTopicRules(""), []);
  assert.deepEqual(parseTopicRules(null), []);
  assert.deepEqual(parseTopicRules(undefined), []);
});

// ---------- 分类 ----------

test("classifyByRules：八大分类各命中一条", () => {
  const cases = [
    ["《黑神话悟空》游戏本体下载", "游戏"],
    ["《流浪地球》电影1080p高清完整版", "影视"],
    ["三体全集小说txt电子书", "小说"],
    ["海贼王漫画全集", "漫画"],
    ["周杰伦专辑flac无损音乐", "音乐"],
    ["考研数学网课教程", "课程"],
    ["Photoshop 绿色版软件下载", "软件"],
    ["PPT模板素材资源合集", "资料"],
  ];
  for (const [text, want] of cases) {
    assert.equal(classifyByRules(text, rules), want, `${text} 应归入 ${want}`);
  }
});

test("classifyByRules：顺序敏感，先命中先分类", () => {
  // 「游戏」规则在前，即使标题里也有「电影」也归游戏
  assert.equal(classifyByRules("游戏改编电影合集", rules), "游戏");
  const reversed = parseTopicRules("影视=电影\n游戏=游戏");
  assert.equal(classifyByRules("游戏改编电影合集", reversed), "影视", "调换顺序后结果随之改变");
});

test("classifyByRules：都未命中返回空串", () => {
  assert.equal(classifyByRules("一个完全无法归类的标题", rules), "");
  assert.equal(classifyByRules("", rules), "");
  assert.equal(classifyByRules(null, rules), "");
});

test("classifyByRules：可直接传规则文本，不必先 parse", () => {
  assert.equal(classifyByRules("某电影资源", "影视=电影"), "影视");
});

test("keywordMatches：短英文关键词按词边界匹配，不误伤更长单词", () => {
  // 子串匹配会让这些全部误判：app→apple/happy、mod→model/modeling、ape→shape/tape、wav→wave
  assert.equal(keywordMatches("happy apple modeling shape tape", "app"), false);
  assert.equal(keywordMatches("happy apple modeling shape tape", "mod"), false);
  assert.equal(keywordMatches("happy apple modeling shape tape", "ape"), false);
  assert.equal(keywordMatches("happy apple modeling shape tape", "wav"), false);
  // 真词仍然命中
  assert.equal(keywordMatches("一个app资源", "app"), true);
  assert.equal(keywordMatches("上古卷轴mod合集", "mod"), true);
  assert.equal(keywordMatches("无损flac格式", "flac"), true);
});

test("keywordMatches：中文关键词按子串匹配（不存在词边界问题）", () => {
  assert.equal(keywordMatches("高清电影集合", "电影"), true);
  assert.equal(keywordMatches("非电影类内容", "电影"), true);
});

test("classifyByRules：大小写不敏感", () => {
  assert.equal(classifyByRules("Android 客户端", rules), "软件");
  assert.equal(classifyByRules("某资源 4K 修复版", rules), "影视");
});

test("groupRowsByRules：按题材分桶，未命中归入空串桶", () => {
  const rows = [
    { 问题标题: "某电影资源" },
    { 问题标题: "某游戏资源" },
    { 问题标题: "无法归类" },
  ];
  const buckets = groupRowsByRules(rows, rules);
  assert.equal(buckets.get("影视").length, 1);
  assert.equal(buckets.get("游戏").length, 1);
  assert.equal(buckets.get("").length, 1);
});

test("groupRowsByRules：默认取「问题标题」，可用 pickText 自定义", () => {
  const rows = [{ 问题标题: "无法归类", 资源名: "某电影" }];
  assert.equal(groupRowsByRules(rows, rules).get("").length, 1);
  assert.equal(groupRowsByRules(rows, rules, (r) => r.资源名).get("影视").length, 1);
});
