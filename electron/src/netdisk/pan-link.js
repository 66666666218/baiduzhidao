"use strict";

/**
 * 从「资源表的一格文本」里抠出百度网盘分享链接 + 提取码。
 *
 * 为什么单独成一个模块：这段逻辑在本仓库里曾有**四份逐字拷贝** ——
 *   electron/src/tasks/batch-transfer.js
 *   scripts/pan-transfer-batch.js
 *   scripts/pan-transfer-pipeline.js
 *   scripts/pan-transfer-ui.js
 * 而其中一份（pan-transfer-ui.js）已经因为"拷贝时漏改"踩了坑：
 *   它把拼接写成了 `+ (pwdKey ? "" : "")` —— 两个分支都是空串，
 *   于是**提取码列永远读不到**，而下游 `if (!cellPwd) continue;` 会把整张表**静默**跳过。
 *   表现是「成功 0 | 失败 0」且一条日志都没有。
 * 「一份逻辑只有一个家」是本仓库的既定约定（同 domain/account-topic.js 的 dedupeEnvLabels），
 * 这里对齐 —— 谁再要改提取码的识别规则，只改这一个文件。
 *
 * 支持的输入形态（实测资源表里都出现过）：
 *   · "https://pan.baidu.com/s/1AbCdEf?pwd=abcd"
 *   · "https://pan.baidu.com/s/1AbCdEf 提取码: abcd"
 *   · "链接 https://pan.baidu.com/s/1AbCdEf 密码：abcd"
 *   · 单元格里混着广告文案，链接和码夹在中间
 *
 * ⚠️ 提取码**必须原样返回、不做大小写转换**：百度提取码区分大小写，
 *    这里 toLowerCase 会让"链接不带码 + 码列是 ABCD"的行拼出 `?pwd=abcd` 而打不开分享。
 */

// 支持 http/https、s/ 后 1 开头（新式分享码），可带 ?pwd=xxxx
const SHARE_LINK_RE = /https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i;
// 链接自带的提取码
const URL_PWD_RE = /[?&]pwd=([a-z0-9]{4})/i;
// 单元格里以「提取码/密码/访问码」标签写出的提取码（中英文冒号、空格、换行都认）
const LABEL_PWD_RE = /(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i;

function parseLinkCell(text) {
  const s = String(text || "");
  const link = (s.match(SHARE_LINK_RE) || [])[0] || "";
  let pwd = (s.match(URL_PWD_RE) || [])[1] || "";
  if (!pwd) pwd = (s.match(LABEL_PWD_RE) || [])[1] || "";
  return { link, pwd };
}

module.exports = { parseLinkCell, SHARE_LINK_RE };
