"use strict";

/**
 * 网盘资源转存确权管线（纯协议版 · 高速批量）：
 *   输入 txt（一行一个链接）或 xlsx → 纯 HTTP 协议逐条：
 *   verify → 分享页解析(mset) → 建目标目录 → fsidlist 转存 → 创建自有永久分享 → 按答题模板出问答行
 *
 * 依据：qingchuangjy/wangpan 参考实现 + 2026-09-23 实测（料理鼠王纯协议落盘成功）。
 * 无浏览器依赖：只需 BDUSS/STOKEN 凭证（从比特浏览器 Cookie 提取一次）。
 * 每条资源独立 Cookie 会话（Jar 隔离），无竞态，支持并发。
 *
 * 断点续跑（state.jsonl）/ 失败3次黑名单 / 连续失败熔断 / errno=4 已存在复用。
 *
 * 用法：
 *   node scripts/pan-transfer-batch.js --input=<链接.txt 或 资源.xlsx> [选项]
 *     --start=N        跳过前 N 行（默认 0）
 *     --limit=N        本次处理条数（默认 50；0=全部）
 *     --cc=N           并发数（默认 4）
 *     --dest=/目录     转存目标根目录（默认 /来自资源批量转存）
 *     --out-dir=目录   上传专用表输出目录
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { chromium } = require("playwright-core");
const { createShare } = require("../electron/src/netdisk/share");
const qaLib = require("./qa-template-lib");

const root = path.resolve(__dirname, "..");
const PAN = "https://pan.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- 参数 ----------
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/i);
  if (m) args[m[1]] = m[2];
  else args[a.replace(/^--/, "")] = true;
}
if (!args.input) { console.error("用法: node scripts/pan-transfer-batch.js --input=<txt|xlsx> [--limit=50] [--cc=4]"); process.exit(1); }
const inputFile = path.resolve(args.input);
const startIdx = Math.max(0, Number(args.start) || 0);
const limit = args.limit !== undefined ? Math.max(0, Number(args.limit)) : 50;
const CC = Math.max(1, Number(args.cc) || 4);
const paceMs = Math.max(300, Number(args["pace-ms"]) || 1200);
const destRoot = args.dest || "/来自资源批量转存";
const keepImg = !args["no-img"];

const baseName = path.basename(inputFile).replace(/\.(xlsx|txt)$/i, "").slice(0, 40);
const workDir = path.join(root, "运行缓存", "transfer-batch", baseName);
const stateFile = path.join(workDir, "state.jsonl");
const outDir = args["out-dir"] ? path.resolve(args["out-dir"]) : path.join(workDir, "上传专用表");

function loadState() {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(stateFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); map.set(r.srcLink, r); } catch { /* 跳过 */ }
    }
  } catch { /* 首次 */ }
  return map;
}
const saveState = (e) => { fs.mkdirSync(workDir, { recursive: true }); fs.appendFileSync(stateFile, JSON.stringify(e) + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
function parseLinkCell(text) {
  const s = String(text || "");
  const link = (s.match(/https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i) || [])[0] || "";
  let pwd = (s.match(/[?&]pwd=([a-z0-9]{4})/i) || [])[1] || "";
  if (!pwd) pwd = (s.match(/(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i) || [])[1] || "";
  return { link, pwd };
}
function randomPwd() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

// ---------- CookieJar 客户端（每条资源独立实例） ----------
class Jar {
  constructor(bduss, stoken) {
    this.map = new Map([["BDUSS", bduss]]);
    if (stoken) this.map.set("STOKEN", stoken);
  }
  apply(setCookies) {
    for (const sc of setCookies || []) {
      const pair = String(sc).split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  str() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
}

function makeClient(jar) {
  return async (pathAndQuery, opts = {}) => {
    const resp = await fetch(`${PAN}${pathAndQuery}`, {
      method: opts.method || "GET",
      headers: {
        "User-Agent": UA,
        "Cookie": jar.str(),
        "Referer": opts.referer || `${PAN}/disk/main`,
        ...(opts.headers || {}),
      },
      body: opts.body,
      redirect: "follow",
    });
    jar.apply(resp.headers.getSetCookie ? resp.headers.getSetCookie() : []);
    return resp.json().catch(() => ({}));
  };
}

// ---------- 单条完整链（纯协议） ----------
async function processOne(jar, { link, pwd, rawName, idx, destDir, bduss, stoken, makeShare }) {
  const m = link.match(/\/s\/(1[\w-]+)/);
  const fullCode = m[1];
  const surl = fullCode.startsWith("1") ? fullCode.slice(1) : fullCode;
  const rawUrl = `${PAN}/s/${fullCode}?pwd=${pwd}`;

  // 1) verify
  const vResp = await fetch(`${PAN}/share/verify?surl=${encodeURIComponent(surl)}&t=${Date.now()}&channel=chunlei&web=1&bdstoken=null&clienttype=0`, {
    method: "POST",
    headers: { "User-Agent": UA, "Cookie": jar.str(), "Referer": `${PAN}/share/init?surl=${encodeURIComponent(surl)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: `pwd=${pwd}&vcode=&vcode_str=`,
  });
  jar.apply(vResp.headers.getSetCookie ? vResp.headers.getSetCookie() : []);
  const vBody = await vResp.json().catch(() => ({}));
  if (vBody.errno === -65 || vBody.errno === -62 || vBody.errno === -70) throw Object.assign(new Error(`verify风控 errno=${vBody.errno}`), { risk: true });
  if (vBody.errno !== 0 || !vBody.randsk) throw new Error(`verify errno=${vBody.errno}`);

  // 2) 分享页 → mset
  const pResp = await fetch(`${PAN}/s/${fullCode}`, { headers: { "User-Agent": UA, "Cookie": jar.str() }, redirect: "follow" });
  jar.apply(pResp.headers.getSetCookie ? pResp.headers.getSetCookie() : []);
  const html = await pResp.text();
  const mm = html.match(/(?:yunData\.setData|locals\.mset)\(([\s\S]+?)\);/);
  if (!mm) throw new Error("分享页无数据（可能已失效）");
  const data = JSON.parse(mm[1]);
  if (Number(data.errno) !== 0) throw new Error(`分享数据 errno=${data.errno}`);
  const uk = String(data.share_uk || data.uk || "");
  const shareid = String(data.shareid || "");
  const bdstoken = String(data.bdstoken || "");
  const rawList = Array.isArray(data.file_list) ? data.file_list : (data.file_list && data.file_list.list) || [];

  // 3) 递归收集 fs_id（root 空时走 /share/list）
  let fsIds = [];
  let dirPaths = [];
  const collect = (entries) => {
    for (const f of entries) {
      if (Number(f.isdir) === 1) dirPaths.push(f.path);
      else if (f.fs_id) fsIds.push(Number(f.fs_id));
    }
  };
  collect(rawList);
  const listDir = async (dir) => {
    const qs = new URLSearchParams({ web: "5", app_id: "250528", desc: "1", showempty: "0", page: "1", num: "100", order: "time", view_mode: "1", channel: "chunlei", clienttype: "0", shorturl: surl, dir });
    if (bdstoken) qs.set("bdstoken", bdstoken);
    const j = await fetch(`${PAN}/share/list?${qs}`, { headers: { "User-Agent": UA, "Cookie": jar.str(), "Referer": rawUrl } }).then((r) => r.json()).catch(() => ({}));
    if (j.errno === 0 && Array.isArray(j.list)) collect(j.list);
  };
  for (const d of dirPaths.slice(0, 10)) await listDir(d);
  if (!fsIds.length) {
    const root = await fetch(`${PAN}/share/list?web=5&app_id=250528&desc=1&showempty=0&page=1&num=100&order=time&view_mode=1&channel=chunlei&clienttype=0${bdstoken ? "&bdstoken=" + bdstoken : ""}&shorturl=${encodeURIComponent(surl)}&root=1`, { headers: { "User-Agent": UA, "Cookie": jar.str(), "Referer": rawUrl } }).then((r) => r.json()).catch(() => ({}));
    if (root.errno === 0 && Array.isArray(root.list)) {
      dirPaths = [];
      collect(root.list);
      for (const d of (root.list.filter((f) => Number(f.isdir) === 1).map((f) => f.path)).slice(0, 10)) await listDir(d);
    }
  }
  if (!fsIds.length) throw new Error("分享里没有文件");

  // 4) 建目录 + 转存
  const cResp = await fetch(`${PAN}/api/create?a=commit&bdstoken=${encodeURIComponent(bdstoken)}&web=1&channel=chunlei&clienttype=0`, {
    method: "POST",
    headers: { "User-Agent": UA, "Cookie": jar.str(), "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: `path=${encodeURIComponent(destDir)}&isdir=1`,
  });
  await cResp.json().catch(() => ({}));
  const tResp = await fetch(`${PAN}/share/transfer?shareid=${shareid}&from=${uk}&bdstoken=${encodeURIComponent(bdstoken)}&channel=chunlei&clienttype=0&web=1`, {
    method: "POST",
    headers: { "User-Agent": UA, "Cookie": jar.str(), "Referer": rawUrl, "Origin": PAN, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: `fsidlist=${encodeURIComponent(JSON.stringify(fsIds))}&path=${encodeURIComponent(destDir)}`,
  });
  const tBody = await tResp.json().catch(() => ({}));
  const infoErr = tBody.info && tBody.info[0] && Number(tBody.info[0].errno);
  if (tBody.errno === 12 || tBody.errno === -10) throw Object.assign(new Error("网盘容量不足"), { fatal: true });
  if (Number(tBody.errno) !== 0 && !(infoErr === 0)) throw new Error(`转存 errno=${tBody.errno} ${tBody.show_msg || ""}`);

  // 5) 权威落盘路径
  const toPaths = ((tBody.extra && tBody.extra.list) || []).map((x) => x.to)
    .concat((tBody.duplicated && tBody.duplicated.list) || []).filter(Boolean);
  return { toPaths: toPaths.length ? toPaths : files.map(f => f.path), fsIds };
}

// ---------- 主流程 ----------
(async () => {
  // 0) 输入
  let rows;
  if (/\.txt$/i.test(inputFile)) {
    const lines = fs.readFileSync(inputFile, "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    rows = lines.map((line, i) => ({ __name: `链接${i + 1}`, __link: line }));
  } else {
    const wb = XLSX.readFile(inputFile);
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  }
  const keys = Object.keys(rows[0]);
  const nameKey = keys.find((k) => /文件名|名称|标题|资源/.test(k)) || keys.find((k) => !/链接|网址|url/i.test(k)) || keys[0];
  const linkKey = keys.find((k) => /链接|网址|url/i.test(k)) || keys.find((k) => /pan\.baidu\.com/.test(String(rows[0][k] || ""))) || keys[1];
  const pwdKey = keys.find((k) => /提取码|密码|访问码/.test(k)) || "";
  console.log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);

  // 1) 凭证（从比特浏览器提取一次，之后全程纯 HTTP）
  const cdp = fs.readFileSync(path.join(root, "运行缓存", "cdp.txt"), "utf8").trim();
  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const cookies = await browser.contexts()[0].cookies("https://pan.baidu.com");
  const bduss = (cookies.find((c) => c.name === "BDUSS") || {}).value || "";
  const stoken = (cookies.find((c) => c.name === "STOKEN") || {}).value || "";
  await browser.close();
  if (!bduss) { console.error("❌ 无网盘凭证（BDUSS）"); process.exit(1); }
  console.log(`凭证就绪 BDUSS(${bduss.length}字符) —— 全程纯协议，无浏览器`);

  // 2) 任务清单
  const state = loadState();
  const tasks = [];
  let junk = 0;
  for (let i = startIdx; i < rows.length; i += 1) {
    if (limit > 0 && tasks.length >= limit) break;
    const rawName = String(rows[i][nameKey] || "").trim();
    const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? ` 提取码:${rows[i][pwdKey]}` : ""));
    const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
    if (!link || !cellPwd) { junk += 1; continue; }
    const prev = state.get(srcLink);
    if (prev && prev.status === "done" && prev.ownLink) continue; // 断点：已确权
    if (prev && (prev.attempts || 0) >= 3) { junk += 1; continue; }
    tasks.push({ idx: i, rawName, srcLink, link, pwd: cellPwd, attempts: (prev && prev.attempts) || 0 });
  }
  console.log(`本轮任务 ${tasks.length} 条（脏/黑名单剔除 ${junk}）`);

  // 3) 并发池执行
  let done = 0, failed = 0, consecutiveFails = 0, fatalStop = false;
  const startedAt = Date.now();
  const quota = async () => {
    const jar = new Jar(bduss, stoken);
    const cli = makeClient(jar);
    const q = await cli(`/api/quota?checkfree=1&checkexpire=1&web=1`).catch(() => ({}));
    if (q.errno !== 0 || !q.total) return null;
    return { freeGB: (q.total - q.used) / 1024 ** 3, totalGB: q.total / 1024 ** 3 };
  };
  const quota0 = await quota();
  if (quota0) {
    console.log(`网盘空间：总 ${quota0.totalGB.toFixed(0)}GB | 剩余 ${quota0.freeGB.toFixed(1)}GB`);
    if (quota0.freeGB < 10) {
      console.log("⛔ 剩余空间不足 10GB，转存必然失败。扩容/清理后重跑。");
      process.exit(3);
    }
  }

  let cursor = 0;
  async function worker(workerId) {
    while (cursor < tasks.length && !fatalStop) {
      const t = tasks[cursor++];
      // 每条独立 Cookie 会话
      const jar = new Jar(bduss, stoken);
      const entryBase = { srcLink: t.srcLink, name: t.rawName };
      try {
        const idx = String(t.idx + 1).padStart(5, "0");
        const destDir = `${destRoot}/${baseName}/${idx}`;
        const { toPaths } = await processOne(jar, {
          link: t.link, pwd: t.pwd, rawName: t.rawName, idx: t.idx, destDir, bduss, stoken, makeShare: true,
        });
        // 自有永久分享（确权后）
        const ownPwd = randomPwd();
        const share = await createShare({ bduss, stoken, paths: toPaths, password: ownPwd });
        if (!share.link) throw new Error("创建分享失败");
        const ownLink = `${share.link}?pwd=${share.password}`;
        let displayName = t.rawName && t.rawName.length >= 4 && !/^链接\d+$/.test(t.rawName)
          ? t.rawName
          : decodeURIComponent((toPaths[0] || "").split("/").pop() || "资源");
        // 名称质量门槛：广告词/压缩包等命名不得进入问答（资源已转存，仅跳过生成问答）
        if (qaLib.reject(displayName, ownLink)) {
          displayName = decodeURIComponent((toPaths[0] || "").split("/").pop() || "").replace(/\[([^\]]*)\]/g, "$1").trim();
          if (qaLib.reject(displayName, ownLink)) {
            saveState({ srcLink: t.srcLink, name: t.rawName, status: "done", phase: "done", toPaths, ownLink, ownPwd: share.password, note: "名称不合规跳过问答", at: new Date().toISOString() });
            console.log(`  [W${workerId}][${now()}] ⚠️ ${t.rawName.slice(0, 26)} 已转存但名称不合规，跳过问答`);
            continue;
          }
        }
        const meta = qaLib.parseName(displayName);
        const qaRow = {
          qid: "",
          问题标题: qaLib.buildTitle(meta, t.idx),
          回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta), keepImg),
        };
        const okEntry = { srcLink: t.srcLink, name: displayName, status: "done", phase: "done", toPaths, ownLink, ownPwd: share.password, qaRow, at: new Date().toISOString() };
        state.set(t.srcLink, okEntry);
        saveState(okEntry);
        done += 1;
        consecutiveFails = 0;
        console.log(`  [W${workerId}][${now()}] ✅ ${displayName.slice(0, 26)} → ${ownLink}`);
      } catch (e) {
        failed += 1;
        consecutiveFails += 1;
        t.attempts = (t.attempts || 0) + 1;
        saveState({ ...entryBase, status: "failed", attempts: t.attempts, error: (e.message || "").slice(0, 120), at: new Date().toISOString() });
        console.log(`  [W${workerId}][${now()}] ✗ ${t.rawName.slice(0, 26)} → ${e.message.slice(0, 70)}`);
        if (e.fatal) { console.log("⛔ 容量不足，管线停止（已完成部分完好）。"); fatalStop = true; break; }
        if (e.risk) { console.log("  ⏸ verify 风控，全局暂停 10 分钟…"); await sleep(10 * 60 * 1000); }
        if (consecutiveFails >= 10) { console.log("⚠️ 连续 10 条失败，自动停止（可稍后重跑续传）。"); break; }
      }
      await sleep(paceMs + Math.random() * paceMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CC, tasks.length) }, (_, w) => worker(w + 1)));

  // 4) 导出上传专用表
  const allDone = [...state.values()].filter((s) => s.status === "done" && s.qaRow).map((s) => s.qaRow);
  fs.mkdirSync(outDir, { recursive: true });
  if (allDone.length) {
    const chunkRows = 5000;
    for (let c = 0; c < Math.ceil(allDone.length / chunkRows); c += 1) {
      const part = allDone.slice(c * chunkRows, (c + 1) * chunkRows);
      const ws = XLSX.utils.json_to_sheet(part, { header: ["qid", "问题标题", "回答内容"] });
      const wbOut = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
      XLSX.writeFile(wbOut, path.join(outDir, `上传专用表-第${c + 1}批-${part.length}条.xlsx`));
    }
  }
  const mins = Math.round((Date.now() - startedAt) / 60000);
  console.log("\n=== 批量转存完成 ===");
  console.log(`本轮成功 ${done} | 失败 ${failed} | 历史累计 ${allDone.length} | 用时 ${mins} 分钟`);
  if (allDone.length) console.log(`上传专用表: ${outDir}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 180)); process.exit(1); });
