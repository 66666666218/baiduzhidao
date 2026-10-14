"use strict";

/**
 * 批量转存「为什么每条要 9 秒」的测速探针。
 *
 * 为什么要有这个脚本（2026-10-14）：
 * 用户看到 `✅ [1/11164]` 一行一条，问「为什么这么慢，一秒不是能转几十个吗」。
 * 而当时我手上唯一的数字是"9.18 秒/条"—— **这个数字是总量，不是分解**。
 * 没有任何地方量过那 9.18 秒花在哪一步（分享页解析？建目录？转存？建分享？还是代码里
 * 刻意留的那 1~2 秒间隔），所以任何"优化"都只能是猜。本项目踩过太多次"凭直觉改"的坑
 * （见 CHANGELOG 里那些实测对照），所以先把每一步的耗时打出来再说。
 *
 * 用法（**不会写用户台账**，只在自己账号的网盘里放几个文件）：
 *   node scripts/probe-transfer-speed.js --env 账号10081452 --n 5
 *   node scripts/probe-transfer-speed.js --env 账号10081452 --n 2 --share   # 连"建分享"一起量
 *   node scripts/probe-transfer-speed.js --env 测试组1 --n 10 --dry          # 只量解析段，**对网盘零副作用**
 *
 * ⚠️ 别在批量转存**正在跑**的时候用同一批账号跑本脚本的非 --dry 模式：两边抢同一个出口 IP 的
 *    并发额度，会污染两份测量结果，也可能把限流窗口打出来。挑一个没在工作、已存 Cookie 的账号。
 *    （`--dry` 模式只发 GET/verify、不写任何东西，对正在跑的任务影响极小，可用来量在跑的号。）
 */

const fs = require("fs");
const path = require("path");

const { Jar, processOne, makeClient, PAN } = require("../electron/src/netdisk/protocol");
const { createShare } = require("../electron/src/netdisk/share");
const { credentialOf } = require("../electron/src/netdisk/manager");
const { parseLinkCell } = require("../electron/src/netdisk/pan-link");
const { detectColumns } = require("../electron/src/netdisk/table-columns");
const { loadLedger } = require("../electron/src/netdisk/state-ledger");
const excel = require("../electron/src/storage/excel");

// ─────────────────────────── 参数 ───────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
if (has("help") || argv.length === 0) {
  console.log("用法: node scripts/probe-transfer-speed.js --env <账号名> [--n 5] [--share] [--pause 2000] [--table <xlsx>]");
  console.log("      --dry            只量解析段（对网盘零副作用）");
  console.log("      --compare        同一条链接上『快路径 vs 完整枚举』对照：耗时差 + 文件有没有漏");
  console.log("      --slow           配合 --dry 用，强制走慢路径（完整枚举）");
  process.exit(0);
}

const dataDir = process.env.ZHIDAO_DATA_DIR || path.join(process.env.APPDATA || ".", "zhidao-answer-studio");
const envLabel = arg("env");
const wantN = Math.max(1, Number(arg("n", "5")) || 5);
const pauseMs = Math.max(0, Number(arg("pause", "2000")) || 0);
const withShare = has("share");
// 只量解析段（verify + 分享页 + 列目录），不写网盘。
// `--slow` 把 dryRun 变成字符串 "slow"：protocol 认得这个值 = 强制走完整枚举（对照用）。
const dryRun = (has("dry") || has("compare")) ? (has("slow") ? "slow" : true) : false;
const compare = has("compare");
if (!envLabel) { console.error("必须用 --env 指定一个已存 Cookie 的账号名（别用正在跑批的号）"); process.exit(2); }

// ─────────────────────── 请求计时（包 fetch） ───────────────────────
const calls = [];
const rawFetch = globalThis.fetch;
globalThis.fetch = async function timedFetch(url, init) {
  const started = Date.now();
  let status = 0, err = "";
  try {
    const resp = await rawFetch(url, init);
    status = resp.status;
    return resp;
  } catch (e) {
    err = e.message || String(e);
    throw e;
  } finally {
    const full = String(url);
    // 只留路径，**绝不打印 query/cookie**（里面有凭证与提取码）
    const short = full.startsWith(PAN) ? full.slice(PAN.length).split("?")[0] : full.split("?")[0];
    calls.push({ step: short, ms: Date.now() - started, status, err, method: (init && init.method) || "GET" });
  }
};

const stepOf = (short) => {
  if (short.includes("/share/verify")) return "① 解析分享页 verify";
  if (short.includes("/share/list")) return "② 取分享内文件列表 share/list";
  if (short.includes("/api/create")) return "③ 建目录 api/create";
  if (short.includes("/share/transfer")) return "④ 转存 share/transfer";
  if (short.includes("/share/pset")) return "⑤ 建分享 share/pset";
  if (short.includes("/api/list")) return "· 登录态自检 api/list";
  return "· " + short;
};

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);

