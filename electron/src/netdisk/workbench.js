"use strict";

/**
 * 答主工作台：上传记录 / 收录状态的解析与汇总。
 *
 * 为什么需要它：上传成功 ≠ 被收录。`bulkqa/upload` 返回 200 只说明**平台收下了**，
 * 之后平台还要异步审核，审核结果只体现在「上传记录」里：
 *
 *   GET /qa/api/bulkqa/tasks?page=1&pageSize=N   →  { data: { list: [...], total } }
 *
 * 每条任务：{ id, taskName, status, totalCount, successCount, failCount, usedTotal, createdAt, updatedAt }
 *
 * 这里只做纯函数（解析/汇总/格式化），网络请求留给任务层，方便单测。
 */

/** 时间戳（秒）→ 本地可读文本 */
function formatTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 汇总一批上传任务。
 *
 * 口径说明：平台的 `successCount` 就是**审核通过并被收录的条数**，
 * `failCount` 是被拒的条数。`usedTotal` 是实际扣掉的额度（= 成功条数），
 * 所以"没收录的不扣额度"这件事也能从这里看出来。
 */
function summarizeTasks(tasks) {
  // 只认「像任务」的条目：既没有 id 也没有任务名的不算（接口异常时可能是空洞）
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && (t.id != null || t.taskName));
  const summary = {
    taskCount: list.length,
    totalRows: 0,
    successRows: 0,
    failedRows: 0,
    usedQuota: 0,
    hasFailure: false,
    firstAt: "",
    lastAt: "",
  };
  for (const t of list) {
    summary.totalRows += Number(t.totalCount) || 0;
    summary.successRows += Number(t.successCount) || 0;
    summary.failedRows += Number(t.failCount) || 0;
    summary.usedQuota += Number(t.usedTotal) || 0;
  }
  summary.hasFailure = summary.failedRows > 0;
  const times = list.map((t) => Number(t.createdAt) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  if (times.length) {
    summary.firstAt = formatTime(times[0]);
    summary.lastAt = formatTime(times[times.length - 1]);
  }
  return summary;
}

/** 单条任务的展示文本 */
function formatTask(task) {
  const t = task || {};
  const name = String(t.taskName || `任务${t.id || ""}`).trim();
  const time = formatTime(t.createdAt);
  const total = Number(t.totalCount) || 0;
  const ok = Number(t.successCount) || 0;
  const bad = Number(t.failCount) || 0;
  if (!total) return `${name}｜${time}｜状态未知`;
  // 刚上传完、平台还没审时 successCount / failCount **都是 0** ——
  // 这时候套用下面那句会输出「✅ 全部收录 0/5」：一条都还没收录，却写着"全部收录"。
  // 2026-10-10 第一次真机跑就撞上了，所以单独把"还没出结果"这一档分出来。
  if (!ok && !bad) return `${name}｜${time}｜⏳ 审核中（共 ${total} 条，还没出结果）`;
  if (!bad) return `${name}｜${time}｜✅ 全部收录 ${ok}/${total}`;
  return `${name}｜${time}｜⚠️ 收录 ${ok}/${total}，被拒 ${bad} 条`;
}

/**
 * 从接口响应里取出任务列表。响应形状变化时返回空数组而不是抛错——
 * 调用方据此提示"接口结构可能变了"，比直接崩掉好定位。
 */
function pickTaskList(response) {
  const data = (response && response.data) || {};
  const list = data.list;
  return Array.isArray(list) ? list : [];
}

/** 响应里声明的任务总数（排行榜分页用） */
function pickTaskTotal(response) {
  const data = (response && response.data) || {};
  return Number(data.total) || 0;
}

/**
 * 账号信息。真实响应（实测）：
 *   { code:200, data:{ hasPermission:true, quota:10000, usedQuota:0,
 *                      username:"俊哦情0I", avatar:"…", isBanned:false, banDays:-1 } }
 *
 * 注意 `username` 是全小写（不是 userName），最初按驼峰猜，名字一直是空的。
 * `isBanned`/`banDays` 很关键——**工作台会告诉你账号是不是被封了**，这个必须往上抛。
 */
