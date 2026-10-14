"use strict";

/**
 * 「重跑时，一条 `share_failed` 的历史台账该怎么处理？」—— 全仓唯一一处判断。
 *
 * 背景（不收敛就会**静默烧请求**）：转存成功 ≠ 分享成功，分享是**独立失败域**。
 * 撞上单账号每日 300 分享上限、或该资源被百度禁止二次分享，都会记成 `status:"share_failed"`，
 * 但文件**其实已经躺在网盘里了**，台账里也确实存了 `toPaths`。
 * 而三条链路（纯协议 / 浏览器执行器 / 真 UI 点击）原来都只认
 * `status === "done" && ownLink` 才算"这条不用再跑" —— 于是 share_failed 的行每一轮都被重新转存：
 *   · 转存接口必然回 errno=4（已转存过）走复用路径 —— 白白多一次请求，还多占一次风控窗口；
 *   · 每条再撞一次分享接口，撞上限的账号继续被拒；
 *   · 被永久禁止二次分享（errno=115）的资源**永远**重试。换号、等明天都不会变，纯浪费。
 * 实际上只需要拿历史 `toPaths` 直接补一次分享就行，根本不用再碰转存接口。
 *
 * 三种动作：
 *   "share-only" —— 拿历史 toPaths 直接补建分享，**完全不再调用转存接口**；
 *   "skip"       —— 别再碰了（百度永久禁止 / 补分享次数用尽）；
 *   "transfer"   —— 没有可复用的落盘路径，走完整流程重传。
 *
 * ⚠️ 补分享的次数**必须**用 `shareAttempts` 单独计数，不能复用 `attempts`：
 *    `attempts` 是"转存失败 N 次进黑名单"的计数器，三条链路都在读它。
 *    把补分享的失败算进去，会让**明明已经转存成功**的资源因为分享建不出来被拉黑 ——
 *    用户看到的是"资源在网盘里，但程序说它失败了，以后再也不碰它"。
 */

const SHARE_RETRY_MAX = 3;

/**
 * @param {object|undefined} prev 台账里这条链接的历史记录（loadLedger 出来的，可能没有）
 * @returns {{action: "share-only"|"skip"|"transfer", toPaths: string[], shareAttempts: number, reason: string}}
 */
function planShareRetry(prev) {
  const base = { toPaths: [], shareAttempts: 0, reason: "" };
  if (!prev || typeof prev !== "object") return { action: "transfer", ...base };

  // 百度永久禁止二次分享：换号、等明天都不会变，再试就是纯浪费（errno=115）
  if (prev.shareForbidden) {
    return { action: "skip", ...base, reason: "该资源被百度永久禁止二次分享（换号/等明天都无效）" };
  }
  if (prev.status !== "share_failed") return { action: "transfer", ...base };

  const toPaths = Array.isArray(prev.toPaths) ? prev.toPaths.filter((p) => typeof p === "string" && p.trim()) : [];
  const shareAttempts = Number(prev.shareAttempts) || 0;
  if (!toPaths.length) {
    // 旧台账 / 异常记录没留下落盘路径 —— 没法据此建分享，只能重传一次把路径拿回来
    return { action: "transfer", toPaths: [], shareAttempts, reason: "历史记录里没有落盘路径" };
  }
  if (shareAttempts >= SHARE_RETRY_MAX) {
    return { action: "skip", toPaths, shareAttempts, reason: `已补分享 ${shareAttempts} 次仍失败` };
  }
  return { action: "share-only", toPaths, shareAttempts, reason: "" };
}

/**
 * 「补分享又失败了」要写回台账的那几个字段（调用方展开进自己的 entry）。
 * 记 `shareForbidden` 是为了让**下一轮** planShareRetry 直接判 skip，不再重试。
 *
 * @param {{shareAttempts?: number}} plan planShareRetry 的返回值
 * @param {{shareForbidden?: boolean}} [share] runShareStep 的返回值
 */
function shareRetryFields(plan, share) {
  const fields = { shareAttempts: ((plan && plan.shareAttempts) || 0) + 1 };
  if (share && share.shareForbidden) fields.shareForbidden = true;
  return fields;
}

/**
 * 「只转存、不建分享」模式下，这一条要往台账里写什么。
 *
 * 为什么单独一个构造函数（2026-10-14）：
 * `payload.makeShare === false` 这个选项后端**早就支持**（`runShareStep` 里 `if (!makeShare) return out`），
 * 但渲染端从来没把它发出去 → 界面上没有任何入口 → **从没有人走到过这条路**。
 * 而这条路原来是**坏的**：`runShareStep` 返回 `{ownLink:"", shareFailed:false}` 之后，
 * 流程会带着一个**空链接**继续往下生成问答行 —— 用户会拿到一张没有链接的表。
 *
 * 记成 `share_failed` 是**有意为之**，不是敷衍：
 * 这样下一轮 `planShareRetry` 会直接判 `share-only` —— 拿这里的 `toPaths` 补建分享，
 * **一步转存接口都不碰**。也就是说"先只转存把资源全部搬完，之后再补分享拿链接"
 * 这条路是现成的，不用另写一套逻辑。（`planShareRetry(buildTransferOnlyEntry(…)).action === "share-only"`
 * 这条不变式有单测钉着。）
 *
 * ⚠️ `shareAttempts` 从 0 开始，**不要**去动 `attempts`：后者是"转存失败 N 次进黑名单"的计数器，
 *    把只转存算进去会让明明已经落盘的资源被拉黑。
 *
 * @param {{srcLink?: string, name?: string, toPaths?: string[], at?: string}} row
 */
function buildTransferOnlyEntry(row = {}) {
  return {
    srcLink: String((row && row.srcLink) || ""),
    name: String((row && row.name) || ""),
    status: "share_failed",
    phase: "done",
    toPaths: Array.isArray(row && row.toPaths) ? row.toPaths.filter((p) => typeof p === "string" && p.trim()) : [],
    ownLink: "",
    shareAttempts: 0,
    error: "本批为「只转存」模式，未建分享（下轮正常跑会自动补，不重传）",
    at: String((row && row.at) || ""),
  };
}

module.exports = { SHARE_RETRY_MAX, planShareRetry, shareRetryFields, buildTransferOnlyEntry };
