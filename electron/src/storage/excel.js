"use strict";

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const ANSWER_HEADERS = ["题库分类", "一级分类", "二级分类", "标题", "问题内容", "回答内容", "复制用答案", "题目地址", "比特环境", "状态", "质检", "生成时间"];
const BANK_HEADERS = ["题库分类", "一级分类", "二级分类", "标题", "问题内容", "题目地址", "比特环境", "状态", "采集时间"];

function isTableFile(filePath) {
  return [".xlsx", ".xls", ".csv"].includes(path.extname(String(filePath || "")).toLowerCase());
}

function collectTableFiles(targetPath) {
  const normalized = String(targetPath || "").trim().replace(/^"|"$/g, "");
  if (!normalized || !fs.existsSync(normalized)) return [];
  const stat = fs.statSync(normalized);
  if (stat.isFile()) return isTableFile(normalized) ? [normalized] : [];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(normalized)
    .filter((name) => !name.startsWith("~$") && isTableFile(name))
    .map((name) => path.join(normalized, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function readTableRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
}

function pickCell(row, headers) {
  for (const header of headers) {
    if (Object.prototype.hasOwnProperty.call(row, header) && row[header] !== "") return row[header];
  }
  return "";
}

function importRowToQuestion(row, sourceCategory = "") {
  const category = pickCell(row, ["题库分类", "分类", "category"]);
  return {
    category: String(category || sourceCategory || "").trim(),
    title: String(pickCell(row, ["标题", "题目", "问题", "title"]) || "").trim(),
    questionContent: String(pickCell(row, ["问题内容", "题目内容", "正文", "content"]) || "").replace(/\r\n/g, "\n").trim(),
    answer: "",
    questionUrl: String(pickCell(row, ["去答题链接", "题目地址", "问题链接", "链接", "questionUrl", "url", "link"]) || "").trim(),
    bitEnv: String(pickCell(row, ["比特环境", "bitEnv"]) || "").trim(),
    status: String(pickCell(row, ["状态", "采集状态", "status"]) || "表格导入").trim(),
    createdAt: String(pickCell(row, ["采集时间", "生成时间", "时间"]) || "").trim(),
  };
}

function importRowToAnswer(row) {
  const question = importRowToQuestion(row);
  return {
    ...question,
    answer: String(pickCell(row, ["回答内容", "复制用答案", "answer"]) || "").replace(/\r\n/g, "\n"),
    status: String(pickCell(row, ["状态", "status"]) || "已导入").trim(),
    createdAt: String(pickCell(row, ["生成时间", "采集时间", "时间"]) || "").trim(),
  };
}

function answerToRow(item) {
  return {
    题库分类: item.category || "",
    标题: item.title || "",
    问题内容: item.questionContent || "",
    回答内容: item.answer || "",
    复制用答案: item.answer || "",
    题目地址: item.questionUrl || "",
    比特环境: item.bitEnv || "",
    状态: item.status || "",
    质检: item.quality || "",
    生成时间: item.createdAt || "",
  };
}

function bankToRow(item) {
  return {
    题库分类: item.category || "",
    标题: item.title || "",
    问题内容: item.questionContent || "",
    题目地址: item.questionUrl || "",
    比特环境: item.bitEnv || "",
    状态: item.status || "",
    采集时间: item.createdAt || "",
  };
}

function writeWorkbook(filePath, rows, sheetName, headers) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const worksheet = XLSX.utils.json_to_sheet(rows, headers ? { header: headers } : undefined);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName || "Sheet1");
  XLSX.writeFile(workbook, filePath);
}

/** 写入失败（例如文件被 Excel 打开占用）时自动另存备份，返回实际写入路径。 */
function writeWorkbookSafe(filePath, rows, sheetName, headers, onLog) {
  try {
    writeWorkbook(filePath, rows, sheetName, headers);
    return filePath;
  } catch (error) {
    const fallbackPath = path.join(
      path.dirname(filePath),
      `${path.basename(filePath, path.extname(filePath))}_备份_${Date.now()}${path.extname(filePath)}`
    );
    writeWorkbook(fallbackPath, rows, sheetName, headers);
    if (typeof onLog === "function") onLog(`目标表格被占用，已另存备份：${fallbackPath}（${error.message}）`);
    return fallbackPath;
  }
}

function writeBankTxt(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [`\uFEFF${BANK_HEADERS.join("\t")}`];
  for (const item of items) {
    const row = bankToRow(item);
    lines.push(BANK_HEADERS.map((header) => String(row[header] ?? "").replace(/\r?\n/g, " ").replace(/\t/g, " ").trim()).join("\t"));
  }
  fs.writeFileSync(filePath, `${lines.join("\r\n")}\r\n`, "utf8");
}

/** CSV 自动保存兜底：任务运行中逐条追加，防 Excel 被占用/崩溃丢记录。 */
function appendCsvRow(filePath, row, headers) {
  const exists = fs.existsSync(filePath);
  if (!exists) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `\uFEFF${headers.map(csvCell).join(",")}\r\n`, "utf8");
  }
  fs.appendFileSync(filePath, `${headers.map((header) => csvCell(row[header])).join(",")}\r\n`, "utf8");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base}_${index}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

module.exports = {
  ANSWER_HEADERS,
  BANK_HEADERS,
  isTableFile,
  collectTableFiles,
  readTableRows,
  importRowToQuestion,
  importRowToAnswer,
  answerToRow,
  bankToRow,
  writeWorkbook,
  writeWorkbookSafe,
  writeBankTxt,
  appendCsvRow,
  uniqueFilePath,
};
