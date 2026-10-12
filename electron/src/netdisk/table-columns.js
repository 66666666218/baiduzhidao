"use strict";

/**
 * 资源表的**列识别**——「哪一列是名称 / 链接 / 提取码」这件事，全仓只有一个家。
 *
 * 为什么必须收敛（第 14 轮）：
 *   同一件事原本在**四处**各写了一遍，而且不是简单重复，是**三种不同算法**：
 *     · `electron/src/tasks/batch-transfer.js:254-256`（应用内主路径）
 *     · `scripts/pan-transfer-batch.js:96-98`
 *     · `scripts/pan-transfer-ui.js:91-93`（比上面两份多一个 guard）
 *     · `scripts/pan-transfer-pipeline.js:124-136`（**最成熟那份**：会按内容嗅探）
 *   前两份只按**表头关键字**认列；pipeline 那份还会看**单元格内容**
 *   （`pan.baidu.com/s/` 认链接列、`^[a-z0-9]{4}$` 认提取码列），并且把名称列
 *   从「已认出的链接/提取码列」里排除掉。
 *   后果就是同一个表格、换一个脚本跑，可能解析出**不同的列** —— 这正是本仓库
 *   被 `parseLinkCell` 四份拷贝坑过的同一类问题（那份弱拷贝把提取码列永远读成空串，
 *   整表静默跳过）。所以这里以 pipeline 那份为基准收敛，另外三处升级到它。
 *
 * 有意保留的行为：
 *   · 名称列**绝不等于**链接列 —— 否则「资源名」会直接变成那串 URL。
 *   · 真的没有可用名称列时，不静默挑一个错列，而是返回 `nameDegraded: true`，
 *     让调用方**报警告**。本仓库最大的故障形态就是"静默做错事"，这里宁可吵一点。
 *
 * ⚠️ 只认「第一行」的表头。资源表都是平表，没有多级表头。
 */

/** 名称列的表头关键字（并集，尽量多认几种） */
const NAME_HINTS = ["文件名", "名称", "资源名", "资源", "标题", "片名", "书名"];
/** 链接列的表头关键字 */
const LINK_HINTS = ["链接", "网址", "url"];
/** 提取码列的表头关键字 */
const PWD_HINTS = ["提取码", "密码", "访问码"];
/** 内容嗅探：单元格里出现分享链接的路径特征 */
const SHARE_LINK_IN_VALUE = /pan\.baidu\.com\/s\//;
/** 内容嗅探：4 位提取码（百度网盘的提取码就是 4 位、只含字母数字） */
const PWD_IN_VALUE = /^[a-z0-9]{4}$/i;

/**
 * 识别资源表的列。
 * @param {Array<object>|object} rows
 *   sheet_to_json 出来的**行数组**（取第一行当表头样本），
 *   或者**直接给一行**（`detectColumns(rows[0])` 也支持 —— 四个调用点历史上两种写法都有，
 *   签名容错比让某个调用点静默拿到空表头要好）。
 * @returns {{nameKey:string, linkKey:string, pwdKey:string, keys:string[], nameDegraded:boolean}}
 *   `nameDegraded` 为 true 表示**这张表没有可识别的名称列**（只能拿别列凑数），调用方应告警。
 */
function detectColumns(rows) {
  const firstRow = (Array.isArray(rows) ? rows[0] : rows) || {};
  const keys = Object.keys(firstRow);
  const val = (k) => String(firstRow[k] == null ? "" : firstRow[k]);
  const byHeader = (hints) => keys.find((k) => hints.some((h) => String(k).toLowerCase().includes(h)));

  // ① 先按表头关键字认
  let linkKey = byHeader(LINK_HINTS) || "";
  let pwdKey = byHeader(PWD_HINTS) || "";
  let nameKey = byHeader(NAME_HINTS) || "";

  // ② 表头没写清的，按**内容**嗅探（这是 pipeline 那份比别处强的地方）
  for (const k of keys) {
    if (!linkKey && SHARE_LINK_IN_VALUE.test(val(k))) linkKey = k;
    if (!pwdKey && k !== linkKey && PWD_IN_VALUE.test(val(k).trim())) pwdKey = k;
  }

  // ③ 链接列兜底：退到第二列、再退到第一列。
  //    必须**先**定下来，否则下面判"名称列是不是链接列"会漏判。
  if (!linkKey) linkKey = keys[1] || keys[0] || "";

  // ④ 名称列：优先"既不是链接列、也不是提取码列"的列
  if (!nameKey) nameKey = keys.find((k) => k !== linkKey && k !== pwdKey) || "";
  if (!nameKey || nameKey === linkKey) {
    // 没有干净的名称列了 —— 退到"第一个不是链接列的列"，再退到第一列
    nameKey = keys.find((k) => k !== linkKey && k !== pwdKey)
      || keys.find((k) => k !== linkKey)
      || keys[0] || "";
  }
  // 降级 = 最终这个"名称列"要么不存在、要么其实就是链接列/提取码列。
  // 这三种情况下资源名都不会是真正的资源名，调用方应当告警。
  const nameDegraded = !nameKey || nameKey === linkKey || nameKey === pwdKey;

  return { nameKey, linkKey, pwdKey, keys, nameDegraded };
}

module.exports = { detectColumns, NAME_HINTS, LINK_HINTS, PWD_HINTS };
