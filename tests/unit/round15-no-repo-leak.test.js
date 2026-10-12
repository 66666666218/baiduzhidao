"use strict";

/**
 * 第 15 轮：**仓库地址不得出现在日志/界面里**。
 *
 * 起因：用户明确要求「GitHub 的地址不要暴露」。查下来的实际泄漏点不止一处，而且
 * 正是"改一处、别处还留着"的典型形态：
 *   ① `app-context.js` 里定义了 `RELEASES_URL`，更新失败时直接打进日志；
 *   ② 同一个文件在"启动静默检查失败"分支里还写了 `原始错误：${raw}` ——
 *      electron-updater 的报错原文**自带完整发布页 URL**，等于又印了一遍；
 *   ③ `update:info` 把 `releasesUrl` 返回给渲染端，界面上还有个「打开发布页」按钮。
 * 只改 ① 是没用的（② 照样漏），只删 ③ 的字段不删按钮会直接崩
 * （`$("openReleases")` 取到 null，`.addEventListener` 抛 TypeError）。
 *
 * 所以这一轮做两件事：
 *   · `errors.scrubUrl()` —— 凡是更新相关、要进日志的文本先过一遍；
 *   · 界面入口（按钮 + 监听器 + IPC 字段）整体移除。
 * 本文件把这两件事钉住，并且用**机械守卫**防止以后有人再把地址写回来。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
// 只看**可执行代码**：注释里会举例"以前这里写着 https://..."，先剥掉，免得守卫咬自己的手
// （HTML 注释也要剥：index.html 里那段说明性注释会提到被删掉的字段名。）
const stripComments = (src) =>
  src.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const { scrubUrl, describeUpdateError } = require("../../electron/src/errors");

// ─────────── A. scrubUrl 行为 ───────────

test("A1：带协议的完整 URL 被抹掉", () => {
  const out = scrubUrl("Unable to find latest version on GitHub (https://github.com/66666666218/baiduzhidao/releases/latest)");
  assert.ok(!/github\.com/i.test(out), out);
  assert.ok(!/66666666218/.test(out), out);
  assert.ok(!/https?:\/\//i.test(out), out);
  assert.match(out, /Unable to find latest version/, "人话部分要留下，不能整句吞掉");
});

test("A2：不带协议前缀的 github.com/... 也被抹掉", () => {
  const out = scrubUrl("请访问 github.com/66666666218/baiduzhidao/releases/latest 手动下载");
  assert.ok(!/github\.com/i.test(out), out);
  assert.ok(!/baiduzhidao\/releases/.test(out), out);
});

test("A3：裸的仓库坐标（不带域名）也被抹掉", () => {
  const out = scrubUrl("owner=66666666218 repo=baiduzhidao");
  assert.ok(!/66666666218/.test(out), out);
});

test("A4：正常文本不受影响（不能把人话也抹了）", () => {
  assert.equal(scrubUrl("线上可能还没有发布任何版本"), "线上可能还没有发布任何版本");
  assert.equal(scrubUrl("HttpError: 404 Not Found"), "HttpError: 404 Not Found");
  assert.equal(scrubUrl(""), "");
  assert.equal(scrubUrl(null), "");
  assert.equal(scrubUrl(undefined), "");
});

test("A5：多个链接只留一个占位，不留一长串", () => {
  const out = scrubUrl("a https://x.com/1 b https://y.com/2 c");
  assert.equal((out.match(/（链接已省略）/g) || []).length, 2, out);
});

test("A6：describeUpdateError 不再把人引到具体站点", () => {
  const net = describeUpdateError("connect ETIMEDOUT 20.205.243.166:443");
  assert.match(net, /网络/);
  assert.ok(!/github/i.test(net), net);
  assert.match(describeUpdateError("HttpError: 404"), /还没有发布/);
});

// ─────────── B. 机械守卫：源码里不许再出现仓库地址 ───────────

const SCAN = [
  "electron/app-context.js",
  "electron/renderer/renderer.js",
  "electron/renderer/index.html",
  "electron/src/errors.js",
  "electron/main.js",
];

test("B1：界面与日志相关代码里不再出现 github.com / 仓库坐标", () => {
  for (const f of SCAN) {
    const code = stripComments(read(f));
    assert.ok(!/github\.com/i.test(code), `${f} 仍出现 github.com`);
    const hits = code.match(/66666666218/g) || [];
    if (f === "electron/src/errors.js") {
      // 唯一允许保留的一处：scrubUrl 用来**抹掉**它的匹配式。
      // 别把它挪到别的文件、也别抄成第二份 —— 抄多了就分不清哪份是真在抹、哪份又漏出去了。
      assert.equal(hits.length, 1, "errors.js 里仓库坐标只允许出现一次");
      assert.ok(/\.replace\(\s*\/\\b66666666218\\b\/g/.test(code), "这一处必须是 scrubUrl 的抹除匹配式");
      continue;
    }
    assert.equal(hits.length, 0, `${f} 仍出现仓库坐标`);
  }
});

test("B2：RELEASES_URL 常量与 releasesUrl 字段都已删干净（常量留着迟早又被打进日志）", () => {
  for (const f of SCAN) {
    const code = stripComments(read(f));
    assert.ok(!/RELEASES_URL/.test(code), `${f} 仍定义/使用 RELEASES_URL`);
    assert.ok(!/releasesUrl/.test(code), `${f} 仍使用 releasesUrl`);
  }
});

test("B3：按钮与监听器必须同时消失（只删一个会崩）", () => {
  const html = read("electron/renderer/index.html");
  const js = read("electron/renderer/renderer.js");
  assert.ok(!/id="openReleases"/.test(html), "index.html 里还在渲染「打开发布页」按钮");
  assert.ok(!/\$\("openReleases"\)/.test(stripComments(js)), "renderer.js 还在给已删除的按钮挂监听器");
});

test("B4：更新失败的日志分支确实过了 scrubUrl，而不是直接打原始串", () => {
  const code = stripComments(read("electron/app-context.js"));
  assert.ok(/scrubUrl\s*\(/.test(code), "app-context.js 没有调用 scrubUrl");
  assert.ok(!/原始错误：\$\{raw\}/.test(code), "「原始错误：${raw}」还在 —— 它会把带地址的原文整条印出来");
});

test("B5：errors.js 导出了 scrubUrl 且语法正确", () => {
  assert.equal(typeof scrubUrl, "function");
  assert.doesNotThrow(() => new vm.Script(read("electron/src/errors.js"), { filename: "errors.js" }));
});

test("B6：改过的三个文件语法正确（vm.Script，不起子进程）", () => {
  for (const f of ["electron/app-context.js", "electron/renderer/renderer.js", "electron/src/errors.js"]) {
    assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), `${f} 语法错误`);
  }
});
