"use strict";

/**
 * 大批量问答生成器（另一套答题 · 按用户模板）：
 *   资源表（文件名/链接/提取码）→ 逐条套用答题模板 → 三列问答表（qid/问题标题/回答内容）
 *
 * 模板（来源：B202608100524375b57(1).xlsx · 百度知道问答）：
 *   <p><strong>点击链接获取网盘资源：</strong><br/></p>
 *   <p>{链接}<br/></p>
 *   <p>简介：{简介}</p>
 *   <img src="" />
 *
 * 质量控制：
 *   - 命名解析：标准四段/[名][年][类型]/点分体/英文名 混合格式 → 抽取 名称/年份/类型/国家
 *   - 剔除：压缩包(.rar/.zip)、脏行（链接列为"链接"）、重复链接、超长名
 *   - 标题：多模板轮换 + 5~49 字硬校验 + 全局查重
 *   - 简介：按 元数据规则化生成（年份/国家/类型），200 字内
 *
 * 用法：node scripts/mass-qa-template.js <资源表.xlsx> [输出目录] [每文件行数=5000] [--no-img]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

// ---------- 参数 ----------
const srcFile = process.argv[2] && !process.argv[2].startsWith("--")
  ? path.resolve(process.argv[2]) : null;
const outDir = process.argv[3] && !process.argv[3].startsWith("--")
  ? path.resolve(process.argv[3]) : path.join(__dirname, "..", "运行缓存", "答题模板QA");
const chunkRows = Math.max(100, Number(process.argv[4]) || 5000);
const keepImg = !process.argv.includes("--no-img");

if (!srcFile || !fs.existsSync(srcFile)) {
  console.error("用法: node scripts/mass-qa-template.js <资源表.xlsx> [输出目录] [每文件行数=5000] [--no-img]");
  process.exit(1);
}

// ---------- 生成逻辑（共享库 qa-template-lib） ----------
const qaLib = require("../electron/src/netdisk/qa-template-lib");
const parseName = qaLib.parseName;
const reject = qaLib.reject;
const buildTitle = qaLib.buildTitle;
const buildIntro = qaLib.buildIntro;
const buildAnswerHtml = (link, intro) => qaLib.buildAnswerHtml(link, intro, keepImg);

// ---------- 主流程 ----------
(async () => {
  const wb = XLSX.readFile(srcFile);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  console.log(`读取 ${raw.length} 行（工作表: ${wb.SheetNames[0]}）`);

  const seenLinks = new Set();
  const seenTitles = new Set();
  const qaRows = [];
  const rejected = [];
  let titleIdx = 0;

  for (const row of raw) {
    const keys = Object.keys(row);
    const name = String(row[keys[0]] || "").trim();
    const link = String(row[keys[1]] || "").trim();
    const bad = reject(name, link);
    if (bad) { rejected.push({ name: name.slice(0, 30), reason: bad }); continue; }
    if (seenLinks.has(link)) { rejected.push({ name: name.slice(0, 30), reason: "重复链接" }); continue; }

    const meta = parseName(name);
    if (!meta.title || meta.title.length < 2) { rejected.push({ name: name.slice(0, 30), reason: "名称解析失败" }); continue; }

    let title = buildTitle(meta, titleIdx);
    let tries = 0;
    while (seenTitles.has(title) && tries < qaLib.TITLE_PATTERNS.length) {
      titleIdx += 1;
      title = buildTitle(meta, titleIdx);
      tries += 1;
    }
    if (seenTitles.has(title)) { title = `${title} ${link.slice(-4)}`.slice(0, 49); }
    seenLinks.add(link);
    seenTitles.add(title);
    titleIdx += 1;

    qaRows.push({
      "qid": "",
      "问题标题": title,
      "回答内容": buildAnswerHtml(link, buildIntro(meta)),
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const chunks = Math.ceil(qaRows.length / chunkRows);
  for (let c = 0; c < chunks; c += 1) {
    const part = qaRows.slice(c * chunkRows, (c + 1) * chunkRows);
    const ws = XLSX.utils.json_to_sheet(part, { header: ["qid", "问题标题", "回答内容"] });
    const wbout = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbout, ws, "百度知道问答");
    const file = path.join(outDir, `问答-第${c + 1}批-${part.length}条.xlsx`);
    XLSX.writeFile(wbout, file);
    console.log(`  已写出 ${path.basename(file)}`);
  }

  console.log("=== 生成完成 ===");
  console.log(`合格: ${qaRows.length} | 剔除: ${rejected.length}`);
  const reasonCount = {};
  for (const r of rejected) reasonCount[r.reason] = (reasonCount[r.reason] || 0) + 1;
  console.log("剔除分布:", JSON.stringify(reasonCount));
  console.log(`输出目录: ${outDir}`);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 160)); process.exit(1); });
