"use strict";

const { normalizeCategories } = require("../config");

/**
 * 随机抽题（纯函数，可测）：
 * - 按分类过滤题库
 * - 跨轮次去重（usedKeys）；全部用完后自动重开一轮
 * - 返回抽中的题目与下一轮 usedKeys
 */
function randomPickQuestions(bank, usedKeys, { categories, count } = {}) {
  const selectedCategories = new Set(normalizeCategories(categories));
  const pool = (bank || []).filter((item) => {
    const category = String(item.category || "").trim();
    return !category || selectedCategories.has(category);
  });
  const keyOf = (item) => {
    const url = String(item.questionUrl || "").trim().toLowerCase();
    return url ? `url:${url}` : `title:${String(item.title || "").replace(/\s+/g, "").toLowerCase()}`;
  };

  const bankKeys = new Set(pool.map(keyOf));
  let used = (usedKeys || []).filter((key) => bankKeys.has(key));
  let available = pool.filter((item) => !used.includes(keyOf(item)));
  let resetRound = false;
  if (!available.length) {
    used = [];
    available = pool.slice();
    resetRound = true;
  }

  const shuffled = shuffle(available);
  const picked = shuffled.slice(0, Math.min(Math.max(1, Number(count) || 1), available.length));
  const nextUsed = Array.from(new Set([...used, ...picked.map(keyOf)]));
  const remainingAfter = Math.max(0, pool.length - nextUsed.length);

  return {
    picked: picked.map((item) => ({ ...item, answer: "", status: "随机抽取" })),
    usedKeys: nextUsed,
    total: pool.length,
    remainingAfter,
    resetRound,
  };
}

function shuffle(list) {
  const cloned = Array.from(list || []);
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

module.exports = { randomPickQuestions, shuffle };