// 注：下面两个辅助函数刻意写成 `const … = () => {}` 而不是 `function …`。
// round13 的 D4 守卫规定"任何函数声明都不许落在 process.exit(0) 之后"（它的本意是防
// `pan-transfer-ui.js` 那种**永不可达**的代码）。本文件的 exit 在 `if (help)` 分支里、
// 函数其实可达，但守卫是扫文本的、分不出这个区别 —— 按本项目的规矩，**改代码去符合规矩**，
// 而不是给守卫开个例外。箭头函数也没有"声明提升"那类意外，顺带更安全。
const summarize = (label, list) => {
  const byStep = new Map();
  for (const c of list) {
    const s = stepOf(c.step);
    const cur = byStep.get(s) || { n: 0, ms: 0, fails: 0 };
    cur.n += 1; cur.ms += c.ms; if (c.status >= 400 || c.err) cur.fails += 1;
    byStep.set(s, cur);
  }
  console.log(`\n──── ${label} ────`);
  console.log("  步骤".padEnd(30) + "次数".padStart(4) + "总耗时".padStart(10) + "平均".padStart(10));
  let total = 0;
  for (const [s, v] of byStep) {
    total += v.ms;
    console.log("  " + s.padEnd(28) + String(v.n).padStart(4) + fmt(v.ms).padStart(10) + fmt(Math.round(v.ms / v.n)).padStart(10)
      + (v.fails ? `   ⚠️ ${v.fails} 次非 2xx/异常` : ""));
  }
  console.log("  " + "请求合计".padEnd(28) + String(list.length).padStart(4) + fmt(total).padStart(10));
  return total;
};

// ─────────────────────── 读表选链接 ───────────────────────
const newestResourceTable = () => {
  const dir = path.join(dataDir, "搜资源");
  if (!fs.existsSync(dir)) return "";
  const files = fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(dir, files[0].f) : "";
};

const tablePath = arg("table") || newestResourceTable();
if (!tablePath || !fs.existsSync(tablePath)) { console.error("找不到资源表，用 --table 指定"); process.exit(2); }
const rows = excel.readTableRows(tablePath, { raw: false });
const { nameKey, linkKey, pwdKey } = detectColumns(rows);

// 已完成的链接：换号后重跑会命中 errno=4（已转存过），那量不出"真转存"的耗时，
// 所以探针要挑**没转过**的行 —— 这也正是批量转存实际在做的事。
const ledgerDir = path.join(dataDir, "批量转存");
const done = new Set();
if (fs.existsSync(ledgerDir)) {
  for (const d of fs.readdirSync(ledgerDir)) {
    const sf = path.join(ledgerDir, d, "state.jsonl");
    if (!fs.existsSync(sf)) continue;
    for (const st of loadLedger(sf, "srcLink").values()) if (st.srcLink) done.add(st.srcLink);
  }
}

const picked = [];
// `--tail`：从表的**末尾**往回挑。
// 为什么需要它：批量转存是**从第 1 行往后**跑的。如果用户那个批量任务正开着，
// 探针从表头挑就会和它抢同一批链接（同 IP、同账号，正好是把自己打进限流窗口的形态）。
// 从末尾挑 = 挑那些"还没轮到"的行，互不干扰。
//
// `--any`：不过滤"已转存"的行。只在 `--dry / --compare`（零副作用）下才有意义 ——
// 用途是去量**表头那批**链接（批量任务已经跑过、形状最贵的那批：根目录是个文件夹，
// 老路径要为它打 N 次 /share/list）。不挑已转存的行就永远量不到它们。
// `--offset N`：从扫描序列的第 N 行开始（配合 --any 精确落到某一段）。
const anyRow = has("any");
const offset = Math.max(0, Number(arg("offset", "0")) || 0);
if (anyRow && !dryRun) { console.error("--any 只允许配合 --dry / --compare（否则会对同一批行反复真转存）"); process.exit(2); }
const scan = (has("tail") ? [...rows].reverse() : rows).slice(offset);
for (const r of scan) {
  const { link, pwd } = parseLinkCell(String(r[linkKey] || "") + (pwdKey ? ` 提取码:${r[pwdKey]}` : ""));
  if (!link || !pwd) continue;
  const src = link + (link.includes("pwd=") ? "" : `?pwd=${pwd}`);
  if (!anyRow && done.has(src)) continue;
  picked.push({ src, pwd, name: String(r[nameKey] || "").slice(0, 30) });
  if (picked.length >= wantN) break;
}

