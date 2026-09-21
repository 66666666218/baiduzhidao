"use strict";
// 从 Electron 本地缓存解压二进制到 node_modules/electron/dist（install.js 在弱网下解压易失败）
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const cacheDir = path.join(process.env.LOCALAPPDATA || "", "electron", "Cache");
const version = require("../node_modules/electron/package.json").version;

function findZip(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findZip(full);
      if (found) return found;
    } else if (entry.isFile() && entry.name === `electron-v${version}-win32-x64.zip`) {
      return full;
    }
  }
  return "";
}

const zipPath = findZip(cacheDir);
if (!zipPath) throw new Error(`缓存里没有找到 electron-v${version}-win32-x64.zip`);
const size = fs.statSync(zipPath).size;
console.log("zip:", zipPath, (size / 1048576).toFixed(1), "MB");
if (size < 10000000) throw new Error("zip 不完整（小于 10MB），请重新下载");

const distDir = path.join(__dirname, "..", "node_modules", "electron", "dist");
// 先解到临时目录、验过 electron.exe 再换目录。
// 原来先 rmSync(dist) 再解压：解压一失败（弱网/磁盘忙）就把唯一可用的安装也毁了，只能重装依赖。
const tmpDir = `${distDir}.解压中_${Date.now()}`;
const backupDir = `${distDir}.旧版_${Date.now()}`;
fs.mkdirSync(tmpDir, { recursive: true });
try {
  execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath.replace(/\\/g, "/")}' -DestinationPath '${tmpDir.replace(/\\/g, "/")}' -Force"`, { stdio: "inherit" });
  if (!fs.existsSync(path.join(tmpDir, "electron.exe"))) {
    throw new Error("解压结果里没有 electron.exe，判定为解压失败");
  }
  // 全新安装时 dist 根本不存在，renameSync 会抛 ENOENT——而下面的 catch 会把
  // 刚刚解压成功的 tmpDir 一起删掉，于是这个脚本只对"装过想重装"的人有效。
  const hasOld = fs.existsSync(distDir);
  if (hasOld) fs.renameSync(distDir, backupDir);
  try {
    fs.renameSync(tmpDir, distDir);
  } catch (error) {
    if (hasOld) fs.renameSync(backupDir, distDir); // 新包就位失败就把旧包放回去，至少还能用
    throw error;
  }
  if (hasOld) fs.rmSync(backupDir, { recursive: true, force: true });
} catch (error) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  throw error;
}
fs.writeFileSync(path.join(distDir, "..", "path.txt"), "electron.exe");
console.log("ELECTRON_BIN_OK");
