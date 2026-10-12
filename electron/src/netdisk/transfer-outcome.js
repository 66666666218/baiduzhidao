"use strict";

/**
 * 「一次 /share/transfer 的响应到底意味着什么」—— **这条判断只有一个家**。
 *
 * 为什么必须抽出来：同一个判断在本仓库里出现过**三份**，成熟度完全不同 ——
 *   · netdisk/protocol.js（纯协议，应用主路径）：6 条规则全有
 *   · netdisk/transfer.js（浏览器执行器，CLI 脚本用）：只有前 2 条
 *   · scripts/pan-transfer-ui.js（真 UI 点击拦截 XHR）：**一条都没有**
 *
 * 三份跑在完全不同的代码路径上，谁也不会提醒谁。落后的那份于是把
 * 「其实已经成功」的三种情况记成失败：
 *   ① `errno=4`（已转存过）→ 每次重跑都刷一遍「UI转存 errno=4」的假失败，而且**永远不可能变成功**；
 *   ② 大文件**异步转存**（`errno=0` 但没有 extra 路径，`show_msg` 写着「文件转存中」）→
 *      报「转存成功但未取得落盘路径」→ 计失败 + attempts+1 → 3 次后进黑名单，而文件其实正在正常转；
 *   ③ `info[0].errno` 里的真实错误被吞 → 真实原因（容量不足 / 登录失效）被掩盖成「未取得落盘路径」。
 *
 * 判定规则（来自本项目真机实测 + 本机参考实现 wangpan 的 CHANGELOG）：
 *   `errno=0`         → 成功
 *   `errno=4`         → **已转存过**：算成功，复用已有路径。重跑时必然出现，绝不能当失败。
 *   `errno=2`         → 目的路径不存在（调用方可回落顶层目录重试）
 *   `errno=12 / -10`  → 容量不足（fatal：换账号或清空间，原地重试没有意义）
 *   `show_msg` 含「转存中/正在转存」→ **异步转存中**：errno=0 但拿不到路径，不是失败
 *   `info[0].errno`   → 百度偶发把真实错误只放在 info 层而顶层 errno=0；**只在顶层为 0 时**提升，
 *                       免得覆盖 2/4/12 这些已有专门分支的码。
 *                       反过来 `info[0].errno === 0` 是「文件其实成功了」的形态，此时**不许报错**。
 *
 * ⚠️ 刻意**不**把 `errno=-9` 当容量不足。它的含义在本仓库里是**端点相关**的：
 *   - `verifyShare`（transfer.js:114）里 `-9` = 提取码错误 / 分享失效；
 *   - `share/transfer` 里 `-9` 的含义**没有确证** —— 本机参考实现（wangpan）的 CHANGELOG
 *     记了 115 / 4 / 2 / -7，**没有** -9。之前项目注释里"info 层 -9 = 容量不足"是推断。
 *   把它折进 `capacityFull` 的代价是：多账号跑批时会**误判某个好账号空间已满并停用它**，
 *   这比现状（报一条普通错误、重试 3 次）更糟。所以这里宁可保守，只暴露 errno 让调用方看得到。
 */

/** 容量不足（确定项）：在 transfer 响应里 12 与 -10 都实测过 */
const CAPACITY_ERRNOS = [12, -10];
/** 已转存过 → 算成功 */
const DUP_ERRNO = 4;
/** 目的路径不存在 → 可回落顶层目录重试 */
const PATH_MISSING_ERRNO = 2;
/** 风控 */
const RISK_ERRNOS = [-62, -65, -70];
/** 登录失效（Cookie 过期） */
const LOGIN_LOST_ERRNO = -6;

/** 取 list 里某几个字段值（先到先用），过滤掉空值 */
function pluck(list, keys) {
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      if (!x) return "";
      for (const k of keys) if (x[k]) return x[k];
      return "";
    })
    .filter(Boolean);
}

/** 转存落盘路径：extra.list[].to / duplicated.list[].path */
function collectTransferPaths(body) {
  const b = body || {};
  return { extraPaths: pluck(b.extra && b.extra.list, ["to"]), dupPaths: pluck(b.duplicated && b.duplicated.list, ["path"]) };
}

