"use strict";

/**
 * 打包后逐文件比对：asar 里的字节 == 磁盘上刚改完的源码。
 *
 * 为什么单有这个脚本还不够、必须每轮跑：第 19 轮在 `npm run dist` 期间又改了源码，
 * 结果 asar 里装的是改动前的旧码、而单测跑的是磁盘上的新码 → **测试全绿但包是坏的**。
 * 从那以后，发版前必须机械地确认"进包的字节"和"测过的字节"是同一份。
 *
 * 用法：node scripts/verify-asar-bytes.js
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * 需要**逐字节**比对的文件：仓库相对路径 → asar 内相对路径（以 app.asar 根为基准）。
 *
 * ⚠️ 这里**不含 `package.json`**：electron-builder 会重写它（裁掉 devDependencies / scripts /
 * build 之外的字段），所以它的字节必然与磁盘不一致，比了只会得到噪音。
 * 版本号改用下面的 `readPackedVersion()` 单独校验 —— 那才是"旧码进包"真正会露馅的地方。
 */
const FILES = [
  ["electron/src/config.js", "electron/src/config.js"],
  ["electron/src/llm/client.js", "electron/src/llm/client.js"],
  ["electron/src/netdisk/transfer-progress.js", "electron/src/netdisk/transfer-progress.js"],
  ["electron/src/tasks/generate.js", "electron/src/tasks/generate.js"],
  ["electron/renderer/index.html", "electron/renderer/index.html"],
  ["electron/renderer/renderer.js", "electron/renderer/renderer.js"],
];

const ASAR = path.join(__dirname, "..", "dist", "win-unpacked", "resources", "app.asar");

function main() {
  if (!fs.existsSync(ASAR)) {
    console.error("❌ 找不到 asar：", ASAR, "（先跑 npm run dist）");
    process.exit(1);
  }
  const asar = require("@electron/asar/lib/asar.js");
  const root = path.join(__dirname, "..");

  // 版本号单独校验：package.json 会被 builder 裁剪，但 version 一定保留
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packedVersion = JSON.parse(asar.extractFile(ASAR, "package.json").toString("utf8")).version;
  const versionOk = packedVersion === pkg.version;
  console.log(`${versionOk ? "✅" : "❌"} 包内版本号 ${packedVersion}（磁盘 ${pkg.version}）`);

  let bad = versionOk ? 0 : 1;
  for (const [repoRel, asarRel] of FILES) {
    const onDisk = fs.readFileSync(path.join(root, repoRel));
    let packed;
    try {
      // asar.extractFile 要的是反斜杠分隔的相对路径（Windows 打包器内部就是这么存的）
      packed = asar.extractFile(ASAR, asarRel.replace(/\//g, "\\"));
    } catch (error) {
      console.error(`❌ ${repoRel}：从 asar 取不出来 —— ${error.message}`);
      bad += 1;
      continue;
    }
    const same = Buffer.compare(onDisk, packed) === 0;
    console.log(`${same ? "✅" : "❌"} ${repoRel}（${onDisk.length} 字节 vs 包内 ${packed.length} 字节）`);
    if (!same) bad += 1;
  }
  console.log(bad === 0
    ? `\n✅ 版本号一致 + ${FILES.length} 个源文件字节全部一致`
    : `\n❌ ${bad} 项不一致`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