// ─────────────────────── 主流程 ───────────────────────
(async () => {
  console.log(`测速账号：${envLabel}（**不要**用正在跑批的号）`);
  console.log(`资源表：${path.basename(tablePath)}（共 ${rows.length} 行，已转存 ${done.size} 条，本次挑 ${picked.length} 条未转存的）`);
  console.log(`目标目录：/来自资源批量转存/测速探针/${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`);
  console.log(`建分享：${withShare ? "量（会真的建 1 个分享链接）" : "不量（跳过 share/pset）"}`);
  if (compare) console.log("模式：**快慢对照**（同一条链接跑两遍：快路径 vs 完整枚举，都走 dryRun，对网盘零副作用）");
  else console.log(`模式：${dryRun ? `**只读解析**（${dryRun === "slow" ? "强制慢路径完整枚举" : "默认快路径"}：不建目录、不转存、不建分享，对网盘零副作用）` : "完整链（会在该账号网盘里留下文件）"}`);

  const cred = credentialOf(dataDir, envLabel);
  if (!cred || !cred.bduss) {
    console.error(`\n❌ 「${envLabel}」没有已存的网盘 Cookie。先到「账号凭证」页存一次。`);
    process.exit(3);
  }
  const jar = new Jar(cred.bduss, cred.stoken, undefined);   // 无代理 = 直连，和用户当前设置一致
  const client = makeClient(jar);

  // 先做一次只读自检：既验登录态，也给出"一次请求的地板延迟"
  const t0 = Date.now();
  const base = await client("/api/list?dir=/&num=1&web=1&channel=chunlei&clienttype=0").catch((e) => ({ errno: -1, _e: e.message }));
  const baseMs = Date.now() - t0;
  console.log(`\n登录态自检：errno=${base.errno === undefined ? "?" : base.errno}（-1 表示请求本身失败）  单次请求地板延迟 ≈ ${fmt(baseMs)}`);
  if (base.errno === -1) console.log(`  ⚠️ ${base._e}`);
  const selfCheckCalls = calls.splice(0, calls.length);

  const destRoot = "/来自资源批量转存/测速探针";
  const perItem = [];
  let coverageFail = 0;   // --compare：慢路径枚举到、而快路径覆盖不到的文件个数 > 0 的链接数
  for (let i = 0; i < picked.length; i += 1) {
    const it = picked[i];
    const mark = calls.length;
    const t = Date.now();
    const common = {
      link: it.src, pwd: it.pwd, destParent: `${destRoot}/${envLabel}/${i + 1}`,
      fallbackName: String(i + 1).padStart(5, "0"),
      createdDirs: new Set(),   // 故意不缓存：量的是"每条都要建目录"的最坏情况
    };
    let outcome = "";
    try {
      if (compare) {
        // ── 快慢对照 ──
        // 快路径：拿分享页根条目直接转存（不调 /share/list）；慢路径：强制完整枚举。
        // 目的有两个：① 量出省了多少；② **证明没漏文件** —— 快路径最大的风险是
        // "转存成功但少文件"，那是最难被发现的部分成功，必须在这里用路径覆盖关系验掉。
        //
        // ⚠️ 顺序必须两条链接**交替**（偶数条先快后慢、奇数条先慢后快）。
        // 这是踩过的测量坑：第一次实现是"永远先跑快路径"，结果第二条跑的时候连接/证书都热了，
        // 于是量出来"快路径比慢路径慢 0.7 倍"——那个数字量的是**顺序**，不是两条路的差别。
        const fastFirst = i % 2 === 0;
        const runs = async () => ({
          t: Date.now(),
          r: await processOne(jar, { ...common, dryRun: fastFirst ? true : "slow" }),
        });
        const a = await runs();                       // 第一条
        const b = await runs();                       // 第二条
        a.ms = Date.now() - a.t; b.ms = Date.now() - b.t;
        const fast = fastFirst ? a : b;
        const slow = fastFirst ? b : a;
        const fastMs = fast.ms;
        const slowMs = slow.ms;
        const fastPaths = (fast.r.filePaths || []).map(String);
        const slowPaths = (slow.r.filePaths || []).map(String);
        // 覆盖判据：慢路径枚举出的**每一个文件路径**都要落在快路径某个根条目之下
        //（根条目本身是文件 → 要求相等；是文件夹 → 要求以它开头）。一个都不能漏。
        const missing = slowPaths.filter((p) => !fastPaths.some((f) => p === f || p.startsWith(f.endsWith("/") ? f : `${f}/`)));
        if (missing.length) coverageFail += 1;
        outcome = `快 ${fastMs}ms（share/list ×${fast.r.listCalls}，根 ${fast.r.rootEntries} 条 → ${fast.r.fsIds.length} 个 fs_id）`
          + ` | 慢 ${slowMs}ms（share/list ×${slow.r.listCalls} → ${slow.r.fsIds.length} 个文件）`
          + ` | 覆盖 ${slowPaths.length - missing.length}/${slowPaths.length}`
          + (missing.length ? ` ❌ 漏了：${missing.slice(0, 3).join(", ")}` : " ✓ 一个都没漏")
          + (slow.r.listCalls ? ` | 省下 ${slow.r.listCalls} 次 share/list` : " | 这条两种路径都没打 share/list（根就是文件）");
      } else {
        const res = await processOne(jar, { ...common, dryRun });
        if (res.dryRun) {
          outcome = `解析 OK：${res.fsIds.length} 个条目（${res.usedFastPath ? "快路径，0 次 share/list" : `慢路径，${res.listCalls} 次 share/list`}），分享页打了 ${res.sharePageAttempts} 次`;
        } else if (res.pending) outcome = "异步转存中（大文件）";
        else if (res.dup) outcome = "errno=4 已转存过（复用，未新增文件）";
        else outcome = `成功，落盘 ${res.toPaths.length} 个`;
        // 只量一次建分享：够看出它的耗时就够了，别在这个账号里刷出一堆分享链接
        if (withShare && !dryRun && i === 0 && res.toPaths && res.toPaths.length) {
          const sh = await createShare({ bduss: cred.bduss, stoken: cred.stoken, paths: res.toPaths, password: "0000", dispatcher: undefined });
          outcome += ` | 分享已建(${sh.link ? "有链接" : "无链接"})`;
        }
      }
    } catch (e) {
      outcome = `失败：${(e.message || "").slice(0, 120)}`;
    }
    const itemMs = Date.now() - t;
    const mine = calls.slice(mark);
    perItem.push({ itemMs, calls: mine.length });
    console.log(`\n[${i + 1}/${picked.length}] ${it.name}`);
    for (const c of mine) console.log(`    ${String(c.ms).padStart(6)}ms  ${c.method.padEnd(4)} ${stepOf(c.step)}  ${c.status}${c.err ? "  " + c.err : ""}`);
    console.log(`    ${String(itemMs).padStart(6)}ms  ← 这一条合计（含脚本自身开销，**不含**代码里刻意留的间隔）  ${outcome}`);
    if (i < picked.length - 1 && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }

  const totalWall = perItem.reduce((s, x) => s + x.itemMs, 0);
  const callTotal = calls.reduce((s, c) => s + c.ms, 0);
  summarize(`明细汇总（${picked.length} 条）`, calls);
  const avgItem = Math.round(totalWall / Math.max(1, perItem.length));
  const perCall = calls.length ? Math.round(callTotal / calls.length) : 0;
  const callCount = calls.length / Math.max(1, perItem.length);

  console.log("\n════════ 结论 ════════");
  if (compare) {
    console.log(`  快慢对照：${coverageFail
      ? `❌ 有 ${coverageFail} 条链接快路径**覆盖不全**（慢路径枚举到的文件没被快路径的根条目盖住）—— 这种情况绝不允许上`
      : "✓ 所有链接快路径都没漏文件（慢路径枚举出的文件，全部落在快路径的根条目之下）"}`);
  }
  console.log(`  每条平均：${fmt(avgItem)}   平均每条约 ${callCount.toFixed(1)} 个请求   单次请求平均 ${fmt(perCall)}`);
  console.log(`  单次请求地板（一次 /api/list）：${fmt(baseMs)}`);
  console.log(`  ⇒ 每条的理论下限 ≈ 请求数 × 单次地板 = ${(callCount * baseMs / 1000).toFixed(1)} 秒（串行、不含任何间隔）`);
  console.log(`  批量转存实测 9.18 秒/条，其中代码刻意留的间隔（delayMin~delayMax 默认 1~2 秒）约 1.5 秒`);
  console.log("\n  说明：想真正提速只有两条路 —— ①减少每条的请求数；②让多条链同时跑（并发）。");
  console.log("        ① 已经做了：分享页的根条目直接交给 /share/transfer（文件夹由百度在服务端递归复制），");
  console.log("           /share/list 这一次（实测平均 2.9 秒）整条不再需要 —— 用 --compare 验它没漏文件；");
  console.log("        ② 并发能不能开，取决于「同 IP、不同账号、一号一线程」会不会被降级，");
  console.log("           这一条必须单独做 A/B 对照（见 CHANGELOG 2026-10-10 那次的教训）。");
})();
