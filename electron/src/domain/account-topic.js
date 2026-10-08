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

module.exports = {
  topicKey,
  normalizeAccountTopics,
  topicOf,
  accountsForTopic,
  unboundAccounts,
  capacityOf,
  roundRobinAssign,
  groupRowsByTopic,
  buildAllocation,
};
