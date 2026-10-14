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
 * 支持的输入形态（实测资源表里都出现过；★ 是 2026-10-14 补的，见下面注释）：
 *   · "https://pan.baidu.com/s/1AbCdEf?pwd=abcd"
 *   · "https://pan.baidu.com/s/1AbCdEf 提取码: abcd"
 *   · "链接 https://pan.baidu.com/s/1AbCdEf 密码：abcd"
 *   · ★ "https://pan.baidu.com/s/1AbCdEf abcd"        ← 链接后**空格 + 四位码**（没有"提取码"三个字）
 *   · ★ "https://pan.baidu.com/share/init?surl=AbCdEf abcd"
 *   · 单元格里混着广告文案，链接和码夹在中间
 *
 * ⚠️ 提取码**必须原样返回、不做大小写转换**：百度提取码区分大小写，
 *    这里 toLowerCase 会让"链接不带码 + 码列是 ABCD"的行拼出 `?pwd=abcd` 而打不开分享。
 *
 * ── ★ 为什么补那两种形态（2026-10-14，用户第二轮反馈「按表格批量转存，一行一个链接」）──
 * 用户说的"一行一个链接"就是同行开源工具的标准用法。查了同类开源项目
 * `hakureiholo/BaiduPanFilesTransfers`（GPL-3.0，专做百度网盘批量转存）的 README，
 * 它列的输入示例里 **"链接 + 空格 + 四位码"** 和 **`/share/init?surl=…`** 都在支持列表里，
 * 而这两条我们原来都不认：
 *   · "…/s/1AbCdEf 6img"  → 旧代码只认带 `pwd=` 或带「提取码/密码/访问码」标签的，
 *     于是这一行**提取码读成空** → 下游 `if (!link || !cellPwd) continue;` 把整行跳过。
 *     用户看到的是一行"缺链接或提取码，跳过"，但他明明把码写在上面了。
 *   · "…/share/init?surl=AbCdEf" → 旧正则只认 `/s/`，整个链接都读不出来。
 *     这个形态在百度自己的流程里就是标准的一环（本仓库 verify 打的就是
 *     `${PAN}/share/init?surl=<surl>`），而且 `surl` 正好是分享码去掉开头那个 `1`
 *     —— 也就是 `processOne` 里 `const surl = fullCode.slice(1)` 的逆运算，
 *     所以可以安全地还原成 `/s/1<code>`。**不认识的链接一律不猜**（宁可读不出来报错，
 *     也不要猜错之后发一堆无效请求）。
 */

// 支持 http/https、s/ 后 1 开头（新式分享码），可带 ?pwd=xxxx
const SHARE_LINK_RE = /https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i;
// `share/init?surl=<surl>` 形态（surl = 分享码去掉开头的 1）。只认这一种，别的一律不猜。
const INIT_LINK_RE = /https?:\/\/pan\.baidu\.com\/share\/init\?surl=([\w-]+)/i;
// 链接自带的提取码
const URL_PWD_RE = /[?&]pwd=([a-z0-9]{4})/i;
// 单元格里以「提取码/密码/访问码」标签写出的提取码（中英文冒号、空格、换行都认）
const LABEL_PWD_RE = /(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i;
/**
 * 链接**后面紧跟**的四位码（`…/s/1AbCdEf 6img`），要求：
 *   · 只能在链接结束处往后匹配（靠调用处切片实现），不是一个随便出现的四位串；
 *   · 中间只允许空白/逗号/分号/竖线；
 *   · 后面必须**不是**字母数字 —— 否则 `https://…` 里的 `http` 会被当成码
 *     （`(?![A-Za-z0-9])` 让 `https` 在第 5 个字符处失败），`12345` 这种五位串也不会被截成四位。
 */
const BARE_PWD_RE = /^[\s,，;；|]*([A-Za-z0-9]{4})(?![A-Za-z0-9])/;

function parseLinkCell(text) {
  const s = String(text || "");
  let link = (s.match(SHARE_LINK_RE) || [])[0] || "";
  let tail = "";
  if (link) {
    tail = s.slice(s.indexOf(link) + link.length);
  } else {
    // `share/init?surl=<surl>` → 还原成规范的 `/s/1<surl>`（本仓库 verify 用的就是这个 surl）
    const init = s.match(INIT_LINK_RE);
    if (init) {
      link = `https://pan.baidu.com/s/1${init[1]}`;
      tail = s.slice(s.indexOf(init[0]) + init[0].length);
    }
  }
  let pwd = (s.match(URL_PWD_RE) || [])[1] || "";
  if (!pwd) pwd = (s.match(LABEL_PWD_RE) || [])[1] || "";
  if (!pwd) pwd = (tail.match(BARE_PWD_RE) || [])[1] || "";
  return { link, pwd };
}

module.exports = { parseLinkCell, SHARE_LINK_RE, INIT_LINK_RE, BARE_PWD_RE };
