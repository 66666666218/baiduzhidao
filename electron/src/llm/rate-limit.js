"use strict";

/**
 * 供应商 429 的**两种含义** —— 处理方式完全相反，混为一谈会白白烧掉整批。
 *
 * ① 速率限制（transient）：「这一秒太密了，慢一点」。
 *    → 退避重试是对的（几秒到一分钟内就会恢复）。
 *
 * ② 配额用尽（quota）：供应商会在响应正文里**明说重置时间**。
 *    用户 2026-10-15 实际撞到的那条原文：
 *    「429 您的使用量已超出频率限制，将在 2026-10-15 15:35:22 UTC+8 重置，
 *      您也可以切换其他模型继续使用。」
 *    → **重试毫无意义**：重置时间在**几小时之后**，而整套退避梯加起来才约 60 秒，
 *      等不到。64 并发下更糟：64 条 × 6 次 = 384 次注定失败的请求，
 *      既把额度窗口拖得更久，又让用户盯着满屏失败。
 *    → 正确做法：**立刻停手**，把「什么时候恢复」和「怎么立刻继续（换模型）」说清楚。
 *
 * 判据只认正文里的「将在 … 重置」—— 这是供应商自己给的时间，最可靠、且人能直接读；
 * 再辅以配额类关键词兜底。**宁可判成②**（早停 + 明确告知），
 * **也别判成①**（闷头重试到整批跑完，用户只知道「全失败了」却不知道要等到几点）。
 */

/** 匹配「将在 2026-10-15 15:35:22 UTC+8 重置」，捕获中间那段人能读的时刻 */
const RESET_HINT_RE = /将在\s*([^，,。;；]+?)\s*重置/;
/** 配额类关键词兜底：有些供应商只说额度用尽、不给时间 */
const QUOTA_HINT_RE = /使用量已超出|配额|额度|余额|quota|exhausted|insufficient/i;

/**
 * 区分一次 429 是「慢一点」还是「配额用尽」。
 *
 * @param {string} message 供应商返回的报错正文
 * @returns {{ quotaExhausted: boolean, resetText: string }} resetText 是「2026-10-15 15:35:22 UTC+8」这种原样时刻，判不出来时为空串
 */
function classifyRateLimit(message) {
  const text = String(message || "");
  const resetMatch = text.match(RESET_HINT_RE);
  const resetText = resetMatch ? String(resetMatch[1]).trim() : "";
  // 有明确重置时间 → 必然是配额用尽（速率限制不会给你一个几小时后的时刻）
  return { quotaExhausted: Boolean(resetText) || QUOTA_HINT_RE.test(text), resetText };
}

/**
 * 配额用尽之后，剩下的条目还跑不跑。
 *
 * 答案是**不跑**：生成阶段除了拿 AI 回答之外没有别的产品，
 * 继续跑只是把后面的题目一条条送进同一个 429，用户要等到整批跑完才知道白等了。
 * （对照：网盘那个「每日 300 分享额度」我们**刻意不自动停** —— 那种情况下
 *   转存本身仍然成立，用户可能本来就只要「存进自己网盘」。两者的判据是
 *   「剩下的条目还有没有别的产品」。）
 *
 * ⚠️ 这里只回答"要不要立刻停"，**不替用户决定之后怎么办** —— 那件事由日志里的
 *   两个选项交回给他：等到重置时间 / 换模型立刻继续。
 *
 * @param {{ quotaExhausted?: boolean, remaining?: number }} input
 * @returns {{ stop: boolean, remaining: number }}
 */
function planQuotaStop(input = {}) {
  const remaining = Math.max(0, Math.floor(Number(input.remaining) || 0));
  if (!input.quotaExhausted) return { stop: false, remaining };
  return { stop: true, remaining };
}

module.exports = { classifyRateLimit, planQuotaStop, RESET_HINT_RE, QUOTA_HINT_RE };
