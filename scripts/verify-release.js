"use strict";

/**
 * 发版收尾的三条硬校验（以前每轮都是手敲一段 node -e，还老被 shell 吃掉反斜杠）。
 *
 *   ① `latest.yml` 里的 `sha512` 必须等于本地 exe 实算的 sha512
 *      —— 不等 = 客户端下载完校验失败 = "发了但更新不了"，而且**不报错**，最难查的一类。
 *   ② 三件套（exe / latest.yml / blockmap）的 sha256 打出来，
 *      用来和 GitHub API 的 `assets[].digest` 逐一比对
 *      —— 比把 85MB 下载回来再算快得多，而且能证明"上传过程中没损坏"。
 *   ③ `latest.yml` 的 `version` 必须等于 package.json 的版本
 *      —— 不 bump 版本号的话，客户端按版本比较会认为"已是最新"（这是老坑，写进 MEMORY 了）。
 *
 * 用法：node scripts/verify-release.js
 * 退出码：0 = 全过；1 = 有硬失败
 *
 * ⚠️ 只读、只打印指纹与版本号，**不打印任何仓库地址**（用户明确要求地址不外泄）。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

const exe = path.join(ROOT, "dist", `zhidao-answer-studio-${version}.exe`);
const yml = path.join(ROOT, "dist", "latest.yml");
const blockmap = `${exe}.blockmap`;

/** 从 latest.yml 里取一个顶格字段（故意不用正则转义，免得又被 shell 吃掉反斜杠） */
function ymlField(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 只认顶格的（files 下面那些是缩进的，不能混进来）
    if (line === trimmed && trimmed.startsWith(`${key}:`)) {
      return trimmed.slice(key.length + 1).trim();
    }
  }
  return "";
}

const hash = (file, algo) => crypto.createHash(algo).update(fs.readFileSync(file)).digest(algo === "sha512" ? "base64" : "hex");

const failures = [];

// ---- 文件在不在 ----
for (const file of [exe, yml, blockmap]) {
  if (!fs.existsSync(file)) failures.push(`缺少产物：${path.relative(ROOT, file)}（先跑 npm run dist）`);
}
if (failures.length) {
  console.error(failures.map((f) => `❌ ${f}`).join("\n"));
  process.exit(1);
}

// ---- ① sha512 必须对得上 ----
const ymlText = fs.readFileSync(yml, "utf8");
const declared = ymlField(ymlText, "sha512");
const actual = hash(exe, "sha512");
console.log(`产物：dist/zhidao-answer-studio-${version}.exe`);
if (declared !== actual) {
  failures.push("latest.yml 的 sha512 与安装包对不上 —— 客户端下载后校验会失败，表现是「发了但更新不了」且不报错");
  console.log("  ✗ sha512 不一致");
  console.log(`      实算：${actual}`);
  console.log(`      yml ：${declared}`);
} else {
  console.log("  ✓ sha512 与 latest.yml 一致");
}

// ---- ③ 版本号必须对得上 ----
const ymlVersion = ymlField(ymlText, "version");
const ymlPath = ymlField(ymlText, "path");
if (ymlVersion !== version) {
  failures.push(`latest.yml 的 version（${ymlVersion}）≠ package.json（${version}）—— 客户端会认为「已是最新」`);
  console.log(`  ✗ 版本号不一致：yml=${ymlVersion} package.json=${version}`);
} else {
  console.log(`  ✓ 版本号 ${version} 一致`);
}
if (ymlPath && ymlPath !== path.basename(exe)) {
  failures.push(`latest.yml 的 path（${ymlPath}）指向的不是这个安装包`);
  console.log(`  ✗ path 字段指向 ${ymlPath}`);
}

// ---- ② 打指纹，用来和 GitHub 线上比对 ----
console.log("\n三件套 sha256（与 GitHub API 的 assets[].digest 逐一比对）：");
for (const file of [exe, yml, blockmap]) {
  console.log(`  ${hash(file, "sha256")}  ${path.basename(file)}`);
}
console.log("  （比对方式：查 GitHub API 的 releases/latest，看 assets[].digest —— 不要把这个地址写进注释或日志）");

if (failures.length) {
  console.error(`\n❌ 发版校验未通过：\n${failures.map((f) => `  · ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\n✅ 发版校验通过（sha512 / 版本号 / 三件套指纹都齐了）");
