"use strict";

/**
 * 第 17 轮：**依赖装残了**这件事必须在源码树里就能查出来。
 *
 * ── 血泪（2026-10-14）──
 * `node_modules/undici/package.json` 不知何时丢了（目录还在、LICENSE/lib/index.js 都在，就是没
 * 有 package.json）。表现非常有欺骗性：
 *   · `require("undici")` 照样成功（Node 找不到 package.json 会退到 index.js）；
 *   · 全部单测全绿、`node --check` 全绿、真机在 Electron 的 Node 20 下 new ProxyAgent 也正常；
 *   · **但 electron-builder 是靠依赖自己的 package.json 收集依赖的** —— 没有它就把整包丢掉。
 * 于是从 2.0.43 起，安装包里**根本没有 undici**，而 `proxy.js` 的设计是"取不到就退化直连 +
 * 大声告警" → 用户配的「每账号独立代理出口」在打包版里一直没生效，
 * 而这在源码树里跑测试**完全看不出来**。
 *
 * 单测能做的：守住"源码树里的依赖是完整的、能 require、对得上声明"。
 * 守住"产物里真的有"只能靠 `scripts/verify-package.js`（它验的是真产物，需要先打包）——
 * 所以那个脚本也被本文件钉住必须留在发版脚本里，别被人"顺手删掉一个没人用的脚本"。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const deps = Object.keys(pkg.dependencies || {});

test("A1 每个生产依赖都必须有可读的 package.json（缺了 = 打包时会静默丢掉整包）", () => {
  const broken = [];
  for (const name of deps) {
    const manifest = path.join(ROOT, "node_modules", name, "package.json");
    if (!fs.existsSync(manifest)) { broken.push(`${name}（缺 package.json）`); continue; }
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (!parsed.version) broken.push(`${name}（package.json 里没有 version）`);
    } catch (error) {
      broken.push(`${name}（package.json 解析失败：${error.message}）`);
    }
  }
  assert.deepEqual(broken, [],
    `这些依赖装残了：${broken.join("、")} —— electron-builder 会因此把它们整包排除出安装包`);
});

test("A2 undici 必须装成 6.x（Electron 33 内置 Node 20 加载 7+ 会直接抛 markAsUncloneable）", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "undici", "package.json"), "utf8"));
  const major = Number(String(manifest.version).split(".")[0]);
  assert.ok(major > 0 && major <= 6,
    `装的是 undici@${manifest.version}：Electron 33 的 node:worker_threads 没有 markAsUncloneable，` +
    "require 的瞬间就会抛 —— 转存阶段会当场炸");
  // 声明也必须在 6.x 以内，否则下一次 npm install 就会把它升上去
  assert.match(pkg.dependencies.undici, /\^?~?6\./,
    `package.json 里 undici 声明成了 ${pkg.dependencies.undici}，重新安装时会被升到 7+`);
});

test("A3 undici 真的能用（「能 require」不算数：ProxyAgent 必须拿得到）", () => {
  const undici = require("undici");
  assert.equal(typeof undici.ProxyAgent, "function",
    "没有 ProxyAgent 就没法给每个账号配独立出口 IP —— 网盘转存同 IP 并发正是被降级的根因");
});

test("A4 产物自检脚本必须存在，且留在发版流程里（它验的是真产物，单测验不了）", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "verify-package.js")),
    "scripts/verify-package.js 被删了 —— 那么「打包时依赖被静默丢掉」这件事又没人管了");
  assert.match(pkg.scripts["verify:package"] || "", /verify-package/,
    "package.json 里没有 verify:package 脚本，发版时不会有人想起跑它");
});

test("A5 产物自检脚本不许把 app-update.yml 的内容打出来（那里面是更新源坐标）", () => {
  const src = read("scripts/verify-package.js");
  assert.ok(!/readFileSync\s*\(\s*[^)]*app-update\.yml/.test(src),
    "读并打印 app-update.yml 会把仓库地址泄进日志 —— 既定要求是地址不外泄，只报「在不在」");
  assert.match(src, /existsSync/, "应当只用 existsSync 判断在不在");
});

test("A6 files 必须覆盖 electron/**，否则新加的源码不会被打进去", () => {
  assert.ok(Array.isArray(pkg.build.files) && pkg.build.files.includes("electron/**/*"),
    `build.files = ${JSON.stringify(pkg.build.files)}：漏了 electron/**/* 的话，新增模块打进不安装包` +
    "（而且不会报错，只会运行到那一步时 MODULE_NOT_FOUND）");
});
