"use strict";

/**
 * 转存台账（`state.jsonl`）的读写——**断点续跑的凭据**，全仓只有一个家。
 *
 * 为什么必须收敛（第 14 轮）：
 *   同一个「逐行追加 JSON、读回来按某个键去重」的逻辑原本有 **5 份**：
 *     · `electron/src/tasks/batch-transfer.js:333-342`（内联）
 *     · `scripts/pan-transfer-batch.js:70-80`
 *     · `scripts/pan-transfer-ui.js:65-75`
 *     · `scripts/pan-transfer-pipeline.js:97-107`
 *     · `scripts/netdisk-share-existing.js:35-48`
 *   它们**不是完全一样**——去重键不同，而这一点很容易被后来的改动抹掉：
 *     · 转存类用 `srcLink`（按**来源分享链接**去重：同一资源换多少条链接都只转一次）
 *     · `netdisk-share-existing.js` 用 `srcPath`（它不转存，是对**网盘里已存在的路径**建分享）
 *   这份差异是**有意的**，所以这里把它做成显式参数，而不是让某个人顺手"统一"掉、
 *   把按路径去重悄悄改成按链接去重（那是静默行为变更，跑批里看不出来）。
 *
 * 另一个容易踩的点：**追加写不是「重写」**。台账是 append-only 的事件流，
 * 同一条记录会随阶段推进反复追加（pending → transferred → done），读回来时
 * **后写的覆盖先写的**（`Map.set` 天然如此）。所以任何人和任何地方都不要再
 * 「先读整个文件再写回」，那会把历史事件挤掉、断点续跑直接失效。
 *
 * 消费者：`electron/src/netdisk/manager.js` 的 `transferRecords()` 会扫各管线的
 * `state.jsonl` 做聚合，它同时接受 `srcLink` 与 `srcPath` —— 改键名要同步看那里。
 */

const fs = require("fs");
const path = require("path");

/**
 * 读台账。
 * @param {string} stateFile `state.jsonl` 的完整路径
 * @param {string} keyField  去重键字段名（`srcLink` / `srcPath`）
 * @returns {Map<string, object>} 键 → 该条**最新**的记录
 */
function loadLedger(stateFile, keyField) {
  const map = new Map();
  let text = "";
  try {
    text = fs.readFileSync(stateFile, "utf8");
  } catch {
    return map; // 首次运行：文件还不存在，属于正常
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // 单行损坏只跳这一行，不影响整份台账
    if (rec && rec[keyField] !== undefined) map.set(rec[keyField], rec);
  }
  return map;
}

/**
 * 追加一条记录。**只 append，绝不重写整个文件**（见文件头注释）。
 * @param {string} stateFile `state.jsonl` 的完整路径
 * @param {object} entry     记录（必须自带 keyField 对应的字段，否则下次读不回来）
 */
function appendLedger(stateFile, entry) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.appendFileSync(stateFile, `${JSON.stringify(entry)}\n`);
}

module.exports = { loadLedger, appendLedger };
