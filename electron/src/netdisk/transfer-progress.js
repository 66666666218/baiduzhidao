"use strict";

/**
 * 跑批的「这批到底怎么跑、还要跑多久」规则（纯函数，全仓唯一一份）。
 *
 * 覆盖面：批量转存（进度 / ETA / 分步耗时 / 额度与 IP 坎告知）+ AI 生成阶段的节奏播报。
 * 生成阶段（tasks/generate.js）只复用这里的 formatDuration / measurePace / progressLine /
 * shouldReportPace，**不在本地另算一份「秒/条」** —— 两个"还剩多久"互相不一致，比没有更糟。
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
/**
 * AI 生成阶段的节奏播报节奏：同样每 N 条一次，但用 10 而不是 25 ——
 * 生成一批通常只有几十条（抽题默认 20），25 条一报等于整批一次都不报。
 */
const PACE_EVERY = 10;
/** 上传专用表增量落盘的默认节奏 */
const QA_FLUSH_EVERY = 25;
const QA_FLUSH_MIN_GAP_MS = 15 * 1000;
const QA_FLUSH_MAX_GAP_MS = 5 * 60 * 1000;

/**
 * 「连续转存大约 1000 条之后，百度会在 **IP 层**收紧」—— 到达这个条数时提醒一次。
 *
 * 出处（**第三方记录，不是我实测的**）：开源批量转存工具 `hakureiholo/BaiduPanFilesTransfers`
 * （GPL-3.0，就是同类里最常被推荐的那个）的 FAQ 有一条「转存次数到达 1000 上限」：
 *   「连续转存 1000 个链接，再多 1 个都会报错，报错码千奇百怪。甚至网页端都无法再转存……
 *     原因：百度网盘基于 IP 地址层面的封锁，禁止用户大量转存。
 *     解决：可以重启拨号路由器，更换对外 IP 地址。」
 * 同一个 FAQ 还有一条「链接错误尝试次数过多」：短时间内对**同一个**链接访问 3 次以上就会弹验证码
 *   —— 这正是我们分享页重试 3 次的形状，所以那 3 次必须带着退避（SHARE_RETRY_DELAYS）。
 *
 * ⚠️ 按本项目的规矩，这**不是**能拿来推算的常量（同族教训：`SHARE_DAILY_LIMIT` 那个 300
 * 就被用户台账实测推翻了）。它只做一件事：**在快跑到那个坎之前提醒一次**，
 * 让用户自己决定换 IP / 配代理 / 分批。**绝不自动停，也绝不说"你只能跑 1000 条"。**
 */
const IP_BURST_WARN_AT = 900;

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
 * 本批分享额度还剩多少余量 —— 只在**有实测依据**时给结论。
 *
 * ⚠️ 这里踩过一次坑，写下来免得后人再踩（2026-10-14）：
 * 代码里有个常量 `SHARE_DAILY_LIMIT = 300`，于是"开工告知"直接推出"这批 11164 条里只有前 600 条
 * 能拿到分享链接"。**这个结论是错的。** 用户那天真实跑批的台账实测：681 条里 667 条都建成了分享，
 * 按每 50 条轮换推算，两个账号各建了约 **350 / 334 个**分享链接，而**一条"每日上限"错误都没有**
 * （全表 `errno=120` / "分享次数已达上限" 出现次数 = 0）。也就是说 300 这个数字**不是**当前的真实天花板。
 *
 * 教训：**常量不等于事实**。真实上限只有百度的服务端知道（且可能随账号、时间变化），
 * 所以这里不再推算一个"天花板数字"去吓用户，只做两件事：
 *   ① 开工时说明"分享可能有每日额度，到顶时本程序会明确告诉你，不会静默"；
 *   ② 只在**真的撞到**额度错误之后（`shareBlocked` 有值）才说"从此不再产出问答行"。
 * 判据与文案都在这一处，别再在别处推算上限。
 */
