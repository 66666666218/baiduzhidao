"use strict";

/**
 * 批量转存的「这批到底怎么跑、还要跑多久」规则（纯函数，全仓唯一一份）。
 *
 * 为什么值得单独一个文件：
 * 用户拿着一张 **11164 行**的资源表跑批量转存，界面上刷出来的是
 *   `✅ [1/11164] 求分享中国式网游… → https://pan.baidu.com/s/…`
 * 一行一条。于是他的第一反应必然是"为什么还是一个一个的转存？我们不是有批量转存吗？"
 * —— 这个疑问不是用户看错了，而是**界面从来没有回答过它**：
 *   · 没说"这是一个 11164 条的队列，不是一条一条手动点"；
 *   · 没说"当前是串行，因为没给账号配互不相同的代理"；
 *   · 没说"按这个节奏还要 27 小时"；
 *   · 更没说"这批最多只有 600 条能拿到分享链接"（单账号每日 300）。
 * 这几件事全部能从台账算出来，缺的只是**没有一个地方算**。规则放这里，
 * 调用方（tasks/batch-transfer.js）只负责喂数据、念文案。
 *
 * 这里只放纯计算与文案；任何 IO / 时间读取都由调用方注入，方便单测。
 */

/** 进度播报的默认节奏：每 N 条报一次（少了是噪音，多了用户又不知道在动） */
const PROGRESS_EVERY = 25;
/** 上传专用表增量落盘的默认节奏 */
const QA_FLUSH_EVERY = 25;
const QA_FLUSH_MIN_GAP_MS = 15 * 1000;
const QA_FLUSH_MAX_GAP_MS = 5 * 60 * 1000;

/**
 * 把毫秒说成人话。负数/NaN 返回空串（**不要**抛，也不要说"0 秒"，
 * 因为那意味着"已经跑完"，而实际含义是"算不出来"）。
 */
function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 60 * 1000) return `${Math.max(1, Math.round(n / 1000))} 秒`;
  if (n < 60 * 60 * 1000) return `${Math.round(n / 60000)} 分钟`;
  const hours = Math.floor(n / 3600000);
  const minutes = Math.round((n - hours * 3600000) / 60000);
  if (minutes >= 60) return `${hours + 1} 小时`;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/**
 * 实测节奏：每条平均多少毫秒。
 *
 * ⚠️ 必须用**实测**而不是估一个常数 —— 每条要打 3~4 个请求（解析分享页 → 建目录 →
 * 转存 → 建分享），耗时随链接和被限流情况浮动很大（本机实测 8.6~9.6 秒/条）。
 * 样本不足（还没成功过一条）时返回 0，含义是"还不知道"，由调用方决定不显示 ETA。
 */
function measurePace({ done, elapsedMs }) {
  const n = Number(done);
  const t = Number(elapsedMs);
  if (!Number.isFinite(n) || !Number.isFinite(t) || n <= 0 || t <= 0) return 0;
  return t / n;
}

/**
 * 还要多久。`done >= total` 或节奏未知时返回 null（= 不显示，而不是显示 0）。
 */
function estimateRemaining({ done, total, perItemMs }) {
  const n = Number(done);
  const all = Number(total);
  const pace = Number(perItemMs);
  if (!Number.isFinite(n) || !Number.isFinite(all) || !Number.isFinite(pace)) return null;
  if (!(all > 0) || !(pace > 0) || n >= all) return null;
  const remainingMs = Math.round((all - n) * pace);
  return {
    perItemMs: Math.round(pace),
    remainingMs,
    remainingText: formatDuration(remainingMs),
    // 跑到现在的平均节奏 × 总条数 = 整批的预期总时长，用来在开工时说"这是个通宵任务"
    totalMs: Math.round(all * pace),
    totalText: formatDuration(all * pace),
  };
}