function pickUserInfo(response) {
  const data = (response && response.data) || {};
  return {
    name: String(data.username || data.userName || data.name || "").trim(),
    remainingQuota: Number(data.quota ?? data.remainQuota ?? data.remainingQuota ?? NaN),
    usedQuota: Number(data.usedQuota ?? NaN),
    hasPermission: data.hasPermission !== false,
    banned: Boolean(data.isBanned),
    banDays: Number(data.banDays ?? -1),
  };
}

const WB_HOST = "https://zhidao.baidu.com";
const WB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WB_REFERER = `${WB_HOST}/b/batch/batch-upload`;

/**
 * 带登录 Cookie 请求工作台接口（纯协议，不需要浏览器）。
 *
 * 为什么不用浏览器：和转存一样——Cookie 取一次就够，之后全程 HTTP。
 * 浏览器只在"取 Cookie"那一步用。
 */
async function fetchWorkbenchJson(pathname, cookie, { fetchImpl = globalThis.fetch, timeoutMs = 20000, dispatcher } = {}) {
  if (!String(cookie || "").trim()) throw new Error("缺少登录 Cookie（该账号未登录百度）");
  const url = `${WB_HOST}${pathname}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Cookie: cookie, "User-Agent": WB_UA, Referer: WB_REFERER },
      dispatcher,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || /timeout|abort/i.test(e.message || ""))) {
      throw new Error(`工作台接口超时（${timeoutMs / 1000} 秒无响应）`);
    }
    throw e;
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 未登录时也可能是 HTML 登录页；给一句能定位的话，别只说"解析失败"
    throw new Error(`工作台接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
  if (json && json.code === 401) throw new Error("账号未登录或登录已过期（接口返回 401）");
  return json;
}

/**
 * 从「结果下载」的 xlsx 行里挑出被拒的行。
 *
 * 结果表的列（实测）：qid / 问题 / 答案 / 一级分类 / 二级分类 / 是否成功 / 失败原因 / 问题链接
 *
 * 这一步的意义：以前只能看到「失败 N 条」，于是原因只能猜（之前 CHANGELOG 里
 * "标题空括号 / URL重复提交" 就是这么猜出来的）。有这个表，原因是**读出来**的。
 */
function pickFailedRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && String(row["是否成功"] || "").trim() !== "是")
    .map((row) => ({
      qid: Number(row.qid) || 0,
      title: String(row["问题"] || "").trim(),
      reason: String(row["失败原因"] || "").trim() || "(未给出原因)",
      questionUrl: String(row["问题链接"] || "").trim(),
      hasLink: /pan\.baidu\.com|pan\.quark|提取码/i.test(String(row["答案"] || "")),
    }));
}

/** 失败原因计数（按出现次数降序） */
function countReasons(failedRows) {
  const counter = new Map();
  for (const row of Array.isArray(failedRows) ? failedRows : []) {
    const key = String((row && row.reason) || "(未给出原因)");
    counter.set(key, (counter.get(key) || 0) + 1);
  }
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}

/** 取某个上传任务的「结果下载」文件（xlsx 二进制） */
async function fetchTaskResult(taskId, cookie, { fetchImpl = globalThis.fetch, timeoutMs = 30000, dispatcher } = {}) {
  if (!String(cookie || "").trim()) throw new Error("缺少登录 Cookie（该账号未登录百度）");
  const url = `${WB_HOST}/qa/api/bulkqa/task/download?id=${encodeURIComponent(taskId)}`;
  const res = await fetchImpl(url, {
    headers: { Cookie: cookie, "User-Agent": WB_UA, Referer: WB_REFERER },
    redirect: "follow",
    dispatcher,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`结果下载失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  formatTime,
  summarizeTasks,
  formatTask,
  pickTaskList,
  pickTaskTotal,
  pickUserInfo,
  pickFailedRows,
  countReasons,
  fetchWorkbenchJson,
  fetchTaskResult,
  WB_HOST,
};
