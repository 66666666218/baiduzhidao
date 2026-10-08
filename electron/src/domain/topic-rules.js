"use strict";

/**
 * 关键词分类规则（题材派生，v2.2）。
 *
 * 规则文本每行一条：「分类名=关键词1|关键词2|...」
 * 匹配语义（用户口径）：按**从上到下**的顺序逐条尝试，**先命中先分类**；全部未命中返回 ""。
 *
 * 用途：上传到答主工作台时，用问题标题/资源名派生题材，把表按题材切成各账号的份。
 */

/**
 * 默认规则（来自用户提供的分类表）。
 * 顺序敏感：例如"游戏改编电影"会先命中「游戏」而不是「影视」。
 */
const DEFAULT_TOPIC_RULES = [
  "游戏=游戏|手游|端游|单机游戏|主机游戏|游戏模拟器|玩法|通关|存档|mod|游戏本体|游戏补丁|游戏破解版|修改器",
  "影视=电影|电视剧|剧集|连续剧|综艺|纪录片|影视|短剧|动画片|真人秀|蓝光|字幕组|1080p|2160p|4k",
  "小说=小说|网文|文学作品|电子书|有声小说|全集小说|txt|epub|mobi|azw3",
  "漫画=漫画|漫本|条漫|画集|绘本",
  "音乐=音乐|歌曲|专辑|无损|演唱会|歌单|mp3|flac|ape|wav",
  "课程=课程|教程|网课|教学视频|学习资料|培训资料|讲义|考研|考证",
  "软件=软件|应用程序|安卓|android|app|客户端|工具类|实用工具|绿色版|便携版|激活版|破解版软件",
  "资料=素材|模板|文档|资料包|题库|课件|源码|资源合集|字体|插件|模型",
].join("\n");

/** 纯 ASCII 字母数字的关键词（app / mod / ape / 4k …） */
const ASCII_KEYWORD = /^[A-Za-z0-9]+$/;

/**
 * 解析规则文本 → [{ name, keywords }]
 * - 忽略空行与 `#` 开头（含 `//`）的注释行
 * - 分隔符支持 `|` / `｜`；整行没有竖线时退回 `,` / `，` / `、`
 * - 无等号、分类名为空、关键词为空的行直接跳过（设置页允许随手粘贴，解析不应抛错）
 */
function parseTopicRules(text) {
  const rules = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const eq = line.search(/[=＝:：]/);
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const tail = line.slice(eq + 1);
    const separators = /[|｜]/.test(tail) ? /[|｜]/ : /[,，、]/;
    const keywords = tail.split(separators).map((k) => k.trim()).filter(Boolean);
    if (name && keywords.length) rules.push({ name, keywords });
  }
  return rules;
}

/**
 * ASCII 关键词按词边界匹配，其余按子串匹配。
 *
 * 为什么不是一律子串：规则里有 `app` / `mod` / `ape` / `wav` 这类短英文词，
 * 子串匹配会让 `app` 命中 "apple"、`ape` 命中 "shape"、`mod` 命中 "model"，
 * 把资源分到完全不相干的题材里。中文关键词不存在词边界问题，保持子串。
 */
function keywordMatches(haystack, keyword) {
  if (!ASCII_KEYWORD.test(keyword)) return haystack.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(haystack);
}

/**
 * 按规则给文本分类。rules 可以是解析好的数组，也可以是规则文本。
 * 返回命中的分类名；全部未命中返回 ""。
 */
function classifyByRules(text, rules) {
  const haystack = String(text || "").toLowerCase();
  if (!haystack.trim()) return "";
  const list = Array.isArray(rules) ? rules : parseTopicRules(rules);
  for (const rule of list) {
    for (const keyword of rule.keywords) {
      if (keywordMatches(haystack, keyword.toLowerCase())) return rule.name;
    }
  }
  return "";
}

/** 批量分类：返回 { topic: rows[] }（未命中的归入 "" 桶） */
function groupRowsByRules(rows, rules, pickText) {
  const list = Array.isArray(rules) ? rules : parseTopicRules(rules);
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = typeof pickText === "function" ? pickText(row) : String((row || {}).问题标题 || (row || {}).title || "");
    const topic = classifyByRules(text, list);
    if (!buckets.has(topic)) buckets.set(topic, []);
    buckets.get(topic).push(row);
  }
  return buckets;
}

module.exports = {
  DEFAULT_TOPIC_RULES,
  ASCII_KEYWORD,
  parseTopicRules,
  keywordMatches,
  classifyByRules,
  groupRowsByRules,
};