/**
 * 本批**最多**能产出多少条带分享链接的问答行。
 *
 * 依据：百度限制单账号每日最多 300 个分享链接（netdisk/share.js 的 SHARE_DAILY_LIMIT）。
 * 超出的部分**照样会转存进网盘**，但建不了分享 → 不进上传专用表。
 * 所以 11164 条的批次里，只有前 `账号数 × 300` 条是有效产出，其余是白转（还占网盘空间）。
 */
function shareCeiling({ accounts, shareDailyLimit }) {
  const a = Math.max(0, Math.floor(Number(accounts) || 0));
  const lim = Math.max(0, Math.floor(Number(shareDailyLimit) || 0));
  return a * lim;
}

/** 进度行：`📈 进度 300/11164（9.2 秒/条，剩余约 27 小时 53 分钟）` */
function progressLine({ done, total, perItemMs }) {
  const n = Number(done);
  const all = Number(total);
  if (!Number.isFinite(n) || !Number.isFinite(all)) return "";
  const pace = Number(perItemMs);
  const paceText = pace > 0 ? `${(pace / 1000).toFixed(1)} 秒/条` : "";
  const est = estimateRemaining({ done: n, total: all, perItemMs: pace });
  const tail = est ? `剩余约 ${est.remainingText}` : "";
  const inner = [paceText, tail].filter(Boolean).join("，");
  return `📈 进度 ${n}/${all}${inner ? `（${inner}）` : ""}`;
}

/**
 * 开工告知：这批有多大、能不能并、能出多少条。
 *
 * 全部用**已确证的规则**推出来的数字，不含猜测：
 *   · cc（实际线程数）与账号数 → 说明并行/串行以及为什么；
 *   · 账号数 × 每日分享上限 → 本批有效产出的天花板；
 *   · shareCap < total → 明确说"剩下的白转"。
 *
 * @returns {string[]} 逐行文案（调用方一行一行 log，不在这里拼多行字符串）
 */
function batchScaleNotice({ total, accounts, cc, shareDailyLimit, destRoot = "" }) {
  const all = Math.max(0, Math.floor(Number(total) || 0));
  const acc = Math.max(0, Math.floor(Number(accounts) || 0));
  const threads = Math.max(1, Math.floor(Number(cc) || 1));
  const cap = shareCeiling({ accounts: acc, shareDailyLimit });
  const lines = [];
  lines.push(`本批是**一次性排队的批量任务**：共 ${all} 条已入队，逐条推进、断点可续跑`
    + `（进度台账见数据目录「批量转存」下对应文件夹）。日志里每条一行 ✅/⚠️ 是**进度播报**，不是"手动一条一条点"。`);
  if (threads > 1) {
    lines.push(`并行 ${threads} 条链（每线程固定一个账号、出口 IP 互不相同），实际速度约为串行的 ${threads} 倍。`);
  } else {
    lines.push(acc > 1
      ? `当前**串行**（同一时刻只有一条链在跑），因为 ${acc} 个账号没有配「互不相同的账号代理」——`
        + "线程数被硬性限制为不超过互不相同的出口 IP 数，否则两个线程同 IP 同时发请求会被百度降级（实测 cc=2 时 9/9 失败）。"
      : "当前**串行**（只有 1 个可用账号，无法并行）。");
  }
  if (cap > 0) {
    if (all > cap) {
      lines.push(`⚠️ 本批 ${all} 条里，**只有前约 ${cap} 条能拿到分享链接**（${acc} 个账号 × 每日 ${shareDailyLimit} 个分享上限），`
        + `其余 ${all - cap} 条会照常转存进网盘但建不了分享、也不会进上传专用表。`
        + "想不白转：把「数量上限」设成 600 之类的值，分批多天跑。");
    } else {
      lines.push(`本批 ${all} 条都在分享额度内（上限 ${cap} = ${acc} 账号 × ${shareDailyLimit}/天），可全部产出分享链接。`);
    }
  }
  if (destRoot) lines.push(`转存目标目录：${destRoot}`);
  return lines;
}

