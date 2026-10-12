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

/**
 * 「取工作簿的第一张表名」—— 单独拎出来是因为 **`SheetNames` 可能为空**：
 * 直接写 `workbook.Sheets[sheetName]` 会拿到 `undefined`，再喂给 `sheet_to_json` 就是一句
 * 无头绪的 TypeError。放在这里就能让空表退化成空结果，而不是让整条跑批崩掉。
 * （⚠️ 实测：`XLSX.writeFile` 对无表工作簿一律抛 `Workbook is empty`，
 *   xlsx/csv/ods/html/biff8 全试过都写不出来 —— 所以这个分支**造不出磁盘夹具**，
 *   只能靠这个纯函数单点验证，别指望端到端构造。）
 *
 * @param {{SheetNames?: string[]}} [workbook]
 * @returns {string} 空则退化成 ""
 */
function firstSheetName(workbook) {
  const names = workbook && workbook.SheetNames;
  return (names && names[0]) || "";
}

/**
 * 读第一张表：**同时**返回表名与行。给"读完还要用表名去写输出表"的调用方用
 * （这样只需要读一次盘；否则为了拿表名得再 `XLSX.readFile` 一遍）。
 *
 * @param {string} filePath
 * @param {{raw?: boolean}} [options] 见 readTableRows
 * @returns {{sheetName: string, rows: object[]}}
 */
function readFirstSheet(filePath, options) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = firstSheetName(workbook);
  if (!sheetName) return { sheetName: "", rows: [] };
  const jsonOptions = { defval: "" };
  if (options && options.raw !== undefined) jsonOptions.raw = options.raw;
  return { sheetName, rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], jsonOptions) };
}

/**
 * 读第一张表的行。**这是全仓唯一该读 xlsx 的地方**（应用内核与 scripts/ 都走它）。
 *
 * @param {string} filePath
 * @param {{raw?: boolean}} [options]
 *   `raw: false` —— 让单元格按**显示文本**返回，而不是原始值。
 *   ⚠️ 这个选项对「资源表/链接表」是**必须**的：提取码这类"看着像数字"的列，
 *   `raw` 模式下 Excel 会把 `0023` 变成数字 `23`（前导零没了）、超长数字串还会变科学计数法
 *   —— 直接丢数据、而且丢得悄无声息。所以第 14 轮把 scripts/ 里原本传 `{raw:false}` 的
 *   几处统一收敛到这里，选项做成**显式参数**而不是默默统一（两种行为在仓库里同时存在过）。
 *   不传 = 保持历史默认（按原始值），那 12 处应用内核调用行为完全不变。
 */
function readTableRows(filePath, options) {
  return readFirstSheet(filePath, options).rows;
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
    // 一/二级分类：表头里一直有，但此前既没读也没写，表格带这两列过一遍应用就会丢
    primaryCategory: String(pickCell(row, ["一级分类"]) || "").trim(),
    secondaryCategory: String(pickCell(row, ["二级分类"]) || "").trim(),
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
    // 质检结论必须**读回来**。`answerToRow` 一直在写「质检」列，这里却从来没读过 ——
    // 于是"生成时判为需复核"的结论一进表格就丢了：一键全自动的提交阶段重读表格，
    // AI 痕迹明显 / 答非所问的答案被当成正常答案提交出去，全程无人值守。
    // 这就是典型的"写了一半的往返"：光写不读，等于没写。
    quality: String(pickCell(row, ["质检", "quality"]) || "").trim(),
    createdAt: String(pickCell(row, ["生成时间", "采集时间", "时间"]) || "").trim(),
  };
}

function answerToRow(item) {
  return {
    题库分类: item.category || "",
    一级分类: item.primaryCategory || "",
    二级分类: item.secondaryCategory || "",
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
    一级分类: item.primaryCategory || "",
    二级分类: item.secondaryCategory || "",
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
  // 题目原文可能以 = + - @ 开头，Excel/WPS 会把它当公式执行（=HYPERLINK 能把单元格内容发出去）
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
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
  firstSheetName,
  readFirstSheet,
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
