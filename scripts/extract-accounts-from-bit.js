"use strict";

/**
 * 从比特浏览器环境批量提取账号登录态，写进「账号凭证」（网盘账号.json）。
 *
 * 软件里每个账号要单独点一次「从比特窗口提取」；这条脚本一次把全部环境都提了，
 * 适合开局——尤其是要拿真机验证整条链路的时候。
 *
 * 用法：
 *   node scripts/extract-accounts-from-bit.js                 # 提取全部比特环境
 *   node scripts/extract-accounts-from-bit.js 测试组1 测试组2   # 只提指定的
 *   ZHIDAO_DATA_DIR=xxx node scripts/...                      # 指定数据目录（默认用仓库里的 运行缓存）
 *
 * 提取逻辑与 `app-context.js` 的 netdisk:accounts:extract-from-window **完全一致**：
 * 先读网盘域、没有就退回知道域（BDUSS 是百度全域 Cookie，哪个域有都能用）。
 *
 * ⚠️ 这个脚本**不会打印 Cookie 值**，只打印长度与校验结果 —— 终端输出经常被贴到别处，
 * 两个号的登录态不该留在那种地方。
 */

const path = require("path");
const { resolveDataDir } = require("../electron/src/data-dir");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const dataDir = resolveDataDir(root);

const { createAdapter } = require("../electron/src/browser");
const { BitBrowserAdapter, extractBrowserList } = require("../electron/src/browser/bitbrowser");
const manager = require("../electron/src/netdisk/manager");
const http = require("../electron/src/zhidao/http");

/** 与 app-context 同一套：先网盘域，再退回知道域 */
async function cookiesOf(context) {
  let cs = await context.cookies("https://pan.baidu.com");
  let bd = (cs.find((c) => c.name === "BDUSS") || {}).value || "";
  if (!bd) {
    cs = await context.cookies("https://zhidao.baidu.com");
    bd = (cs.find((c) => c.name === "BDUSS") || {}).value || "";
  }
  return { bduss: bd, stoken: (cs.find((c) => c.name === "STOKEN") || {}).value || "" };
}

async function main() {
  const wanted = process.argv.slice(2).map((x) => x.trim()).filter(Boolean);
  const adapter = new BitBrowserAdapter();

  const conn = await adapter.checkConnection().catch((e) => ({ ok: false, error: e.message }));
  if (!conn.ok) throw new Error(`连不上比特浏览器本地 API（${conn.error || conn.status}）：请先启动比特并打开「本地设置 → API」`);
  console.log(`比特连接正常 · ${conn.status}\n数据目录：${dataDir}\n`);

  const list = extractBrowserList(await adapter.post("/browser/list", { page: 0, pageSize: 100 }));
  const envs = list
    .map((b) => ({ id: b.id || b.browserId, name: String(b.name || "").trim() }))
    .filter((b) => b.name && (!wanted.length || wanted.includes(b.name)));
  if (!envs.length) throw new Error(wanted.length ? `比特里没有这些环境：${wanted.join("、")}` : "比特里一个环境都没有");

  const existing = manager.loadAccounts(dataDir).filter((a) => !envs.some((e) => e.name === a.name));
  const saved = [];

  for (const env of envs) {
    console.log(`── ${env.name} ──`);
    let browser = null;
    let cred = null;
    try {
      const opened = await adapter.open(env.name);
      browser = await chromium.connectOverCDP(opened.cdpUrl);
      const context = browser.contexts()[0] || (await browser.newContext());
      cred = await cookiesOf(context);
    } finally {
      await browser?.close?.().catch(() => {});          // 只断开 CDP，不动窗口
      await adapter.close(env.id || env.name).catch(() => {});   // 提完就关，别留下一堆窗口
    }

    if (!cred.bduss) { console.log("   ❌ 这个环境没有百度登录态（网盘和知道都没登录），跳过\n"); continue; }
    console.log(`   Cookie 已取到：BDUSS ${cred.bduss.length} 字符，STOKEN ${cred.stoken.length} 字符`);

    const cookie = `BDUSS=${cred.bduss}${cred.stoken ? "; STOKEN=" + cred.stoken : ""}`;
    const z = await http.fetchLoginInfo(cookie, {});
    console.log(`   百度知道：${z.ok ? `✅ 已登录（${z.userName || "?"}）` : `❌ ${z.reason}`}`);
    let panOk = false;
    try {
      // 注意：`manager.quota()` 返回的是**加工过**的形状 `{valid, name, totalGB, freeGB}`，
      // 不是原始响应 —— 第一版这里按 `errno` 判，于是网盘明明好的也被判成不可用。
      const q = await manager.quota({ name: env.name, bduss: cred.bduss, stoken: cred.stoken });
      panOk = q.valid === true;
      console.log(`   百度网盘：${panOk
        ? `✅ 已连接（总量 ${q.totalGB}GB，剩余 ${q.freeGB}GB${q.freeGB < 5 ? " ⚠️ 快满了，转存会很快触发容量不足" : ""}）`
        : "❌ 未连接（转存会跳过这个号，答题链不受影响）"}`);
    } catch (e) {
      console.log(`   百度网盘：❌ ${e.message}`);
    }
    if (!z.ok && !panOk) { console.log("   ❌ 两个域都不可用，不保存这个账号\n"); continue; }

    saved.push({ name: env.name, bduss: cred.bduss, stoken: cred.stoken, userName: z.userName || "", panOk, at: new Date().toISOString() });
    console.log("   → 待保存\n");
  }

  if (!saved.length) { console.log("没有任何账号可保存。"); return; }
  // 合并而不是覆盖：别的账号（比如只登录了知道、没登网盘的）不该被这次提取清掉
  const merged = existing.concat(saved.map(({ panOk, at, ...keep }) => keep));
  manager.saveAccounts(dataDir, merged);
  console.log(`已写入 ${path.join(dataDir, "网盘账号.json")}：本次 ${saved.length} 个，目录内合计 ${merged.length} 个。`);
  console.log("账号名：" + saved.map((s) => s.name + (s.panOk ? "（网盘可用）" : "（仅知道可用）")).join("、"));
}

main().catch((error) => { console.error("提取失败：" + error.message); process.exitCode = 1; });
