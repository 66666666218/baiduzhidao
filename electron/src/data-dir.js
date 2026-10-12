"use strict";

/**
 * 「运行数据目录在哪」+「怎么读比特浏览器 CDP 端口」—— **这两件事各只有一个家**。
 *
 * 为什么必须收敛：
 *  ① **目录**：本仓库 25 个脚本里只有 3 个（`extract-accounts-from-bit` / `live-crawl-all` /
 *     `run-pipeline`）认 `ZHIDAO_DATA_DIR`，其余全部硬编码 `path.join(root, "运行缓存")`。
 *     而 `运行缓存/` 被 `.gitignore` 忽略 —— **新电脑 clone 下来根本没有这个目录**。
 *     于是同一个环境变量在别处有效、在这里无效，测试员没法把脚本指到一个干净目录，
 *     跟 `electron/app-context.js` 里那个「模拟换了一台新电脑」的机制也对不上。
 *  ② **cdp.txt**：5 处直接 `fs.readFileSync(运行缓存/cdp.txt)`，只有
 *     `pan-transfer-pipeline.js` 做了存在性检查。新电脑上没开比特浏览器时，
 *     用户看到的是裸的 `ENOENT: no such file or directory, open 'D:\...\cdp.txt'` ——
 *     既不知道要开比特浏览器，也不知道这个目录本来就是 git 忽略、从没被创建过。
 *
 * 与 `electron/app-context.js` 的关系：那份是**应用内**的取法（打包版走
 * `%APPDATA%\zhidao-answer-studio`，因为安装目录不可写、且 asar 内的 __dirname 不可写）。
 * 脚本拿不到 `app.getPath`，所以这里只做两档：`ZHIDAO_DATA_DIR` → 否则 `<root>/运行缓存`。
 * **要用脚本去读打包版的数据，请显式设 `ZHIDAO_DATA_DIR=%APPDATA%\zhidao-answer-studio`。**
 */

const fs = require("fs");
const path = require("path");

/**
 * 默认运行数据目录的**名字**（相对于仓库根）。
 * 单独导出，是为了让「需要知道这个名字」的地方（比如新电脑模拟器要断言副本里没有它）
 * 引用这里，而不是各自再写一遍字面量 —— 否则改个目录名就要满仓 grep。
 */
const DATA_DIR_NAME = "运行缓存";

/** 运行数据目录：环境变量优先，否则 `<root>/运行缓存` */
function resolveDataDir(root) {
  const fromEnv = process.env.ZHIDAO_DATA_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  return path.join(root, DATA_DIR_NAME);
}

/** 比特浏览器 CDP 端口文件（`运行缓存/cdp.txt`）。它由软件里的「连接比特浏览器」写入，**不存在于 git**。 */
function cdpFilePath(dataDir) {
  return path.join(dataDir, "cdp.txt");
}

/**
 * 读 CDP 端口。找不到 / 内容为空时抛**能照着做**的错误，而不是裸 ENOENT。
 *
 * 实测过的两种坑，都在错误信息里点名了：
 *   · 新电脑 clone 下来没有 `运行缓存/`（.gitignore 忽略）→ 目录都不存在；
 *   · 目录在、但 `cdp.txt` 是空的（软件刚启动还没写、或点了「断开」）。
 */
function readCdp(dataDir, file) {
  const f = file || cdpFilePath(dataDir);
  if (!fs.existsSync(f)) {
    throw new Error(
      `找不到比特浏览器 CDP 端口文件：${f}\n`
      + "  · 这个文件由软件里的「连接比特浏览器」写入，**不在 git 里**；新电脑 clone 下来连\n"
      + `    「${path.basename(dataDir || "")}」目录都不会有（已被 .gitignore 忽略）。\n`
      + "  · 处理：① 打开比特浏览器（要开着，不能只启动进程）→ ② 在软件界面点「连接比特浏览器」\n"
      + "    → ③ 确认上面的路径出现了这个文件，再重跑本脚本。\n"
      + "  · 如果数据目录不在默认位置，请设环境变量 ZHIDAO_DATA_DIR 指过去。");
  }
  const value = String(fs.readFileSync(f, "utf8") || "").trim();
  if (!value) {
    throw new Error(
      `比特浏览器 CDP 端口文件是空的：${f}\n`
      + "  · 说明软件连上了但没拿到端口，或断开后残留了一个空文件。\n"
      + "  · 处理：在软件界面重新点一次「连接比特浏览器」，让端口重新写进去。");
  }
  return value;
}

module.exports = { resolveDataDir, cdpFilePath, readCdp, DATA_DIR_NAME };
