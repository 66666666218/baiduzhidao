"use strict";

/**
 * 网盘主资源库共享模块：pan-crawl-batch / panlay-collect 共用的存储与质量门槛。
 *   - 主库：运行缓存/pan-resources-master.jsonl（追加式，崩溃不丢）
 *   - 去重：链接索引（跨次、跨来源）
 *   - 导出：两列表 xlsx（星链 SOP 1.1 输入格式 → pan-to-qa.js）
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const cacheDir = path.join(root, "运行缓存");
const masterJsonl = path.join(cacheDir, "pan-resources-master.jsonl");

// ---------- 质量预过滤（与 pan-to-qa 门槛一致） ----------
const AD_PATTERNS = /微信号|加微信|VX[:：]?|公众号|二维码|代下|有偿|收费|付费获取|联系QQ|加群|引流|广告|www\./i;
const BANNED_EXT = /\.(zip|rar|7z|tar|gz)$/i;
// UI 杂质：换行/提取码按钮文案/日期戳/链接碎片（DOM 抓取遗留物）
const JUNK_PATTERNS = /[\r\n]|提取码|复制$|\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}(:\d{2})?|pwd=|[A-Za-z0-9_-]{8,}\?| {2,}/;
function preFilter(name) {
  const n = String(name || "").trim();
  if (!n || n.length < 4) return "名称过短";
  if (n.length > 60) return "名称过长（疑似多资源粘连）";
  if (AD_PATTERNS.test(n)) return "含广告/引流";
  if (BANNED_EXT.test(n)) return "压缩包";
  if (JUNK_PATTERNS.test(n)) return "名称含UI杂质";
  return "";
}

// ---------- 链接索引与入库 ----------
function loadLinkIndex() {
  const index = new Set();
  try {
    const lines = fs.readFileSync(masterJsonl, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try { index.add(JSON.parse(line).url); } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 首次运行无文件 */ }
  return index;
}

/**
 * 入库一条资源（调用方已用 loadLinkIndex 去重后）。
 * @returns {Set} 传入的 index（便于链式更新）
 */
function appendResource(index, { name, url, pwd, source, kw }) {
  fs.appendFileSync(masterJsonl, JSON.stringify({
    name, url, pwd, source: source || "", kw: kw || "", at: new Date().toISOString(),
  }) + "\n");
  index.add(url);
  return index;
}

/** 导出两列表（网盘内容名称 | 网盘链接（含提取码））。 */
function exportXlsx(outFile) {
  const rows = [];
  try {
    for (const line of fs.readFileSync(masterJsonl, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        rows.push({ "网盘内容名称": r.name, "网盘链接（含提取码）": `${r.url} 提取码: ${r.pwd}` });
      } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 无数据 */ }
  if (!rows.length) return 0;
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "资源表");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  XLSX.writeFile(wb, outFile);
  return rows.length;
}

module.exports = { cacheDir, masterJsonl, preFilter, loadLinkIndex, appendResource, exportXlsx };
