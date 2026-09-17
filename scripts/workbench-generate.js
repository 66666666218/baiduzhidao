"use strict";

/**
 * 工作台批量生成：读工作台导出的问题表，AI 生成回答填入「回答内容」列。
 * 断点续跑：进度实时写回 xlsx + 光标文件，中断后重跑自动继续。
 * 用法：node scripts/workbench-generate.js [xlsx路径] [数量上限]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "运行缓存");
const srcFile = process.argv[2] || path.join(dataDir, "workbench-all-questions.xlsx");
const limit = Math.max(1, Number(process.argv[3]) || 4900);

const { Config } = require("../electron/src/config");
const { LlmClient } = require("../electron/src/llm/client");
const { buildQualityGate } = require("../electron/src/quality/gate");

(async () => {
  const config = new Config(dataDir);
  const settings = config.load();
  const llm = new LlmClient({
    apiKey: settings.aiApiKey,
    baseUrl: settings.aiBaseUrl,
    model: settings.aiModel,
    concurrency: settings.aiConcurrency,
    temperature: settings.aiTemperature,
    onUsage: (entry) => {
      // 用量记账进 store（复用 Store 的 usage 通道）
      try {
        const { Store } = require("../electron/src/storage/store");
        new Store(dataDir).addUsage(entry);
      } catch {
        /* 忽略 */
      }
    },
  });
  const gate = buildQualityGate({});
  const log = (m) => {
    const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${m}`;
    console.log(line);
    try {
      fs.appendFileSync(path.join(dataDir, "logs", "workbench-generate.log"), line + "\n", "utf8");
    } catch {
      /* 忽略 */
    }
  };

  const wb = XLSX.readFile(srcFile);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const keys = Object.keys(rows[0] || {});
  const kTitle = keys.find((k) => k.includes("问题标题"));
  const kAnswer = keys.find((k) => k.includes("回答内容"));
  if (!kTitle || !kAnswer) throw new Error(`表格列不符合预期：${JSON.stringify(keys)}`);

  // 断点光标：回答内容已非空的行跳过
  const pending = [];
  rows.forEach((row, index) => {
    if (!String(row[kAnswer] || "").trim() && pending.length < limit) pending.push({ row, index });
  });
  log(`=== 工作台批量生成：总 ${rows.length} 行，待生成 ${pending.length} 行（上限 ${limit}） ===`);
  if (!pending.length) {
    console.log("没有待生成的行。");
    process.exit(0);
  }

  let done = 0;
  let review = 0;
  const saveEvery = 50;
  for (const { row, index } of pending) {
    if (settings.aiDailyTokenBudget > 0) {
      // 预算保护：由 store 记账判断（简化：超过即停）
      try {
        const { Store } = require("../electron/src/storage/store");
        const used = new Store(dataDir).getUsageToday();
        if (used >= settings.aiDailyTokenBudget) {
          log(`⛔ 今日预算已用尽（${used} tokens），停止生成。已完成 ${done}/${pending.length}。`);
          break;
        }
      } catch {
        /* 记账失败不阻塞 */
      }
    }
    const title = String(row[kTitle] || "").trim();
    if (!title) {
      done += 1;
      continue;
    }
    let answer = "";
    try {
      answer = await llm.generateAnswer({ title, questionContent: "" }, { onLog: () => {} });
    } catch (error) {
      log(`生成失败：${title.slice(0, 24)} → ${error.message.slice(0, 60)}`);
    }
    if (answer) {
      const verdict = gate.evaluate(answer, { title, questionContent: "" });
      row[kAnswer] = answer;
      if (verdict.decision === "REVIEW") {
        review += 1;
        log(`⚠ 质检 REVIEW(${verdict.score})：${title.slice(0, 24)} → ${verdict.reviewReason}`);
      }
    }
    done += 1;
    if (done % 10 === 0) log(`进度 ${done}/${pending.length}（REVIEW ${review}）`);
    if (done % saveEvery === 0) {
      XLSX.utils.sheet_add_json(sheet, rows, { skipHeader: true, origin: "A2" });
      XLSX.writeFile(wb, srcFile);
      log(`已阶段性保存 ${done} 行到 ${path.basename(srcFile)}`);
    }
  }

  // 最终保存
  XLSX.utils.sheet_add_json(sheet, rows, { skipHeader: true, origin: "A2" });
  XLSX.writeFile(wb, srcFile);
  const filled = rows.filter((r) => String(r[kAnswer] || "").trim()).length;
  log(`=== 生成完成：本轮 ${done} 行（REVIEW ${review}），表内已填 ${filled}/${rows.length} ===`);
  process.exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  process.exit(1);
});