function shareQuotaNotice({ accounts, shareDailyLimit }) {
  const acc = Math.max(0, Math.floor(Number(accounts) || 0));
  const lim = Math.max(0, Math.floor(Number(shareDailyLimit) || 0));
  return `分享额度：百度对"每天能建多少分享链接"有服务端限制（代码里参考值是每账号 ${lim}/天，`
    + `但实测并不恰好是这个数 —— 有一次 2 个账号各建了 350 个都没被拦），所以**不要在开工时按它推算"只能出 N 条"**。`
    + `这批会用 ${acc} 个账号轮换；额度真用完的那一刻，程序会在日志里明确告诉你"从此不再产出问答行"并给出两个选项，不会静默。`;
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
 * 该不该播报一次「进度 + 秒/条 + 还剩多久」（AI 生成阶段用；转存那边用 PROGRESS_EVERY 自己的节奏）。
 *
 * 为什么样本至少 2 条才报：单条生成耗时的波动能到一倍以上（题目长短、供应商排队），
 * 拿 1 条去除以 1 得到的"秒/条"和 ETA 是在骗人 —— 本项目在"界面/日志给一个拍脑袋数字"
 * 上栽过的跟头足够写成一页，所以这里宁可少报一次。
 *
 * 收尾那一行不归这里管：generate.js 的总结论自带实测节奏，不需要 progressLine 再报一次
 * "51/51" 这种没有信息量的行。
 */
function shouldReportPace({ done, every = PACE_EVERY } = {}) {
  const n = Number(done);
  if (!Number.isFinite(n) || n < 2) return false;
  const step = Math.max(1, Math.floor(Number(every) || PACE_EVERY));
  return n % step === 0;
}

/**
 * AI 生成阶段的收尾节奏文案：`（并发 6，实测 2.6 秒/条，共 2 分钟）`。
 *
 * 为什么放在这里而不是 generate.js：那句里的「秒/条」口径**只许有一个家**
 * （round19 的 E7 守着这件事：全仓扫 "秒/条"，只允许本文件出现）。
 * generate.js 拿到的是别处算好的 pace，它确实不该再拼第二份文案 ——
 * 两个"秒/条"各自四舍五入，用户同一天看到 2.6 和 2.7，就会怀疑数字是编的。
 *
 * 没有样本（pace <= 0）时返回空串：不说"0 秒/条"——0 的含义是"算不出来"，
 * 而显示 0 会被读成"瞬间跑完"。
 */
function generatePaceTail({ concurrency, perItemMs, elapsedMs }) {
  const pace = Number(perItemMs);
  if (!Number.isFinite(pace) || pace <= 0) return "";
  const cc = Math.max(1, Math.floor(Number(concurrency) || 1));
  const total = formatDuration(elapsedMs);
  return `（并发 ${cc}，实测 ${(pace / 1000).toFixed(1)} 秒/条${total ? `，共 ${total}` : ""}）`;
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
  lines.push(shareQuotaNotice({ accounts: acc, shareDailyLimit }));
  if (destRoot) lines.push(`转存目标目录：${destRoot}`);
  // 大批量（≥900 条）时**提前**把"1000 条那道 IP 坎"说出来：
  // 等他真跑到 900 条才说，前面那几百条已经白跑了。
  if (all >= IP_BURST_WARN_AT) lines.push(ipBurstNotice({ done: all, cc: threads, accounts: acc }));
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
  return `🛑 ${acc} 个账号的分享额度**真的用完了**（百度服务端拒绝建分享）：从这一条开始，`
    + `本批剩余 ${n} 条只会**转存进网盘**、不再产出任何问答行（没有分享链接，也就进不了上传专用表）。`
    + "　· 如果你要的就是问答表：**现在点「停止」不亏**，明天额度恢复后再跑后面这批"
    + "（已完成的台账不会丢，重跑会从那之后接着走）。"
    + "　· 如果你要的是把资源存进自己网盘：不用管它，让它跑完即可。";
}

/** 「跑到 900 条」时提醒一次（`shouldWarnIpBurst` 的判据 / 只喊一次的开关由调用方管） */
function shouldWarnIpBurst({ done, announced, warnAt = IP_BURST_WARN_AT } = {}) {
  if (announced) return false;
  const n = Number(done);
  const w = Number(warnAt);
  if (!Number.isFinite(n) || !Number.isFinite(w)) return false;
  return n >= w;
}

/**
 * 那句提醒要说什么：说清**出处**（第三方的经验记录，不是硬结论）、**症状**、**动作**，
 * 并且点明一个最容易搞错的点 —— `账号数` 和 `出口 IP 数` 不是一回事：换账号不换 IP 是没用的。
 */
function ipBurstNotice({ done, cc, accounts }) {
  const n = Math.max(0, Math.floor(Number(done) || 0));
  const chains = Math.max(1, Math.floor(Number(cc) || 1));
  const acc = Math.max(0, Math.floor(Number(accounts) || 0));
  const sameIp = chains <= 1 && acc > 1;
  return `⚠️ 已经转存 ${n} 条。有同类开源工具（BaiduPanFilesTransfers）记过一条经验：`
    + `**连续转存大约 1000 条之后，百度会在 IP 层面收紧** —— 之后多转 1 个都可能报出各种奇怪的错误码，`
    + `甚至网页端也转不动；它给出的解法是**换一个出口 IP**（重启拨号路由器，或走代理）。`
    + `这条**不是硬结论**（本项目的"每天 300 个分享"那个常量就被实测推翻过），所以程序**不会自己停**。`
    + `但如果你从这里开始突然大面积报错，先想这一条：`
    + (sameIp
      ? `注意「换账号」不等于「换 IP」—— 你现在的 ${acc} 个账号是同一个出口，换账号没用，要换的是 IP。`
      : "换出口 IP 就能继续。")
    + (chains <= 1
      ? "（不想反复重启路由器，就在设置页「账号代理」给每个账号配一条**互不相同**的代理，有几条出口就有几条链并行。）"
      : "");
}

/**
 * 阶段的展示顺序与中文名 —— **全仓唯一一份**。
 * 与 `protocol.js` 的 `phaseDurations` 是配套的：那边负责量，这边负责累加与排版。
 */
const PHASE_LABELS = [
  ["verify", "① 解析分享页 verify"],
  ["page", "② 取分享页 /s/<code>"],
  ["list", "③ 列分享内文件 /share/list"],
  ["create", "④ 建目录 /api/create"],
  ["transfer", "⑤ 转存 /share/transfer"],
];

/** 空累加器（{verify:{ms,n}, …}） */
function emptyPhases() {
  const o = {};
  for (const [k] of PHASE_LABELS) o[k] = { ms: 0, n: 0 };
  return o;
}

/** 累加一条链的分段耗时（`protocol.processOne` 返回的 `timings`）。负数/NaN 一律忽略。 */
function addPhases(acc, timings) {
  const out = acc || emptyPhases();
  if (!timings) return out;
  for (const [k] of PHASE_LABELS) {
    const v = Number(timings[k]);
    if (Number.isFinite(v) && v >= 0) { out[k].ms += v; out[k].n += 1; }
  }
  return out;
}

/**
 * 一行报出"每一步平均花了多久、占多少"。
 *
 * 存在的理由（2026-10-14）：用户问「为什么一条要 9 秒」。在此之前的唯一数字是"9.18 秒/条"——
 * 那是**总量**，不是分解，任何优化都只能靠猜（而本项目在"凭直觉改"上踩过太多次）。
 * 现在每一步的平均值由**真实跑批**自己报出来：看完这一行就知道该往哪儿使劲。
 * 样本为 0 时返回空串（= 不知道，**不许**显示 0）。
 */
function phaseLine(acc) {
  if (!acc) return "";
  let total = 0;
  for (const [k] of PHASE_LABELS) total += (acc[k] && acc[k].ms) || 0;
  const samples = (acc.verify && acc.verify.n) || 0;
  if (!total || !samples) return "";
  const parts = [];
  for (const [k, label] of PHASE_LABELS) {
    const v = acc[k] || { ms: 0, n: 0 };
    // 累计 0 毫秒 = 这一步这批**一次都没走到**（例如"根就是文件"的分享永远不打 /share/list）
    // → 不列出来，免得日志里出现一排 "0.00s(0%)" 让人误以为这些步骤是免费的
    if (!v.n || v.ms <= 0) continue;
    parts.push(`${label} ${(v.ms / v.n / 1000).toFixed(2)}s(${Math.round(v.ms / total * 100)}%)`);
  }
  return `🧭 每步平均耗时（样本 ${samples} 条，合计 ${(total / samples / 1000).toFixed(2)}s/条）：${parts.join(" · ")}`;
}

module.exports = {
  PROGRESS_EVERY,
  PACE_EVERY,
  QA_FLUSH_EVERY,
  QA_FLUSH_MIN_GAP_MS,
  QA_FLUSH_MAX_GAP_MS,
  PHASE_LABELS,
  emptyPhases,
  addPhases,
  phaseLine,
  IP_BURST_WARN_AT,
  shouldWarnIpBurst,
  ipBurstNotice,
  formatDuration,
  measurePace,
  estimateRemaining,
  shouldReportPace,
  generatePaceTail,
  progressLine,
  batchScaleNotice,
  shareQuotaNotice,
  shouldFlushQa,
  shouldAnnounceShareExhausted,
  shareExhaustedNotice,
};
