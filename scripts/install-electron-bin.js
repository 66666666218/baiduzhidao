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
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath.replace(/\\/g, "/")}' -DestinationPath '${distDir.replace(/\\/g, "/")}' -Force"`, { stdio: "inherit" });
fs.writeFileSync(path.join(distDir, "..", "path.txt"), "electron.exe");
console.log("ELECTRON_BIN_OK");
