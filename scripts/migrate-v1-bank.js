"use strict";

/**
 * 一次性迁移：v1（旧版 app.asar）内置题库 → v2 题库。
 * v1 数据位置：D:\code\baiduzhidao\内置题库\question-bank.json（UTF-8）
 * 用法：node scripts/migrate-v1-bank.js [v1_json_path] [v1_answer_records_json]
 *   第二个参数可选：v1 的 answer-records.json（含已生成回答），存在时一并迁移。
 * 幂等：v2 按 url/标题去重，重复执行安全。
 */

const fs = require("fs");
const path = require("path");

const v1Path = process.argv[2] || "D:/code/baiduzhidao/内置题库/question-bank.json";
const v1AnswersPath = process.argv[3] || "";
const v2DataDir = path.resolve(__dirname, "..", "运行缓存");

if (!fs.existsSync(v1Path)) {
  console.error(`没有找到 v1 题库文件：${v1Path}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(v1Path, "utf8"));
const items = Array.isArray(raw) ? raw : [];
console.log(`v1 题库共 ${items.length} 条`);

const { Store } = require("../electron/src/storage/store");
const store = new Store(v2DataDir);

let imported = 0;
let updated = 0;
let skipped = 0;
for (const item of items) {
  const question = {
    category: /教育/.test(String(item.category || "")) ? "教育类" : /综合/.test(String(item.category || "")) ? "综合类" : "情感类",
    title: item.title || "",
    questionContent: item.questionContent || "",
    questionUrl: item.questionUrl || "",
    bitEnv: item.bitEnv || "",
    status: item.status || "v1迁移",
    createdAt: item.createdAt || "",
  };
  if (!question.title && !question.questionUrl) {
    skipped += 1;
    continue;
  }
  const result = store.addBankQuestion(question);
  if (result === "added") imported += 1;
  else if (result === "updated") updated += 1;
}
store.flushAll();

console.log(`迁移完成：新增 ${imported} 条，补充 ${updated} 条，跳过 ${skipped} 条`);
console.log(`v2 题库总计：${store.bankSize()} 条（${path.join(v2DataDir, "bank.json")}）`);

// 可选：迁移 v1 答题记录（已生成的回答）
if (v1AnswersPath) {
  if (!fs.existsSync(v1AnswersPath)) {
    console.error(`没有找到 v1 答题记录：${v1AnswersPath}`);
  } else {
    const records = JSON.parse(fs.readFileSync(v1AnswersPath, "utf8"));
    let migratedAnswers = 0;
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || (!record.answer && !record.questionUrl && !record.title)) continue;
      store.upsertAnswer({
        title: record.title || "",
        questionContent: record.questionContent || "",
        answer: record.answer || "",
        questionUrl: record.questionUrl || "",
        bitEnv: record.bitEnv || "",
        status: record.status || "已生成回答",
        createdAt: record.createdAt || "",
        submittedAt: record.submittedAt || "",
      });
      migratedAnswers += 1;
    }
    store.flushAll();
    console.log(`答题记录迁移：${migratedAnswers} 条 → ${path.join(v2DataDir, "answers.json")}`);
  }
}
