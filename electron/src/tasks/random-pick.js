"use strict";

const { normalizeCategories } = require("../config");

/**
 * 随机抽题（纯函数，可测）：
 * - 按分类过滤题库
 * - 跨轮次去重（usedKeys）；全部用完后自动重开一轮
 * - 采样策略：
 *     random        随机（默认）
 *     newest        最新入库优先
 *     oldest        最早入库优先
 *     unanswered    无回答内容优先（工作台批量场景）
 *     category-balanced 分类均衡（每类数量尽量相等）
 */

const STRATEGIES = new Set(["random", "newest", "oldest", "unanswered", "category-balanced"]);

function randomPickQuestions(bank, usedKeys, options) {
  // options 显式传 null 时解构默认值不生效（只对 undefined 生效），会直接 TypeError
  const { categories, count, strategy = "random" } = options || {};
  const selectedCategories = new Set(normalizeCategories(categories));
  const pool = (Array.isArray(bank) ? bank : []).filter((item) => {
    if (!item || typeof item !== "object") return false; // 题库 JSON 被半写坏时数组里可能混进 null
    const category = String(item.category || "").trim();
    return !category || selectedCategories.has(category);
  });
  const keyOf = (item) => {
    const url = String(item.questionUrl || "").trim().toLowerCase();
    return url ? `url:${url}` : `title:${String(item.title || "").replace(/\s+/g, "").toLowerCase()}`;
  };

  const bankKeys = new Set(pool.map(keyOf));
  // 用 Set 而不是数组 includes：万级题库 × 千级已用键时，逐项线性扫描会在主进程里
  // 独占事件循环好几秒，界面在这段时间整个假死。
  let used = new Set((Array.isArray(usedKeys) ? usedKeys : []).filter((key) => bankKeys.has(key)));
  let available = pool.filter((item) => !used.has(keyOf(item)));
  let resetRound = false;
  if (!available.length) {
    used = new Set();
    available = pool.slice();
    resetRound = true;
  }

  const takeCount = Math.min(Math.max(1, Number(count) || 1), available.length);
  const picked = sample(available, strategy, takeCount);
  const nextUsed = Array.from(new Set([...used, ...picked.map(keyOf)]));
  const remainingAfter = Math.max(0, pool.length - nextUsed.length);

  return {
    picked: picked.map((item) => ({ ...item, answer: "", status: "随机抽取" })),
    usedKeys: nextUsed,
    total: pool.length,
    remainingAfter,
    resetRound,
    strategy: normalizeStrategy(strategy),
  };
}

function normalizeStrategy(strategy) {
  const text = String(strategy || "random").trim().toLowerCase();
  return STRATEGIES.has(text) ? text : "random";
}

/** 按策略从 available 中取 take 条（纯函数，不改输入） */
function sample(available, strategy, take) {
  if (strategy === "newest") {
    // createdAt 降序（新在前）；无时间戳的排最后。
    // 先洗牌再排序：sort 稳定，同时间戳（爬题批量入库时精度只到秒）会永远保持入库顺序，
    // 于是每一轮都抽到同一批题——洗牌让并列项随机化。
    const sorted = shuffle(available).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return sorted.slice(0, take);
  }
  if (strategy === "oldest") {
    const sorted = shuffle(available).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    return sorted.slice(0, take);
  }
  if (strategy === "unanswered") {
    const noAnswer = available.filter((item) => !String(item.answer || "").trim());
    const withAnswer = available.filter((item) => String(item.answer || "").trim());
    return [...shuffle(noAnswer), ...shuffle(withAnswer)].slice(0, take);
  }
  if (strategy === "category-balanced") {
    // 按分类分桶轮转取，直到取满
    const buckets = new Map();
    for (const item of shuffle(available)) {
      const key = String(item.category || "").trim() || "未分类";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
    }
    const out = [];
    let added = true;
    while (out.length < take && added) {
      added = false;
      for (const bucket of buckets.values()) {
        if (bucket.length && out.length < take) {
          out.push(bucket.shift());
          added = true;
        }
      }
    }
    return out;
  }
  // random（默认）
  return shuffle(available).slice(0, take);
}

function shuffle(list) {
  const cloned = Array.from(list || []);
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

module.exports = { randomPickQuestions, shuffle, normalizeStrategy };