/**
 * 上传专用表该不该**增量落盘**一次。
 *
 * 为什么需要：这张表原来只在整批结束时写一次。11164 条 = 将近 28 小时，
 * 也就是"跑到第二天下午才第一次看到问答表格"；中途停止/崩溃虽然也会写，
 * 但用户在这 28 小时里打开数据目录只看得到一个 state.jsonl —— 他会以为"根本没生成问答表"。
 *
 * 规则（三条都要满足）：
 *   ① 有新增行（`done > flushedRows`），否则写了也没变化；
 *   ② 距离上次写盘至少 `minGapMs`（默认 15 秒）—— 避免每条都落一次盘把自己拖慢；
 *   ③ 满足其一：新增行数达到 `every`（默认 25，连续跑时约每 4 分钟一次），
 *      或距离上次已经超过 `maxGapMs`（默认 5 分钟，被限流暂停时也不至于一直不刷新）。
 */
function shouldFlushQa({
  done, flushedRows, lastFlushAt, now,
  every = QA_FLUSH_EVERY,
  minGapMs = QA_FLUSH_MIN_GAP_MS,
  maxGapMs = QA_FLUSH_MAX_GAP_MS,
} = {}) {
  const written = Number(done);
  const flushed = Number(flushedRows);
  const last = Number(lastFlushAt);
  const t = Number(now);
  if (!Number.isFinite(written) || !Number.isFinite(flushed) || written <= flushed) return false;
  if (!Number.isFinite(last) || !Number.isFinite(t)) return false;
  const gap = t - last;
  if (gap < Number(minGapMs)) return false;
  return (written - flushed) >= Number(every) || gap >= Number(maxGapMs);
}

/**
 * 是不是"所有账号的每日分享额度都打满了"。
 *
 * 这一刻很关键：从这条开始，本批剩下的条目**只会转存进网盘、不再产出任何问答行**
 * （没有分享链接 → 进不了上传专用表）。所以必须**只在那一刻说一次**（`announced` 去重），
 * 而且**不自动停** —— 用户要的可能本来就是"把资源存进自己网盘"，
 * 替他做决定反而更糟。让他在知道真相之后自己选。
 */
function shouldAnnounceShareExhausted({ blockedAccounts, accounts, announced } = {}) {
  if (announced) return false;
  const blocked = Math.max(0, Math.floor(Number(blockedAccounts) || 0));
  const acc = Math.max(0, Math.floor(Number(accounts) || 0));
  return acc > 0 && blocked >= acc;
}

/** 上面那一刻要说的话（把两个选项都摆出来，不替他决定） */
function shareExhaustedNotice({ remaining, accounts, shareDailyLimit }) {
  const n = Math.max(0, Math.floor(Number(remaining) || 0));
  const acc = Math.max(0, Math.floor(Number(accounts) || 0));
  return `🛑 ${acc} 个账号的每日 ${shareDailyLimit} 个分享额度**全部用尽**：从这一条开始，`
    + `本批剩余 ${n} 条只会**转存进网盘**、不再产出任何问答行（没有分享链接，也就进不了上传专用表）。`
    + "　· 如果你要的就是问答表：**现在点「停止」不亏**，明天额度恢复后再跑后面这批"
    + "（已完成的台账不会丢，重跑会从那之后接着走）。"
    + "　· 如果你要的是把资源存进自己网盘：不用管它，让它跑完即可。";
}

module.exports = {
  PROGRESS_EVERY,
  QA_FLUSH_EVERY,
  QA_FLUSH_MIN_GAP_MS,
  QA_FLUSH_MAX_GAP_MS,
  formatDuration,
  measurePace,
  estimateRemaining,
  shareCeiling,
  progressLine,
  batchScaleNotice,
  shouldFlushQa,
  shouldAnnounceShareExhausted,
  shareExhaustedNotice,
};
