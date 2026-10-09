"use strict";

/**
 * 账号 ↔ 题材绑定 + 提交路由（v2.2）。
 *
 * 两阶段策略（用户口径）：
 *   - 前期·积累额度：账号不限题材，纯文本答案按轮询摊到所有账号（宽松）
 *   - 后期·带链接提交：账号只吃自己绑定的题材，严格一对一
 *
 * 绑定表形如 { "环境A": "情感类", "环境B": "教育类" }，来自设置 accountTopics。
 * 本模块不依赖 config.js（config 单向依赖本模块），保持依赖无环。
 */

const { splitRowsByKind } = require("./answer-kind");

/** 题材比较键：忽略空白与尾部"类"（"情感" 与 "情感类" 视为同一题材） */
function topicKey(topic) {
  return String(topic || "").trim().replace(/[\s类]+$/, "");
}

/**
 * 归一化绑定表。兼容三种输入：
 *   - 对象：{ "环境A": "情感类" }
 *   - 数组：[{ account, topic }] / [{ label, topic }]
 *   - 多行文本："环境A=情感类\n环境B：教育类"
 * 非法项直接丢弃，不抛错（设置页允许用户乱填，保存不应因此失败）。
 */
function normalizeAccountTopics(value) {
  const result = {};
  if (!value) return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const account = String(item.account ?? item.label ?? item.name ?? "").trim();
      const topic = String(item.topic ?? item.category ?? "").trim();
      if (account && topic) result[account] = topic;
    }
    return result;
  }
  if (typeof value === "object") {
    for (const [account, topic] of Object.entries(value)) {
      const name = String(account || "").trim();
      const text = String(topic || "").trim();
      if (name && text) result[name] = text;
    }
    return result;
  }
  // 文本："账号=题材" / "账号：题材" / "账号,题材"
  for (const line of String(value).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.split(/[=:：,，\t]+/);
    const account = String(match[0] || "").trim();
    const topic = String(match.slice(1).join(" ")).trim();
    if (account && topic) result[account] = topic;
  }
  return result;
}

/** 账号绑定的题材（未绑定返回空串） */
function topicOf(label, topicMap) {
  const map = normalizeAccountTopics(topicMap);
  return String(map[String(label || "").trim()] || "").trim();
}

/** 给定题材下可用的账号（顺序跟随 envLabels，保持既有轮换语义） */
function accountsForTopic(topic, envLabels, topicMap) {
  const key = topicKey(topic);
  if (!key) return [];
  return toLabels(envLabels).filter((label) => topicKey(topicOf(label, topicMap)) === key);
}

/** 未绑定任何题材的账号 */
function unboundAccounts(envLabels, topicMap) {
  return toLabels(envLabels).filter((label) => !topicOf(label, topicMap));
}

function toLabels(envLabels) {
  return (Array.isArray(envLabels) ? envLabels : [])
    .map((env) => (env && typeof env === "object" ? env.label ?? env.name ?? "" : env))
    .map((label) => String(label || "").trim())
    .filter(Boolean);
}

/** 每账号本轮容量：两层限额取小；都为 0 表示不限 */
function capacityOf({ accountDailyLimit, perEnvLimit } = {}) {
  const limits = [accountDailyLimit, perEnvLimit]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return limits.length ? Math.min(...limits) : Infinity;
}

/**
 * 在给定账号间轮询铺开 items，直到铺完或所有账号达容量上限。
 * 返回**没铺下的**剩余项（调用方决定是告警还是回退）。
 */
function roundRobinAssign(items, slots, capacity) {
  let cursor = 0;
  let moved = true;
  while (cursor < items.length && moved) {
    moved = false;
    for (const slot of slots) {
      if (cursor >= items.length) break;
      if (slot.rows.length >= capacity) continue;
      slot.rows.push(items[cursor]);
      cursor += 1;
      moved = true;
    }
  }
  return items.slice(cursor);
}

/** 按行的题材分桶；无题材的行归入 "" 桶 */
function groupRowsByTopic(rows) {
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = topicKey((row || {}).category);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return buckets;
}

/**
 * 生成提交分配方案：{ slots, unrouted, stats }
 *   slots     [{ envLabel, topic, rows }]  每账号本轮要提交的行
 *   unrouted  因题材无对应账号 / 账号容量不足而未分配的行
 *
 * 顺序：先带走链接的行（严格一对一），再铺纯文本的行（宽松轮询）。
 * 带链接的先分配，是为了在账号额度有限时优先保住营销内容的投递。
 */
function buildAllocation(rows, envLabels, topicMap, options = {}) {
  const { strictLinkRouting = true } = options;
  const map = normalizeAccountTopics(topicMap);
  const slots = toLabels(envLabels).map((label) => ({ envLabel: label, topic: topicOf(label, map), rows: [] }));
  const capacity = capacityOf(options);
  const { link, plain } = splitRowsByKind(rows);
  const unrouted = [];
  /** 题材没有绑定账号 → 配置问题（调用方应提示去设置页绑账号） */
  const orphanByTopic = {};
  /** 账号容量吃不下 → 额度问题（调用方应提示调额度或加账号） */
  let capacityDropped = 0;

  // 1) 带链接 → 严格一对一
  for (const [key, items] of groupRowsByTopic(link)) {
    const candidates = strictLinkRouting ? slots.filter((slot) => topicKey(slot.topic) === key) : slots;
    if (!candidates.length) {
      const label = key || "(无题材)";
      orphanByTopic[label] = (orphanByTopic[label] || 0) + items.length;
      unrouted.push(...items);
      continue;
    }
    const rest = roundRobinAssign(items, candidates, capacity);
    capacityDropped += rest.length;
    unrouted.push(...rest);
  }

  // 2) 纯文本 → 宽松轮询到全部账号
  const restPlain = roundRobinAssign(plain, slots, capacity);
  capacityDropped += restPlain.length;
  unrouted.push(...restPlain);

  return {
    slots,
    unrouted,
    stats: {
      link: link.length,
      plain: plain.length,
      planned: slots.reduce((sum, slot) => sum + slot.rows.length, 0),
      unrouted: unrouted.length,
      orphanByTopic,
      capacityDropped,
      capacity,
    },
  };
}

