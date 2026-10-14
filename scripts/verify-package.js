"use strict";

/**
 * 打包产物自检：确认 `dist/win-unpacked/resources/app.asar` 里**真的**有该有的东西。
 *
 * ── 为什么必须单独有这个脚本（2026-10-14 血泪）──
 * 本轮排查"一键全自动点了没反应"时顺手发现了一颗更大的雷：
 * **`node_modules/undici` 的 package.json 不知何时丢了**（目录还在，LICENSE/lib/index.js 都在，
 * 就是没有 package.json）。`require("undici")` 照样能跑（Node 会退到 index.js），
 * 单测、真机全绿 —— 但 **electron-builder 是靠每个依赖自己的 package.json 来收集依赖的**，
 * 没有它就把整个包丢掉。结果：**从 2.0.43 起的安装包里都没有 undici**，
 * 而 `proxy.js` 的设计是"取不到 undici 就退化直连 + 大声告警" ——
 * 也就是说，用户配的「每账号独立代理出口」在打包版里**一直没生效**，
 * 而这一切在源码树里跑测试时**完全看不出来**（这正是本项目最高频的故障形态：静默失效）。
 *
 * 结论：**打包完必须验产物**，不能只看"源码里 require 得动"。
 * 单测（tests/unit/round17-packaging-deps.test.js）只能守住"源码树里依赖是完整的"，
 * 守住"产物里真的有"只能靠这个脚本 —— 所以它被写进发版流程（npm run verify:package）。
 *
 * 用法：node scripts/verify-package.js [asar 路径]
 *   - 不给路径就默认 dist/win-unpacked/resources/app.asar
 * 退出码：0 = 全过；1 = 有硬伤（缺失/版本不符）
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_ASAR = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");

/**
 * asar 内部路径用**反斜杠**（Windows 打包），而且 listPackage 会带前导分隔符
 * （形如 `\node_modules\undici\package.json`）。这里统一成 `node_modules\pkg\package.json`。
 * ⚠️ 只剥前导的 `/` 是不够的 —— 那样会剩下一个 `\`，于是"依赖全都在、脚本却说全都缺"
 *（第一次跑这个脚本就是这么误报的）。
 */
function normAsarPath(p) {
  return String(p).replace(/^[\\/]+/, "").replace(/[\\/]+/g, "\\");
}

function asarPath(...parts) {
  return parts.join("\\");
}

function main() {
  const asarFile = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ASAR;
  if (!fs.existsSync(asarFile)) {
    console.error(`❌ 找不到产物：${asarFile}\n   先跑 npm run dist。`);
    process.exit(1);
  }

  // asar 模块来自 electron-builder 的依赖树；缺了它说明 node_modules 本身就不完整
  let asar;
  try {
    asar = require(path.join(ROOT, "node_modules/@electron/asar/lib/asar.js"));
  } catch (error) {
    console.error(`❌ 读不了 asar（@electron/asar 没装上）：${error.message}`);
    process.exit(1);
  }

  const problems = [];
  const notes = [];

  // ---------- 1) 版本号 ----------
  const srcPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  let packedPkg = null;
  try {
    packedPkg = JSON.parse(asar.extractFile(asarFile, "package.json").toString("utf8"));
  } catch (error) {
    problems.push(`产物里没有 package.json（${error.message}）`);
  }
  if (packedPkg) {
    if (packedPkg.version !== srcPkg.version) {
      problems.push(`版本号不一致：源码 ${srcPkg.version} / 产物 ${packedPkg.version}`
        + "（electron-updater 按版本号判断要不要更新，版本号不对的包会让客户端永远显示「已是最新」）");
    } else {
      notes.push(`版本 ${packedPkg.version}`);
    }
  }

  // ---------- 2) 生产依赖必须一个不少 ----------
  // 这是本脚本存在的主要理由：依赖装残了（少 package.json）源码树看不出来，产物会直接缺整包。
  const deps = Object.keys(srcPkg.dependencies || {});
  const entries = new Set(asar.listPackage(asarFile).map(normAsarPath));
  const missing = [];
  for (const name of deps) {
    const rel = asarPath("node_modules", name, "package.json");
    if (!entries.has(rel)) {
      missing.push(name);
      continue;
    }
    try {
      const packed = JSON.parse(asar.extractFile(asarFile, rel).toString("utf8"));
      notes.push(`依赖 ${name}@${packed.version}`);
    } catch {
      missing.push(`${name}（package.json 读不出来）`);
    }
  }
  if (missing.length) {
    problems.push(`产物缺少生产依赖：${missing.join("、")}\n`
      + "   → 源码树里这些包可能装残了（少了 package.json）。先修 node_modules，再重新打包。");
  }

  // ---------- 3) 两条硬约束（踩过坑的，写死在产物级） ----------
  const undiciEntry = asarPath("node_modules", "undici", "package.json");
  if (entries.has(undiciEntry)) {
    const v = JSON.parse(asar.extractFile(asarFile, undiciEntry).toString("utf8")).version;
    const major = Number(String(v).split(".")[0]);
    // Electron 33 内置 Node 20.18.3，它的 node:worker_threads 没有 markAsUncloneable（Node 22 才有），
    // 而 undici ≥7 加载时就要用它 —— 只要 require 就抛，转存阶段会当场炸。
    if (!(major <= 6)) {
      problems.push(`undici 是 ${v}：Electron 33 的 Node 20 加载它就会抛 markAsUncloneable is not a function，必须是 6.x`);
    }
  }

  // ---------- 4) 在线更新链路要用的文件 ----------
  // ⚠️ 只报"在不在"，**绝不打印内容**：app-update.yml 里就是更新源坐标（仓库地址不外泄是既定要求）。
  const resDir = path.dirname(asarFile);
  if (!fs.existsSync(path.join(resDir, "app-update.yml"))) {
    notes.push("提示：没有 app-update.yml —— 这个包不会自动更新（本地调试包属正常）");
  }

  // ---------- 5) 本轮新增/关键源码文件确实被打进去了 ----------
  // files 配的是 electron/**/*，理论上不会漏；但"理论上"这三个字在这个项目上翻过车。
  const requiredSources = [
    "electron/app-context.js",
    "electron/src/workflows/auto-pipeline.js",
    "electron/src/workflows/pipeline-guard.js",
    "electron/src/tasks/manager.js",
    "electron/src/netdisk/proxy.js",
    "electron/renderer/renderer.js",
  ];
  const missingSrc = requiredSources.filter((rel) => !entries.has(normAsarPath(rel)));
  if (missingSrc.length) problems.push(`产物缺少源码文件：${missingSrc.join("、")}`);

  // ---------- 输出 ----------
  console.log(`产物：${path.relative(ROOT, asarFile)}`);
  for (const n of notes) console.log(`  ✓ ${n}`);
  if (problems.length) {
    console.error("");
    for (const p of problems) console.error(`❌ ${p}`);
    console.error(`\n共 ${problems.length} 项硬伤。`);
    process.exit(1);
  }
  console.log(`\n✅ 产物自检通过（${deps.length} 个生产依赖全部就位）。`);
}

main();
