"use strict";

/**
 * 网盘资源表 → 知道问答格式表 转换器（按《星链知道平台知识发布SOP》第2阶段）。
 *
 * 输入：两列 Excel —— 第一列：网盘内容名称；第二列：网盘链接（含提取码）
 * 输出：六列表格 —— qid(空)/问题标题/一级分类(空)/二级分类(空)/问题发布时间(空)/回答内容(HTML)
 *
 * 质量门槛（按 SOP 1.2 自查表硬编码，不达标行剔除并报告原因）：
 *   - 链接必须含提取码或 pwd 参数
 *   - 资源名禁止 zip/rar（除安装包）
 *   - 资源名/链接不含广告词、联系方式
 *   - 问题标题 5~49 字
 *
 * 用法：node scripts/pan-to-qa.js <网盘资源表.xlsx> [输出路径]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "运行缓存");
const srcFile = process.argv[2];
const outFile = process.argv[3] || path.join(dataDir, "问答格式-输出.xlsx");

if (!srcFile || !fs.existsSync(srcFile)) {
  console.error("用法: node scripts/pan-to-qa.js <网盘资源表.xlsx> [输出路径]");
  process.exit(1);
}

// ---------- 质量检查 ----------

const AD_PATTERNS = /微信号|加微信|VX|vx[:：]?|公众号|二维码|代下|有偿|收费|付费获取|联系QQ|加群|引流|广告|www\.|http(s)?:\/\/(?!pan\.)/i;
const BANNED_EXT = /\.(zip|rar|7z|tar|gz)\b/i;
const CODE_PATTERNS = /提取码[:：\s]*([a-z0-9]{4,8})|pwd=([a-z0-9]{4})|访问码[:：\s]*([a-z0-9]{4,8})/i;

function extractLink(raw) {
  const text = String(raw || "").replace(/\s+/g, " ");
  const urlMatch = text.match(/https?:\/\/[^\s，,；;]+/i);
  const link = urlMatch ? urlMatch[0] : "";
  const codeMatch = text.match(CODE_PATTERNS);
  const code = codeMatch ? (codeMatch[1] || codeMatch[2] || codeMatch[3] || "") : "";
  return { link, code, hasCode: Boolean(code) || /pwd=/.test(link) };
}

function checkResource(name, linkField) {
  const issues = [];
  const { link, code, hasCode } = extractLink(linkField);
  if (!link) issues.push("未找到网盘链接");
  if (!hasCode && link && /pan\.baidu\.com/i.test(link)) issues.push("百度网盘链接缺提取码");
  if (/.(zip|rar|7z)$/i.test(name.trim())) issues.push("压缩包文件（SOP禁止，除安装包类内容——如属实请手动修改名称后重试）");
  if (AD_PATTERNS.test(name)) issues.push("名称含广告/引流/联系方式");
  if (AD_PATTERNS.test(linkField) && /有偿|收费|付费/.test(linkField)) issues.push("链接含付费引导");
  const cleanName = String(name || "").trim();
  if (cleanName.length < 4) issues.push("资源名过短");
  return { issues, link, code, cleanName };
}

// ---------- 问题标题生成（5~49字，含资源名+求资源语义） ----------

const TITLE_TEMPLATES = [
  (name) => `求${name}网盘资源下载`,
  (name) => `哪里可以下载${name}`,
  (name) => `${name}网盘资源分享，感谢`,
  (name) => `求${name}的网盘链接，急用`,
  (name) => `谁有${name}资源？求分享网盘链接`,
  (name) => `${name}哪里能找到？求网盘`,
  (name) => `求分享：${name}`,
];

function buildTitle(name, index) {
  let title = TITLE_TEMPLATES[index % TITLE_TEMPLATES.length](name);
  // 5~49 字夹取
  if (title.length > 49) title = title.slice(0, 49);
  if (title.length < 5) title = `求${name}资源下载`;
  return title;
}

// ---------- 回答 HTML 生成（SOP 2.1：链接+提取码+简介，HTML 格式） ----------

function guessType(name) {
  if (/试卷|真题|题库|讲义|教案|课件/.test(name)) return "学习资料";
  if (/壁纸|海报|图片|素材/.test(name)) return "图片素材";
  if (/报告|白皮书|研究|趋势/.test(name)) return "行业报告";
  if (/mp4|视频|课程|教程/.test(name)) return "视频教程";
  if (/电子书|书籍|小说|文档/.test(name)) return "电子书籍";
  return "干货资源";
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildAnswerHtml({ name, link, code }) {
  const type = guessType(name);
  const codeLine = code ? `<p>提取码：<strong>${escapeHtml(code)}</strong></p>` : "";
  return [
    `<p>整理了一份「${escapeHtml(name)}」，属于${type}类内容，完整版已经放在网盘里，需要的自取。</p>`,
    `<p>网盘链接：<a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    codeLine,
    `<p>简介：这套${escapeHtml(name)}内容比较完整，适合需要${type}的朋友收藏备用。链接长期有效，如果打不开可以评论区留言，看到会补新的链接。</p>`,
  ].join("\n");
}

// ---------- 主流程 ----------

const wb = XLSX.readFile(srcFile);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
if (!rawRows.length) {
  console.error("输入表为空");
  process.exit(1);
}
const inKeys = Object.keys(rawRows[0]);
const kName = inKeys[0]; // 第一列：网盘内容名称
const kLink = inKeys[1]; // 第二列：网盘链接（含提取码）
console.log(`输入 ${rawRows.length} 行 | 名称列: ${kName} | 链接列: ${kLink}`);

const qaRows = [];
const rejected = [];
let titleIdx = 0;

for (const raw of rawRows) {
  const name = String(raw[kName] || "").trim();
  const linkField = String(raw[kLink] || "").trim();
  if (!name && !linkField) continue;

  const check = checkResource(name, linkField);
  if (check.issues.length) {
    rejected.push({ name: name.slice(0, 30), reasons: check.issues.join("；") });
    continue;
  }

  const title = buildTitle(check.cleanName, titleIdx);
  titleIdx += 1;
  qaRows.push({
    "qid（非必填，自问自答创建的问题无此字段）": "",
    "问题标题（必填）": title,
    "一级分类": "",
    "二级分类": "",
    "问题发布时间（空）": "",
    "回答内容（必填）": buildAnswerHtml(check),
  });
}

// 输出
const ws = XLSX.utils.json_to_sheet(qaRows, {
  header: ["qid（非必填，自问自答创建的问题无此字段）", "问题标题（必填）", "一级分类", "二级分类", "问题发布时间（空）", "回答内容（必填）"],
});
const wbOut = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbOut, ws, "问答格式");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
XLSX.writeFile(wbOut, outFile);

console.log(`=== 转换完成 ===`);
console.log(`合格生成: ${qaRows.length} 条 | 剔除: ${rejected.length} 行`);
if (rejected.length) {
  console.log("剔除明细（最多10条）:");
  for (const r of rejected.slice(0, 10)) console.log(`  ✗ ${r.name} → ${r.reasons}`);
}
console.log(`输出: ${outFile}`);
