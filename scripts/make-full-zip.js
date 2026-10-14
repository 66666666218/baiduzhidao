"use strict";

/**
 * 把 `dist/win-unpacked` 打成「完整包」zip（免安装版，结构与既有交付包一致：
 * 顶层目录 `百度知道答题助手v2/`，用户解压后直接双击里面的 exe 就能用）。
 *
 * 为什么要有个脚本（以前每轮都是手敲一遍命令）：
 *   ① **必须用真的 zip**：Git Bash 里 `tar -a -c -f x.zip` 产出的是**裸 tar**，
 *      扩展名骗人、双击打不开。以前踩过，所以这里用 archiver 并且**校验头四字节必须是 504b0304**。
 *   ② 版本号从 package.json 取：手敲时极易写错版本，而交付物名字里就带着版本号，
 *      名字对了内容却是旧的（或反过来）都很难当场发现。
 *
 * 用法：node scripts/make-full-zip.js [输出路径]
 * 退出码：0 = 成功且头四字节正确；1 = 失败
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const src = path.join(ROOT, "dist", "win-unpacked");
const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "dist", `百度知道答题助手-完整包-${pkg.version}.zip`);

if (!fs.existsSync(src)) {
  console.error(`❌ 找不到 ${path.relative(ROOT, src)} —— 先跑 npm run dist。`);
  process.exit(1);
}

// archiver 不在 package.json 的 dependencies 里（它是打包工具、不随产品发布），
// 只在本机 devDependencies/node_modules 里，拿不到就直说，别让人对着 MODULE_NOT_FOUND 猜。
let archiver;
try {
  archiver = require(path.join(ROOT, "node_modules", "archiver"));
} catch {
  console.error("❌ 需要 archiver（打包工具，不进产品依赖）：npm i -D archiver");
  process.exit(1);
}

const output = fs.createWriteStream(out);
const zip = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  const head = fs.readFileSync(out).subarray(0, 4).toString("hex");
  const size = fs.statSync(out).size;
  const ok = head === "504b0304"; // PK\x03\x04
  console.log(`完整包：${out}`);
  console.log(`大小 ${(size / 1048576).toFixed(1)} MB，头四字节 ${head}${ok ? "（真 zip ✓）" : "（❌ 不是 zip！）"}`);
  process.exit(ok ? 0 : 1);
});

zip.on("error", (error) => {
  console.error(`❌ 打包失败：${error.message}`);
  process.exit(1);
});

zip.pipe(output);
zip.directory(src, "百度知道答题助手v2");
zip.finalize();