/**
 * 上传侧题材分配：按分类规则给每行派生题材，把同题材的行分给绑定了该题材的账号。
 *
 * classify 由调用方注入（domain/topic-rules.js 的 classifyByRules），
 * 这样本模块不依赖具体规则实现，规则怎么改都不影响路由。
 *
 * 返回：
 *   slots             [{ envLabel, topic, rows }]
 *   unclassified      规则未命中的行（不参与自动分配，需调用方显式报告）
 *   orphanByTopic     { 题材: 条数 } —— 有行但无账号绑定该题材
 *   unboundAccounts   没绑定题材、本次不参与上传的账号
 */
function buildTopicAllocation(rows, envLabels, topicMap, { classify } = {}) {
  const map = normalizeAccountTopics(topicMap);
  const slots = toLabels(envLabels).map((label) => ({ envLabel: label, topic: topicOf(label, map), rows: [] }));
  const classifyFn = typeof classify === "function" ? classify : () => "";
  const buckets = new Map();
  const unclassified = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const topic = String(classifyFn(row) || "").trim();
    if (!topic) {
      unclassified.push(row);
      continue;
    }
    if (!buckets.has(topic)) buckets.set(topic, []);
    buckets.get(topic).push(row);
  }

  const orphanByTopic = {};
  for (const [topic, items] of buckets) {
    const candidates = slots.filter((slot) => topicKey(slot.topic) === topicKey(topic));
    if (!candidates.length) {
      orphanByTopic[topic] = items.length;
      continue;
    }
    // 上传没有本地额度概念（额度由平台页面的「剩余额度」实时决定），
    // 所以这里不设上限；同题材多账号时按轮询平分。
    roundRobinAssign(items, candidates, Infinity);
  }

  return {
    slots,
    unclassified,
    orphanByTopic,
    unboundAccounts: unboundAccounts(envLabels, map),
    stats: {
      total: Array.isArray(rows) ? rows.length : 0,
      classified: Array.isArray(rows) ? rows.length - unclassified.length : 0,
      unclassified: unclassified.length,
      planned: slots.reduce((sum, slot) => sum + slot.rows.length, 0),
    },
  };
}

/**
 * 把「比特环境」列表统一成环境名数组。
 * 列表里可能是 { label } / { name } 对象（设置里存的形式），也可能是裸字符串
 *（任务 payload 里手填的形式），两种都得认。
 * 这段逻辑原先在 app-context 和 upload-batch 里各抄了一份，做账号分工时才收拢。
 */
/**
 * 按并发数跑一批任务。
 *
 * 为什么默认串行：并发 = "同一时段多个账号做同样的事"，那正是平台风控最敏感的点。
 * 只有用户明确调高并发、并且自己承担（开比特窗口给每个账号独立指纹 / 或给每个账号挂代理）时才该用。
 */
async function runWithConcurrency(items, limit, worker, shouldStop) {
  const queue = (Array.isArray(items) ? items : []).slice();
  const n = Math.max(1, Math.min(Math.floor(Number(limit) || 1), queue.length || 1));
  const runners = Array.from({ length: n }, async () => {
    while (queue.length) {
      if (typeof shouldStop === "function" && shouldStop()) break;
      const item = queue.shift();
      try { await worker(item); } catch { /* 单条失败不影响其他 */ }
    }
  });
  await Promise.all(runners);
}

function envLabelsOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => (x && typeof x === "object" ? x.label ?? x.name : x))
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

/**
 * 网盘链的账号分工：解析出「谁负责转存」和「谁负责上传」。
 *
 * 为什么要分开：转存要的是**网盘空间**，上传要的是**批量发布权益**，
 * 而现实里常常是「A 的盘还有空间但没权益，B 有权益但盘满了」——
 * 一个变量管两头时，这种账号组合就用不了。两边留空即回落到 bitEnvs。
 */
function resolveNetdiskRoles(bitEnvs, { transferEnvs, uploadEnvs } = {}) {
  const base = envLabelsOf(bitEnvs);
  const transfer = envLabelsOf(transferEnvs);
  const upload = envLabelsOf(uploadEnvs);
  return {
    transferEnvs: transfer.length ? transfer : base,
    uploadEnvs: upload.length ? upload : base,
  };
}

module.exports = {
  envLabelsOf,
  runWithConcurrency,
  resolveNetdiskRoles,
  topicKey,
  normalizeAccountTopics,
  topicOf,
  accountsForTopic,
  unboundAccounts,
  capacityOf,
  roundRobinAssign,
  groupRowsByTopic,
  buildAllocation,
  buildTopicAllocation,
};