/**
 * 把一次 /share/transfer 的原始响应归一成一个「判定结果」。
 * **纯函数、不发请求、不改入参** —— 所以三处调用方都能用它，且可被单测直接覆盖。
 */
function normalizeTransferBody(body) {
  const b = body || {};
  // 故意**不**用 `|| 0` 兜底：响应里没有 errno 字段时 `Number(undefined)` 是 NaN，
  // 而 NaN 会在下面所有比较里落空、最终被调用方当成"非 0 错误"抛出来 —— 这正是我们要的
  // （畸形响应绝不能当成成功）。用 `|| 0` 会把它悄悄变成"成功"。
  const rawErrno = Number(b.errno);
  // info 层：注意 errno 为 0 也是"有值"，它代表「文件其实成功了」，必须能区分
  // 「info 不存在」与「info[0].errno === 0」——后者不能触发提升、也不能被当成错误。
  const infoEntry = b.info && b.info[0] ? b.info[0] : null;
  const hasInfoErrno = !!infoEntry && infoEntry.errno !== undefined && infoEntry.errno !== null;
  const infoErrno = hasInfoErrno ? Number(infoEntry.errno) || 0 : 0;
  // 只在顶层为 0 时提升（顶层有专门分支的 2/4/12 不能被覆盖）
  const errno = (!rawErrno && infoErrno) ? infoErrno : rawErrno;
  const showMsg = String(b.show_msg || "");
  const { extraPaths, dupPaths } = collectTransferPaths(b);

  return {
    errno, rawErrno, infoErrno, hasInfoErrno,
    /** info 层明确说「这个文件成功」——此时即使顶层 errno 非 0 也不该判失败 */
    infoSucceeded: hasInfoErrno && infoErrno === 0,
    showMsg,
    /** 大文件异步转存：errno=0 但拿不到路径。**不是失败**。 */
    pending: /转存中|正在转存/.test(showMsg),
    capacityFull: CAPACITY_ERRNOS.includes(errno),
    dup: errno === DUP_ERRNO,
    pathMissing: errno === PATH_MISSING_ERRNO,
    risk: RISK_ERRNOS.includes(errno),
    loginLost: errno === LOGIN_LOST_ERRNO,
    /** 权威落盘路径（两种来源分开给，调用方按需挑） */
    extraPaths,
    dupPaths,
    /** info 层可能也带 path（errno 提升时常见） */
    infoPaths: pluck(b.info, ["path"]),
    /** extra 里的 fs_id（字段名两种写法都见过） */
    extraFsIds: pluck(b.extra && b.extra.list, ["fsid", "fs_id"]).map(Number).filter(Boolean),
    /** duplicated 里的 fs_id */
    dupFsIds: pluck(b.duplicated && b.duplicated.list, ["fs_id"]).map(Number).filter(Boolean),
  };
}

/**
 * 把「判定结果」翻成一句给人看的话。跑批是无人值守的，
 * 日志里出现一个裸 `errno=4` 没人知道是该高兴还是该去排查。
 */
function describeTransferOutcome(o) {
  if (!o) return "无响应";
  if (o.pending) return "百度在异步转存中（大文件），本次拿不到落盘路径，不算失败";
  if (o.capacityFull) return `网盘容量不足（errno=${o.errno}）`;
  if (o.dup) return "该资源此前已转存过，复用已有文件";
  if (o.pathMissing) return `目标路径不存在（errno=2）`;
  if (o.risk) return `触发风控（errno=${o.errno}）`;
  if (o.loginLost) return `登录已失效（errno=-6），请重新提取网盘凭证`;
  if (o.errno !== 0) return `转存失败 errno=${o.errno}${o.showMsg ? `：${o.showMsg}` : ""}`;
  return "转存成功";
}

module.exports = {
  CAPACITY_ERRNOS, DUP_ERRNO, PATH_MISSING_ERRNO, RISK_ERRNOS, LOGIN_LOST_ERRNO,
  normalizeTransferBody, collectTransferPaths, describeTransferOutcome,
};
