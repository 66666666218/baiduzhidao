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
const { Store } = require("../electron/src/storage/store");
const { buildQualityGate } = require("../electron/src/quality/gate");

// 双开保护：同一张表只允许一个生成进程，否则两个写手会互相覆盖 xlsx，
// 并对 usage.json 做读-改-写竞争（今天已产生两个损坏备份），token 还会双倍消耗。
const lockFile = path.join(dataDir, `${path.basename(srcFile)}.生成中.lock`);

function acquireLock() {
  const release = () => {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* 已释放 */
    }
  };
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = Number(String(fs.readFileSync(lockFile, "utf8")).trim());
    let alive = false;
    if (holder && holder !== process.pid) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      console.error(`另一个 workbench-generate 正在处理 ${path.basename(srcFile)}（PID ${holder}），本次退出。`);
      process.exit(1);
    }
    fs.writeFileSync(lockFile, String(process.pid));
  }
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      // Ctrl+C 时把内存里已生成的答案先落盘，否则这一段付费结果直接蒸发
      try {
        if (flushTable) flushTable();
        if (flushUsage) flushUsage();
      } catch (error) {
        console.error(`中断落盘失败：${error.message}`);
      }
      release();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** 中断保存钩子，主流程解析完表格后赋值 */
let flushTable = null;
/** usage 记账落盘钩子（Store 是 500ms 防抖写盘，直接 exit 会吞掉尾部几条） */
let flushUsage = null;

/**
 * 先写临时文件再改名覆盖：XLSX.writeFile 直接写目标时，Excel 占用或写到一半断电
 * 都会把原表截断/毁掉（本轮已生成的答案全在内存里，跟着一起丢）。
 */
function saveTable(wb, target, log) {
  const tmpPath = `${target}.${process.pid}.写盘中.xlsx`;
  try {
    XLSX.writeFile(wb, tmpPath);
    fs.renameSync(tmpPath, target);
    return target;
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* 临时文件可能没建成 */
    }
    const backup = path.join(
      path.dirname(target),
      `${path.basename(target, path.extname(target))}_备份_${Date.now()}${path.extname(target)}`
    );
    XLSX.writeFile(wb, backup);
    log(`⚠ 目标表格无法写入（${error.code || error.message}），本轮已另存：${path.basename(backup)}。请关闭 Excel 后把该文件改名换回。`);
    return backup;
  }
}

(async () => {
  const config = new Config(dataDir);
  const settings = config.load();
  // 整轮只建一个 Store：以前每次 AI 调用、每行预算检查都 new 一个，
  // 既会把 owner 写成默认的 "gui"（骗过外来写入者检测），也会反复整读 bank.json。
  const usageStore = new Store(dataDir, { owner: "cli:workbench-generate" });
  if (usageStore.foreignWriter) {
    console.warn(`⚠️ 检测到主程序（进程 ${usageStore.foreignWriter.pid}）也在写同一目录，日预算可能互相覆盖。`);
  }
  flushUsage = () => usageStore.flushAll();
  const llm = new LlmClient({
    apiKey: settings.aiApiKey,
    baseUrl: settings.aiBaseUrl,
    model: settings.aiModel,
    concurrency: settings.aiConcurrency,
    temperature: settings.aiTemperature,
    onUsage: (entry) => {
      // 用量记账进 store（复用 Store 的 usage 通道）
      try {
        usageStore.addUsage(entry);
      } catch (error) {
        console.warn(`usage 记账失败，日预算可能少算：${error.message}`);
      }
    },
  });
  const gate = buildQualityGate({});
  acquireLock();
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
  flushTable = () => {
    XLSX.utils.sheet_add_json(sheet, rows, { skipHeader: true, origin: "A2" });
    saveTable(wb, srcFile, log);
  };

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
        const used = usageStore.getUsageToday();
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
      saveTable(wb, srcFile, log);
      log(`已阶段性保存 ${done} 行到 ${path.basename(srcFile)}`);
    }
  }

  // 最终保存
  XLSX.utils.sheet_add_json(sheet, rows, { skipHeader: true, origin: "A2" });
  saveTable(wb, srcFile, log);
  const filled = rows.filter((r) => String(r[kAnswer] || "").trim()).length;
  log(`=== 生成完成：本轮 ${done} 行（REVIEW ${review}），表内已填 ${filled}/${rows.length} ===`);
  if (flushUsage) flushUsage(); // 防抖尾部的 usage 记录必须落盘，否则今日用量少算
  process.exit(0);
})().catch((error) => {
  console.error("FATAL:", error.message);
  try {
    if (flushTable) flushTable();  // 异常退出同样保住已生成的答案
    if (flushUsage) flushUsage();
  } catch (saveError) {
    console.error(`异常退出前保存失败：${saveError.message}`);
  }
  process.exit(1);
});
