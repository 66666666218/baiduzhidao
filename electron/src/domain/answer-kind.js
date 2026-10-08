"use strict";

/**
 * 答案形态判定（v2.2）：区分「带链接的答案」与「纯文本答案」。
 *
 * 为什么要分：
 *   带链接的答案（网盘资源类）在平台上属于营销性质，风险远高于普通答题，
 *   提交时必须走「账号 ↔ 题材 严格一对一」路由（见 domain/account-topic.js）；
 *   纯文本答案用于前期积累通过数/额度，可以跨题材宽松轮询。
 *
 * 判定取保守口径：拿不准就算「带链接」，宁可走严格路由，也不让链接答案
 * 落到不受题材约束的账号上。
 */

/** 常见网盘域名（与 netdisk/qa-template-lib.js 产出的链接形态对齐） */
const NETDISK_HOSTS = [
  "pan.baidu.com",
  "pan.quark.cn",
  "alipan.com",
  "aliyundrive.com",
  "cloud.189.cn",
  "caiyun.139.com",
  "115.com",
  "123pan.com",
  "lanzou",
  "weiyun.com",
  "drive.uc.cn",
];

// 题目原文里链接常紧跟中文标点，正则需要把它们排除在 URL 之外
const URL_PATTERN = /https?:\/\/[^\s，。；、）)】》"'<>]+/gi;
/** 提取码/密码：有提取码基本可断定这条答案是为链接服务的 */
const PWD_PATTERN = /(?:提取码|访问码|密码|pwd)\s*[:：=]?\s*[a-zA-Z0-9]{4}/i;

/** 抽出文本里的全部 http(s) 链接（去掉尾部标点） */
function extractUrls(text) {
  const matches = String(text || "").match(URL_PATTERN);
  if (!matches) return [];
  return matches.map((url) => url.replace(/[.,;、。]+$/, ""));
}

function isNetdiskUrl(url) {
  const lower = String(url || "").toLowerCase();
  return NETDISK_HOSTS.some((host) => lower.includes(host));
}

/** 含任意 http(s) 链接 */
function hasAnyLink(text) {
  return extractUrls(text).length > 0;
}

/** 含网盘链接 */
function hasNetdiskLink(text) {
  return extractUrls(text).some(isNetdiskUrl);
}

/**
 * 行 → "link" | "plain"
 * 判定范围覆盖回答正文、复制用答案（模板拼接后的成品，链接常常只在这里）。
 */
function classifyAnswerKind(item) {
  const source = item || {};
  const text = [source.answer, source.copyText, source.copyAnswer, source.回答内容, source.复制用答案]
    .map((part) => String(part || ""))
    .join("\n");
  if (!text.trim()) return "plain";
  if (hasNetdiskLink(text)) return "link";
  if (hasAnyLink(text)) return "link";
  if (PWD_PATTERN.test(text)) return "link";
  return "plain";
}

/** 批量分类，返回 { link: [], plain: [] } */
function splitRowsByKind(rows) {
  const link = [];
  const plain = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    (classifyAnswerKind(row) === "link" ? link : plain).push(row);
  }
  return { link, plain };
}

module.exports = {
  NETDISK_HOSTS,
  extractUrls,
  isNetdiskUrl,
  hasAnyLink,
  hasNetdiskLink,
  classifyAnswerKind,
  splitRowsByKind,
};
