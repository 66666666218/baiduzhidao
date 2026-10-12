"use strict";

/**
 * 批量转存任务（软件内置 · 纯协议版）：
 *   选资源表格（xlsx/txt）→ 从指定比特环境提取一次网盘凭证
 *   → 纯 HTTP 协议批量：verify → 解析 → 建目录 → 转存 → 确权自有永久分享
 *   → 自动生成答题模板问答行 → 输出上传专用表 xlsx。
 *
 * 断点续跑（state.jsonl）/ 失败3次黑名单 / 连续失败熔断 / 容量不足优雅停止。
 * 全程无需窗口点击；风控条目自动跳过并记录。
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");
const { createShare, isShareLimitError, isShareForbiddenError, randomPwd, SHARE_DAILY_LIMIT, SHARE_SOFT_WARN_AT } = require("../netdisk/share");
const { Jar, processOne } = require("../netdisk/protocol");
// 表单元格 → {link, pwd}：曾经在 4 个文件里各有一份拷贝，其中一份漏改导致整表静默跳过，
// 现在收敛到 netdisk/pan-link.js 一处（见该文件头注释）。
const { parseLinkCell } = require("../netdisk/pan-link");
// 「哪一列是名称/链接/提取码」——原本四处、三种算法，收敛到一处
const { detectColumns } = require("../netdisk/table-columns");
// 转存台账（state.jsonl）的读写——原本五份，收敛到一处
const { loadLedger, appendLedger } = require("../netdisk/state-ledger");
// 重跑时「share_failed 的行要不要补分享 / 要不要彻底跳过」——只有这一处判断（见该文件头注释）
const { planShareRetry, shareRetryFields } = require("../netdisk/share-retry");
// 读 xlsx 统一走 storage/excel.js（本文件不再自己 XLSX.readFile）
const excel = require("../storage/excel");
const qaLib = require("../netdisk/qa-template-lib");
const { credentialHint } = require("../netdisk/manager");
const { envLabelsOf, dedupeEnvLabels } = require("../domain/account-topic");


// 打包后 __dirname 在 asar 内且安装目录不可写：数据一律放用户数据目录（%AppData%\zhidao-answer-studio）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 表格名是否为"通用/序号"占位（不能作为资源名）：序号、链接N、纯符号、通用词 */
function isGenericName(n) {
  const s = String(n || "").trim();
  if (!s || s.length < 4) return true;
  if (/^链接\d+$/.test(s)) return true;              // txt 模式占位
  if (/^[\d\s\-_.、（）()]+$/.test(s)) return true;  // 纯数字/编号/符号
  if (/^(资源|文件|附件|素材|下载|链接|文档|资料)\d*$/.test(s)) return true; // 通用词
  const cjk = (s.match(/[一-龥]/g) || []).length;
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  if (cjk < 2 && letters < 4) return true;            // 无足够中文也无足够字母 → 非描述性
  return false;
}

// 注：4 位随机提取码的生成函数原本在本文件、netdisk-share-existing.js、
// pan-transfer-pipeline.js 三处各有一份（内容相同、变量名不同），已收敛到
// netdisk/share.js 的 randomPwd（从上面 require 进来）。

/**
 * 转存成功后建分享，并正确区分「分享失败」与「转存失败」。
 *
 * 为什么要单独抽出来（不是顺手写两行）：分享创建是一个**独立的失败域**。
 * 百度限制单账号每日最多 300 个分享链接（see share.js 的 SHARE_DAILY_LIMIT），
 * 超额后再建分享会被拒（errno=120 或提示"分享次数已达上限"）。以前这步的失败被外层
 * catch 当成"整条失败"——于是已经落盘的文件被算作失败、下次又被重新转存（errno=4 重复）
 * + 再次建分享（继续被拒），形成"虚假失败"死循环，还白白消耗转存写请求去撞限流窗口。
 *
 * 这里：转存成了就返回 `shareFailed=true`（调用方据此记「已转存（建分享失败）」，
 * **不重传、不计失败**）；若判定是每日上限，则把该账号加入 `shareBlocked`，
 * 本批后续项只转存不建分享，避免反复撞限。
 *
 * 分享失败分三种，处置不同（依据：本机参考实现 wangpan 的 CHANGELOG 记录百度 errno=115
 * 「禁止二次分享」、以及单账号每日 300 分享上限）：
 *   1. **每日上限**（errno=120 / 文案"分享次数已达上限"）→ 换号或等明天能好
 *      → 封禁该账号本批剩余项，下次运行重试；
 *   2. **该资源被禁止分享**（errno=115）→ 无论换哪个号、等多久都不会成功
 *      → 只放弃这一条的分享，**不封禁账号**（同账号其它资源照样能建分享）；
 *   3. 普通失败（网络抖动 / 偶发拒绝）→ 记档，下次运行再试。
 *
 * @param {Function} [createShareFn] 便于测试时注入假的 createShare
 */
async function runShareStep({ makeShare, env, bduss, stoken, toPaths, dispatcher, shareBlocked, sharesByEnv, warnedSoft, log, createShareFn = createShare }) {
  const out = { ownLink: "", ownPwd: "", shareFailed: false, shareLimited: false, shareForbidden: false, shareErrMsg: "" };
  // 该账号已撞上限：本批剩余项直接"只转存不建分享"，避免每条都再去撞一次分享接口。
  if (shareBlocked.has(env)) {
    out.shareFailed = true;
    out.shareLimited = true;
    return out;
  }
  if (!makeShare) return out;
  try {
    const pwd = randomPwd();
    const share = await createShareFn({ bduss, stoken, paths: toPaths, password: pwd, dispatcher });
    if (!share.link) throw new Error("创建分享失败");
    out.ownLink = `${share.link}?pwd=${share.password}`;
    out.ownPwd = share.password;
    const n = (sharesByEnv.get(env) || 0) + 1;
    sharesByEnv.set(env, n);
    if (n >= SHARE_SOFT_WARN_AT && !warnedSoft.has(env)) {
      warnedSoft.add(env);
      log(`⚠️ ${env} 今日已建 ${n} 个分享链接，逼近百度单账号每日上限（${SHARE_DAILY_LIMIT}），再超就会建分享失败。`);
    }
  } catch (se) {
    out.shareFailed = true;
    out.shareErrMsg = se.message || "";
    out.shareLimited = isShareLimitError(se);
    out.shareForbidden = isShareForbiddenError(se);
    if (out.shareLimited) {
      shareBlocked.add(env);
      log(`⏳ ${env} 已达百度每日分享上限（${SHARE_DAILY_LIMIT}/天），本批后续仅转存不建分享。`
        + `这些资源已进你的网盘，明天或清理后可在网盘内手动生成分享链接。`);
    } else if (out.shareForbidden) {
      // 只放弃这一条：百度不允许再分享**这条**资源，换号/等明天都没用。
      // 不封禁账号 —— 同账号其它资源照样能建分享，别因一条把整批都拖成"只转存"。
      log(`🚫 有资源被百度**禁止二次分享**（errno=115）：${out.shareErrMsg.slice(0, 80)}`
        + `—— 换号/等明天都不会成功，已跳过它的分享（资源仍在网盘）；同账号其它资源不受影响。`);
    }
  }
  return out;
}

/** 并行上限：再多也没意义（账号数才是天然天花板），反而容易被当成攻击 */
const MAX_TRANSFER_PARALLELISM = 8;

/**
 * 决定本次实际开几个线程。规则一句话：**线程数永远不能超过账号数**。
 *
 * 超过账号数就意味着"同一个账号在同一时刻发出两个请求" —— 而账号数 == 饼干数，
 * 也就等于"同一个出口 IP 上的并发"，那正是会触发百度降级窗口的形态。
 * 宁可把这个上限卡死，也不要让用户靠试错去体会。
 *
 * @param {number} requested    用户显式指定的并发（0/未给 = 自动）
 * @param {number} creds        实际可用账号数
 * @param {number} autoParallel 自动判定值（给每个账号配了不同代理才 >1）
 */
function resolveTransferParallelism({ requested, creds, autoParallel }) {
  const accounts = Math.max(1, Math.floor(Number(creds) || 0) || 1);
  const cap = Math.max(1, Math.min(accounts, MAX_TRANSFER_PARALLELISM));
  const want = Math.floor(Number(requested) || 0) > 0
    ? Math.floor(Number(requested))
    : Math.max(1, Math.floor(Number(autoParallel) || 1) || 1);
  return Math.max(1, Math.min(want, cap));
}

/**
 * 串行轮换时挑下一个**还没满**的账号；全部满了返回 null（调用方据此停）。
 *
 * 为什么需要它（依据：本机参考实现 wangpan 的 development-blog 明确总结
 * "容量不足应换同类型账号继续，而不是终止整个任务"）：
 * 多账号跑批时，以前账号1 的网盘一满就 `fatalStop` 整批停止 ——
 * 账号2/3/4 的空间全在那儿闲着，用户还得自己重新配置再跑一遍。
 * 现在跳过满了的账号，剩下的账号接着把剩下的资源转完。
 */
function nextUsableEnv(creds, exhaustedEnvs, fromIndex) {
  const n = creds.length;
  for (let k = 0; k < n; k += 1) {
    const i = (((Number(fromIndex) || 0) % n) + n + k) % n;
    if (!exhaustedEnvs.has(creds[i].env)) return creds[i];
  }
  return null;
}

/**
 * 撞上"容量不足"（e.fatal）时的处置决策。三种结局：
 *   - 还有别的账号 → 跳过错账号，本批继续（串行直接换号，并行让该线程退出、其它线程照跑）；
 *   - 全部账号都满 → 才真正停整批；
 *   - 并行时本线程绑定的账号满了 → 本线程退出（不能抢别的账号：线程≤账号数是硬前提）。
 *
 * @returns {{stopAll: boolean, exitWorker: boolean, restEnvs: string[]}}
 */
function decideCapacityOutcome({ creds, exhaustedEnvs, env, cc }) {
  const after = exhaustedEnvs.has(env) ? exhaustedEnvs : new Set([...exhaustedEnvs, env]);
  const rest = creds.filter((c) => !after.has(c.env)).map((c) => c.env);
  const stopAll = rest.length === 0;
  // 并行：本线程只有自己那一个账号可用，它满了就只能退出（别的线程有自己的账号，不受影响）。
  const exitWorker = stopAll || Number(cc) > 1;
  return { stopAll, exitWorker, restEnvs: rest };
}

/**
 * 把 payload 里的环境名解析成干净的字符串数组。
 *
 * 以前这里是 `Array.isArray(x) ? x : String(x).split(",")` —— 既不 trim、也不认 `{label}` 写法。
 * 于是 `"账号1, 账号2"`（逗号后带空格，用户手写时很常见）会得到名字 `" 账号2"`：
 * 取不到已存的 Cookie、也匹配不上比特环境（比特那边要求名字一字不差），
 * 最后报出来的是「没有任何窗口具备 pan.baidu.com 登录态」—— 完全看不出真凶是一个空格。
 * 现在统一交给 `envLabelsOf`（trim + 剔空 + 取出 label），与其它任务同一套规则。
 *
 * **并且在这里就去重**：下面 `for (const env of envList) creds.push(...)` 是「一个名字一个 slot」，
 * 同一个名字写两遍会得到两条**完全相同**的 creds。后果比"那号多干一遍"更严重：
 *   - 并行分支里 `pickEnvForSlot(slot)` 把两个线程绑到同一个账号、同一个出口 IP，
 *     直接撞上分享页的并发降级窗口（2026-10-10 实测：cc=2 时 9/9 失败）；
 *   - `distinctExits` 也会把重复项算进 `creds.length`，把并发数抬到一个并不存在的"第二个账号"上。
 * 去重规则与上传侧同一个函数（`dedupeEnvLabels`），不再各写一份。
 *
 * @returns {{labels: string[], duplicated: string[]}}
 */
function parseEnvListDetailed(payload) {
  const p = payload || {};
  const raw = (p.bitEnvs !== undefined && p.bitEnvs !== null && p.bitEnvs !== "") ? p.bitEnvs : p.bitEnv;
  const list = Array.isArray(raw) ? raw : String(raw || "").replace(/[，\r\n]/g, ",").split(",");
  return dedupeEnvLabels(envLabelsOf(list));
}

/** 只要干净数组时用这个（= parseEnvListDetailed().labels） */
function parseEnvList(payload) {
  return parseEnvListDetailed(payload).labels;
}

async function runBatchTransferTask(ctx, deps) {
  const { app } = require("electron"); // 主进程内可用：数据放用户数据目录（打包后安装目录不可写）
  const { browserPool, log } = deps;
  const baseDataDir = deps.dataDir || app.getPath("userData"); // 与「打开数据目录」指向同一处
  const dataDir = path.join(baseDataDir, "\u6279\u91cf\u8f6c\u5b58");
  const payload = ctx.livePayload ? ctx.livePayload() : ctx.payload;
  // 纯协议模式下没有凭据也**不开窗口**（用户选它正是为了不开；很多机器内存开不起来）。
  const _mode = String((deps.config && deps.config.load && deps.config.load().browserMode) || "protocol");
  const filePath = String(payload.filePath || "").trim().replace(/^"|"$/g, "");
  if (!filePath || !fs.existsSync(filePath)) throw new Error("请先选择资源表格（xlsx 或 txt，一行一个链接）");
  // 多账号：bitEnvs 数组（逗号分隔或数组），按窗口轮换；单账号兼容 bitEnv
  const { labels: envList, duplicated: dupEnvs } = parseEnvListDetailed(payload);
  if (!envList.length) throw new Error("请填写至少一个比特环境名（多账号每行一个）");
  // 同名账号被丢掉必须说出来：用户填了 3 行却只跑了 2 个号，静默吞掉的话
  // 他会以为是"那个号没跑到"，而真实原因是名字重复。这条日志是唯一的线索。
  if (dupEnvs.length) log(`⚠️ 转存账号里有重复名字（${dupEnvs.join("、")}），已自动去重 ——`
    + "不去重会让两个线程绑到同一个账号和同一个出口 IP，撞上分享页并发降级窗口。");
  log(`本次转存账号（${envList.length} 个）：${envList.join("、")}`);
  const perEnv = Math.max(1, Number(payload.perEnv) || 50); // 每窗口连续处理条数（轮换粒度）
  const destRoot = String(payload.destDir || "/来自资源批量转存").trim() || "/来自资源批量转存";
  const limit = Math.max(0, Number(payload.limit) || 0);
  // 并发数：0/未给 = **自动判定**（见下面的 resolveTransferParallelism）。
  //
  // 为什么默认不并发（这条结论是 2026-10-10 的真机对照实验换来的，别凭直觉改）：
  //   串行 cc=1  → 28 个请求 0 失败
  //   并发 cc=2  → 9/9 失败
  //   并发 cc=4  → 4/9 失败
  // 也就是说"分享页取不到数据"**不是链接坏、不是格式问题、也不是账号被封**，
  // 而是**同一个出口 IP 短时间内的并发请求数**触发的降级窗口（两个账号共用 IP 时会出现
  // "账号1 失败、账号2 正常"的交替现象，正因为谁的请求落在窗口里谁中招）。
  //
  // 那为什么现在又允许并发？因为上面那次实验里 cc=2 的**两个 worker 抢的是同一个账号**
  //（原来的 pickEnv 用全局游标轮换，两个线程几乎必然同时拿到 creds[0]）——
  // 它验证的是"同 IP 并发"，不是"多账号并发"。真正的答案是**让每个线程固定绑定一个账号**，
  // 账号之间再用「账号代理」错开出口 IP。这样 N 个账号就是 N 条独立的链，
  // 每个账号内部依然严格串行，与上面那条实验结论并不冲突。
  const ccRequested = Math.max(0, Number(payload.cc) || 0);
  const delayMin = Math.max(0.5, Number(payload.delayMin) || 1);
  const delayMax = Math.max(delayMin, Number(payload.delayMax) || 2);
  const makeShare = payload.makeShare !== false;
  const startIdx = Math.max(0, Number(payload.start) || 0);
  // 自定义输出表名（默认 上传专用表-已转存）
  const outNameRaw = String(payload.outName || "").trim().replace(/[\/:*?"<>|]/g, "_").slice(0, 60);
  const outName = outNameRaw || "上传专用表-已转存";

  // 读表 / 链接清单
  const XLSX = require("xlsx");
  let rows;
  if (/\.txt$/i.test(filePath)) {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    rows = lines.map((line, i) => ({ __name: `链接${i + 1}`, __link: line }));
  } else {
    // 读表统一走 storage/excel.js 的 readTableRows（全仓唯一入口）。
    // ⚠️ raw:false 不能省：资源表里的提取码看着像数字（甚至带前导零），
    //   按原始值读会把 `0023` 变成 23，数据直接丢。
    rows = excel.readTableRows(filePath, { raw: false });
  }
  if (!rows.length) throw new Error("资源表为空");
  const { nameKey, linkKey, pwdKey, nameDegraded } = detectColumns(rows);
  log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);
  if (nameDegraded) {
    log(`⚠️ 这张表没有可用的「名称」列（现在拿"${nameKey}"凑数），资源名不可信。`
      + "建议给资源表加一列「名称」或「标题」，否则出题的标题会是链接/提取码。");
  }

  // 取各账号的网盘凭证。**优先用「账号凭证」里存好的 Cookie —— 存过就完全不开窗口**。
  // 转存之后的全程本来就不碰浏览器（纯 HTTP 协议），所以只要凭据能拿到，
  // 整条网盘链可以做到零窗口 —— 内存紧张的机器尤其需要这一点。
  const { credentialOf, quota: netdiskQuota } = require("../netdisk/manager");
  const creds = []; // {env, bduss, stoken}
  for (const env of envList) {
    let bd = "", st = "";
    const stored = credentialOf(baseDataDir, env);
    if (stored) {
      bd = stored.bduss;
      st = stored.stoken;
    } else {
      log(`提取网盘凭证：${env}（未存 Cookie，开窗口取登录态）`);
      log(`   ⚠️ 为什么没存到：${credentialHint(baseDataDir, env)}`);
      if (_mode === "protocol") {
        log("   → 纯协议模式不打开比特窗口，本账号跳过（想用窗口请把运行模式改成「比特窗口」）。");
        continue;
      }
      const h = await browserPool.acquire(env);
      const b = await chromium.connectOverCDP(h.cdpUrl);
      const cs = await b.contexts()[0].cookies("https://pan.baidu.com");
      bd = (cs.find((c) => c.name === "BDUSS") || {}).value || "";
      st = (cs.find((c) => c.name === "STOKEN") || {}).value || "";
      await browserPool.release(env, { close: false });
      await b.close().catch(() => {});
    }
    if (!bd) { log(`⚠️ ${env} 没有网盘登录态（既没存 Cookie，窗口里也没登录），跳过该账号`); continue; }
    creds.push({ env, bduss: bd, stoken: st });
    log(`✅ ${env} 凭证就绪 BDUSS(${bd.length}字符)${stored ? "（用存的 Cookie，未开窗口）" : ""}`);
  }
  if (!creds.length) {
    // 把"为什么一个都没有"说清楚：多数是名字对不上，而不是真的没登录
    throw new Error("没有任何账号可用作转存（既没有已保存的网盘 Cookie，也没能开窗口取到登录态）。"
      + credentialHint(baseDataDir, envList[0]));
  }
  const bduss = creds[0].bduss;   // 兼容旧引用（分享创建用首个窗口凭证）
  const stoken = creds[0].stoken;
  log(`多账号就绪：${creds.length} 个窗口 —— 全程纯协议批量轮换`);

  // ── 并发判定 ──
  // 「一个线程固定一个账号」是能不能并发的前提；前提是还不够 —— **出口 IP 也得不同**。
  // 两个账号都直连时，即使线程隔离了账号，请求仍从同一个 IP 出去，还是会被降级。
  // 所以：只有给每个账号配了**互不相同**的代理（设置页「账号代理」），才自动放开并行。
  const { parseAccountProxies } = require("../netdisk/proxy");
  const proxyMap = parseAccountProxies(String((deps.config && deps.config.load && deps.config.load().accountProxies) || ""));
  const exitOf = (env) => String(proxyMap[env] || "").trim();
  const distinctExits = new Set(creds.map((c) => exitOf(c.env)).filter(Boolean));
  const autoParallel = distinctExits.size >= 2 ? Math.min(distinctExits.size, creds.length, MAX_TRANSFER_PARALLELISM) : 1;
  const cc = resolveTransferParallelism({ requested: ccRequested, creds: creds.length, autoParallel });

  // 转存前先把各账号的网盘剩余空间打出来。**只提示、不拦**：
  // 盘满时下面本来就有"容量不足 → 停止本轮"的 fatal 分支，硬拦反而会误杀
  // "只剩几 GB 但还能传几条小文件"的情况。
  // 2026-10-10 真机实测：两个号一个是 505GB 全满、一个是 5.2TB 空着 ——
  // 那次是靠人工先看了 quota 才把满盘那个排除在转存账号之外的。
  // 提前把数字说出来，用户就能在跑之前判断"这次大概能传几条"，而不是跑一半才发现。
  for (const c of creds) {
    try {
      const q = await netdiskQuota(c);
      if (q && q.valid) {
        log(`网盘空间：${c.env} 剩余 ${q.freeGB}GB / 总 ${q.totalGB}GB`);
        if (q.freeGB <= 5) {
          log(`⚠️ ${c.env} 的网盘快满了（剩余 ${q.freeGB}GB）—— 影视类资源常见 2GB/条，`
            + `可能传不了几条就会触发「容量不足」并停止本轮（已转存的不会丢，可换号或清理空间后续传）。`);
        }
      }
    } catch (e) {
      log(`（查 ${c.env} 的网盘空间失败，不影响转存：${e.message}）`);
    }
  }

  // 断点状态
  const baseName = path.basename(filePath).replace(/\.(xlsx|txt)$/i, "").slice(0, 40);
  const workDir = path.join(dataDir, baseName);  // dataDir 已含"批量转存"层，不再重复
  const stateFile = path.join(workDir, "state.jsonl");
  const outDir = path.join(workDir, "上传专用表");
  // 台账读写收敛到 netdisk/state-ledger.js（原本本文件内联一份、脚本里另有四份）
  const state = loadLedger(stateFile, "srcLink");
  const saveState = (e) => appendLedger(stateFile, e);

  // 规范化名称去重键：历史已完成 + 本轮动态累积（同一资源不同链接也只转一次）
  const seenKeys = new Set();
  for (const st of state.values()) {
    if (st.status === "done" && st.name) {
      const k = qaLib.normalizeName(st.name);
      if (k && k.length >= 2) seenKeys.add(k);
    }
  }
  log(`去重键库载入：${seenKeys.size} 个（按规范化名称，跨写法/跨链接去重）`);

  const total = limit > 0 ? Math.min(limit, rows.length - startIdx) : rows.length - startIdx;
  log(`开始纯协议批量转存：目标 ${total} 条 | 并发 ${cc}（${creds.length} 个账号） | 目标目录 ${destRoot}`);
  if (makeShare) {
    // 百度硬限制：单账号每日最多 300 个分享链接。超大批（全量采集常见 >300）若每条都建分享，
    // 超出部分的资源会建不出分享。提前把话说清楚，免得用户以为"那些条转存失败了"。
    const shareCap = creds.length * SHARE_DAILY_LIMIT;
    if (total > shareCap) {
      log(`⚠️ 本次要转存 ${total} 条、每条都会建分享，但百度限制**单账号每日最多 ${SHARE_DAILY_LIMIT} 个分享链接**`
        + `（共 ${creds.length} 个账号 ≈ 上限 ${shareCap} 条）。超出部分的资源会照常转存进网盘，但建不了分享、`
        + `也不会进上传专用表；可换号 / 次日 / 在网盘内手动生成分享链接补足。`);
    }
  }
  if (cc > 1) {
    log(`${cc} 条链并行：**每个线程固定一个账号**，账号之间靠「账号代理」错开出口 IP，单个账号内部仍然严格串行。`);
    log(`提示这里为什么安全：以前那条"并发 2 就 100% 失败"的实验结论，前提是**两个线程抢同一个账号**`
      + `（那时光标轮换下两者几乎必然同时拿到 creds[0]）——它验的是同 IP 并发，不是多账号并发。`);
  } else if (creds.length > 1 && ccRequested <= 0) {
    // 把"为什么没并起来"说清楚，否则用户只会觉得软件慢，而不知道慢是自己没配代理导致的。
    log(`串行模式：${creds.length} 个账号轮流处理，同一时刻只有一条链在跑。`);
    log(`　想并行到 ${Math.min(creds.length, MAX_TRANSFER_PARALLELISM)} 条，去设置页「账号代理」给每个账号配一条**互不相同**的代理 ——`
      + `线程数已经被硬性限制为不超过账号数，所以不会退化成"同一个号同时发两个请求"那种必失败的形态。`);
  }
  ctx.report({ done: 0, total, status: "running" });

  let done = 0, failed = 0, fatalStop = false;
  // 分享相关的本批状态：转存成功但分享没建成（常见原因是百度单账号每日 300 分享上限）
  // 不能当成"整条失败"重传 —— 文件已在网盘，重传只会 errno=4 重复 + 再撞分享上限。
  let transferredNoShare = 0;
  const sharesByEnv = new Map();   // env → 本批已建分享数（用于逼近上限时提前警告）
  const shareBlocked = new Set();  // 已确认撞上每日分享上限的账号（本批剩余项只转存不建分享）
  const warnedSoft = new Set();
  // 网盘已满的账号：本批跳过它，其余账号继续（见 nextUsableEnv / decideCapacityOutcome）。
  const exhaustedEnvs = new Set();
  // 连续失败计数**必须是全局共享的**（它判的是"整条管线是不是在持续失败"），
  // 但**绝不能由单个 worker 的 break 来表达停止** —— 那样只停自己，另外三个照跑。
  // 做法：计数共享，一旦到阈值就置 `fatalStop`（while 条件已共享检查它），
  // 与下面容量不足的 `e.fatal` 用同一套停止语义。
  let consecutiveFails = 0;
  const FAIL_STREAK_LIMIT = 10;
  // 风控暂停用**共享的时间戳**，而不是各 worker 自己 sleep：
  // 以前每个 worker 遇到风控都各自 `await sleep(10min)`，醒来时刻还各不相同——
  // 结果是"看起来全局静默了，其实 4 个 worker 在 10 分钟后集中爆发"，比不暂停更糟。
  let pausedUntil = 0;
  // 限流（分享页取不到数据）专用的两个量 —— **都按实测的窗口长度来定**。
  //
  // 2026-10-10 实测：连续做真转存（用已转存过的链接，只返回"已转存"、不新增文件）撞出窗口后，
  // 每 15 秒探一次分享页，**窗口持续约 442~457 秒（≈7.5 分钟）**才恢复。
  // 之前的 45 秒冷却 / 150 秒重试等于没起作用：冷却完还在窗口里，下一批继续废；
  // 重试也落在窗口内，几乎必然再失败。现在两个都取 8 分钟（比实测略宽）。
  //
  // 代价要讲清楚：这意味着"每撞一次窗口，整批要停 8 分钟"。单 IP 下这是硬成本 ——
  // 想快只能分摊 IP（给账号配代理），没有别的办法。
  const SHARE_LIMIT_COOLDOWN_MS = 8 * 60 * 1000;
  const RETRY_COOLDOWN_MS = 8 * 60 * 1000;
  let rateLimitedCount = 0;      // 本批因限流被推迟的条数（日志用）。注意与 share.shareLimited（布尔：是否撞每日分享上限）不是一回事
  let lastShareLimitPauseAt = 0;   // 上次因限流暂停的时刻（避免每条失败都触发一次暂停，把整批拖成慢动作）
  let shareLimitPauses = 0;        // 本批一共停了几次（用于结尾给个"这批花了多久在等"的账）
  const qaRows = [];

  // 每条完整链（独立 Jar 会话，并发安全）；窗口按轮换粒度切换
  // 【并发修复】游标与名额必须跨 worker 共享：此前每个 worker 各持 cursor=0，
  // 默认 4 并发会把同一批资源重复处理 4 遍（表格出现重复行的根因）
  let envCursor = 0;
  // 每个账号一份「已建目录」缓存：转存根 / 账号 / 资源表 这三层每条都一样，
  // 以前每条都重跑 3 个建目录请求 —— 那是**写请求**，正是限流的触发点。缓存后每条只建自己那层。
  const createdByEnv = new Map();
  const createdOf = (env) => {
    if (!createdByEnv.has(env)) createdByEnv.set(env, new Set());
    return createdByEnv.get(env);
  };
  // 注意：这里原来有个 `pickEnv()`（全局游标轮换取账号），已由模块级 `nextUsableEnv`
  // 取代 —— 后者 additionally 会跳过网盘已满的账号（容量不足不再整批停，见 decideCapacityOutcome）。
  /**
   * 并行时的账号绑定：第 slot 号线程永远用第 slot 号账号。
   * 因为线程数被限制为 ≤ 账号数，`slot % creds.length` 是一个**双射** ——
   * 任何时刻都不可能出现"两个线程拿着同一个账号"，这正是以前并发失败的根因。
   */
  function pickEnvForSlot(slot) { return creds[slot % creds.length]; }
  let sharedCursor = 0;
  let reservedCount = 0;
  // 「限流」重试轮：分享页取不到数据的条目，先在主轮里记下来，等整批跑完**再试一遍**。
  // 依据是真机实测 —— 同一批里失败的链接，隔几分钟重跑同样的流程一次就成功；
  // 而当场连试三次（2s/6s/12s）全撞在限流窗口里，等于白试。所以是"换个时间点重试"，不是"多试几次"。
  let phase = "main";
  const retryQueue = [];
  function nextIndex() {
    if (phase === "retry") {
      // 重试轮从队列取（队列空 = 这一轮结束）。注意重试轮里失败**不再回队**，否则会无限循环。
      const next = retryQueue.shift();
      return next === undefined ? null : next;
    }
    if (limit > 0 && reservedCount >= limit) return null;
    const i = startIdx + sharedCursor;
    if (i >= rows.length) return null;
    sharedCursor += 1;
    reservedCount += 1;
    return i;
  }
  async function worker(slot = 0) {
    let myCount = 0;
    while (!fatalStop && !ctx.shouldStop()) {
      // 全局暂停：任何 worker 触发风控，其它 worker 也在这里一起等
      if (pausedUntil > Date.now()) {
        await sleep(Math.min(pausedUntil - Date.now(), 60 * 1000));
        continue;
      }
      // 并行时：**线程与账号一一绑定**（见 pickEnvForSlot），不走下面的轮换；
      // 单线程时沿用原来的"每 perEnv 条换一个账号"，把资源摊到各个网盘上。
      let cred;
      if (cc > 1 && phase === "main") {
        cred = pickEnvForSlot(slot);
      } else {
        if (myCount > 0 && myCount % perEnv === 0) { envCursor += 1; myCount = 0; } // 轮换下一窗口
        // 跳过网盘已满的账号（满一个不等于整批废掉，剩下的账号接着转）
        cred = nextUsableEnv(creds, exhaustedEnvs, envCursor);
        if (!cred) {
          // 走到这里说明所有账号都满了（decideCapacityOutcome 会先置 fatalStop，这里是双保险）
          log("⛔ 所有转存账号的网盘空间都不足，本批到此为止（已完成部分完好，可清理空间或换号后续跑）。");
          fatalStop = true;
          return;
        }
        // 把游标推到**实际选中**的账号上：否则账号1 满后游标一直指着 1，
        // 轮换时会连续两轮都解析到账号2、账号3 只轮到一次 —— 空间用得不均衡。
        envCursor = creds.indexOf(cred);
      }
      const i = nextIndex();
      if (i === null) return;
      myCount += 1;
      await ctx.pausePoint?.("批量转存·条间检查点");
      const rawName = String(rows[i][nameKey] || "").trim();
      const { link, pwd: cellPwd } = parseLinkCell(String(rows[i][linkKey] || "") + (pwdKey ? ` 提取码:${rows[i][pwdKey]}` : ""));
      const srcLink = link + (link.includes("pwd=") ? "" : `?pwd=${cellPwd}`);
      if (!link || !cellPwd) { log(`⏭ 行 ${i + 1} 缺链接或提取码，跳过`); continue; }

      const prev = state.get(srcLink);
      if (prev && prev.status === "done" && prev.ownLink) { if (prev.qaRow) qaRows.push(prev.qaRow); continue; }
      if (prev && (prev.attempts || 0) >= 3) continue;
      // 上次「转存成了、分享没建成」→ 直接补分享，**不再转存**（文件早就在网盘里了）。
      // 以前缺这一步：每一轮都重新转存一遍（必然撞 errno=4 复用），纯属自伤。
      const retry = planShareRetry(prev);
      if (retry.action === "skip") {
        log(`⏭ ${rawName.slice(0, 26)} → ${retry.reason}，已跳过（不再转存也不再建分享）`);
        continue;
      }

      const meta = qaLib.parseName(rawName);
      const title = qaLib.buildTitle(meta, i);
      const itemBase = { title, name: rawName.slice(0, 30), bitEnv: cred.env };
      // 预检去重：规范化名已存在（历史或本轮）→ 不再转存
      const preKey = qaLib.normalizeName(rawName);
      if (preKey && preKey.length >= 2 && seenKeys.has(preKey)) {
        log(`⏭ 跳过重复（${preKey}）：${rawName.slice(0, 24)}`);
        continue;
      }

      try {
        const idx = String(i + 1).padStart(5, "0");
        // 目标目录 = 「转存根/账号/资源表」这一层，**子文件夹名交给 processOne 用分享里的真实名字**
        //（分享页的 mset 里本来就有 file_list，转存前就知道叫什么）。
        // 以前的写法是 `序号_表里的问题标题`，于是网盘里看到的是一串编号 + 问题标题，
        // 而不是"这条资源其实是什么"。现在零额外请求就拿到了真实名字。
        const destParent = `${destRoot}/${cred.env}/${baseName}`;
        // 该账号配了代理就带着走：网盘域和知道域用同一条出口（不然转存走本机、
        // 上传走代理，等于同一批操作从两个 IP 发出，反而更可疑）。
        const dispatcher = typeof deps.proxyOf === "function" ? deps.proxyOf(cred.env) : undefined;
        const jar = new Jar(cred.bduss, cred.stoken, dispatcher);
        let toPaths;
        if (retry.action === "share-only") {
          // 文件上次就转存成功了，台账里有落盘路径 —— 一步都不必再碰转存接口，
          // 直接拿历史路径去补建分享（否则每一轮都要多打一次 /share/transfer 并撞 errno=4）。
          toPaths = retry.toPaths;
          log(`🔁 ${rawName.slice(0, 26)} 上次已转存、只是分享没建成 → 直接补分享（第 ${retry.shareAttempts + 1} 次）`);
        } else {
          const oneResult = await processOne(jar, {
            link: srcLink, pwd: cellPwd, destParent, fallbackName: idx, createdDirs: createdOf(cred.env),
          });
          // 大文件异步转存中：百度收下了但还没给落盘路径（show_msg=文件转存中）。
          // **不能当失败**：文件确实在转，把它记成 failed 会虚报失败数、还可能进黑名单，
          // 而且下次运行会重新发起一次转存（可能造成重复文件）。按"待确认"记档，下次来看。
          if (oneResult.pending) {
            const pendingEntry = { srcLink, name: rawName, status: "pending", attempts: ((prev && prev.attempts) || 0) + 1, error: "百度在异步转存中（大文件），本次拿不到落盘路径", at: new Date().toISOString() };
            state.set(srcLink, pendingEntry);
            saveState(pendingEntry);
            log(`⏳ ${rawName.slice(0, 26)} → 百度在**异步转存中**（大文件），本次不算失败也不算完成；下次运行会再来确认。`);
            ctx.emitItem({ ...itemBase, status: "转存中（大文件，待确认）" });
            continue;
          }
          toPaths = oneResult.toPaths;
        }

        // 建分享（可选）。**关键修正**：转存成功 ≠ 分享成功。
        // 百度限制单账号每日最多 300 个分享链接；超额后再建分享会被拒。
        // 以前 share 的失败被外层 catch 当成"整条失败"——于是已经落盘的文件被算作失败、
        // 下次又被重新转存（errno=4 重复）+ 再次建分享（继续被拒），形成"虚假失败"死循环。
        // 现在把 share 单独处理：转存成了就记「已转存（建分享失败）」，**不再重传、不再计失败**，
        // 但若判定是每日上限，则把该账号加入 shareBlocked，本批剩余项只转存不建分享，避免反复撞限。
        const share = await runShareStep({ makeShare, env: cred.env, bduss: cred.bduss, stoken: cred.stoken, toPaths, dispatcher, shareBlocked, sharesByEnv, warnedSoft, log });
        let ownLink = share.ownLink, ownPwd = share.ownPwd;
        if (share.shareFailed) {
          // 文件已在网盘，无需重传；但无分享链接则无法生成问答行。记 share_failed：
          // 既不算"失败"（不会触发连败熔断、不会被 3 次黑名单），也不重传。
          // shareAttempts/shareForbidden 让下一轮 planShareRetry 知道「还能不能再补一次」
          // （次数用尽或被百度永久禁止 → 直接 skip，不再转存也不再建分享）
          const sfEntry = { srcLink, name: rawName, status: "share_failed", phase: "done", toPaths, ownLink: "", ...shareRetryFields(retry, share), error: share.shareErrMsg.slice(0, 200), at: new Date().toISOString() };
          state.set(srcLink, sfEntry);
          saveState(sfEntry);
          done += 1;
          transferredNoShare += 1;
          const statusText = share.shareLimited
            ? "已转存（达每日分享上限，仅转存）"
            : share.shareForbidden
              ? "已转存（该资源禁止二次分享）"
              : "已转存（建分享失败）";
          ctx.emitItem({ ...itemBase, status: statusText });
          ctx.report({ done, total, status: "running" });
          log(`⚠️ [${done}/${total}] ${rawName.slice(0, 26)} 转存成功，但建分享失败${share.shareLimited ? "（每日上限）" : share.shareForbidden ? "（该资源被百度禁止二次分享，换号/等明天都没用）" : ""}：${share.shareErrMsg.slice(0, 120)}`);
          continue;
        }

        // 名称质量门槛（不合规跳过问答，资源保留）
        const landedBase = decodeURIComponent((toPaths[0] || "").split("/").pop() || "");
        // **资源名一律用网盘里落盘的真实文件名**，不用资源表里的那一列 ——
        // 表里那列常常是"求XX网盘资源"这种**问题标题**（搜资源时从知道答案抓来的），
        // 拿它当资源名，最后传到平台上的标题也是这个，用户看到的是一串问句而不是资源名。
        // 只有真的拿不到落盘名时才退回表里的名字。
        let displayName = landedBase || rawName || "资源";
        // 落盘真实文件名乱码 → 不进问答表（资源已转存，人工可在网盘处理）
        if (qaLib.isGarbledName(decodeURIComponent((toPaths[0] || "").split("/").pop() || ""))) {
          saveState({ srcLink, name: displayName, status: "done", phase: "done", toPaths, ownLink, note: "文件名乱码跳过问答", at: new Date().toISOString() });
          done += 1;
          ctx.emitItem({ ...itemBase, status: "已转存（文件名乱码，跳过问答）" });
          log(`⚠️ ${rawName.slice(0, 24)} 落盘文件名乱码，跳过问答`);
          continue;
        }
        if (qaLib.reject(displayName, ownLink)) {
          displayName = decodeURIComponent((toPaths[0] || "").split("/").pop() || "").replace(/\[([^\]]*)\]/g, "$1").trim();
          if (qaLib.reject(displayName, ownLink)) {
            saveState({ srcLink, name: rawName, status: "done", phase: "done", toPaths, ownLink, note: "名称不合规跳过问答", at: new Date().toISOString() });
            done += 1;
            ctx.emitItem({ ...itemBase, status: "已转存（名称不合规跳过问答）", ownLink });
            log(`⚠️ [${done}/${total}] ${rawName.slice(0, 24)} 名称不合规，已转存分享但不进问答表`);
            continue;
          }
        }
        const qaRow = {
          qid: "",
          问题标题: title,
          回答内容: qaLib.buildAnswerHtml(ownLink, qaLib.buildIntro(meta)),
        };
        const okEntry = { srcLink, name: rawName, status: "done", phase: "done", toPaths, ownLink, ownPwd, qaRow, at: new Date().toISOString() };
        state.set(srcLink, okEntry);
        const doneKey = qaLib.normalizeName(displayName);
        if (doneKey && doneKey.length >= 2) seenKeys.add(doneKey);
        saveState(okEntry);
        qaRows.push(qaRow);
        done += 1;
        consecutiveFails = 0;   // 成功一条，全局连败清零
        ctx.emitItem({ ...itemBase, status: "已转存分享", ownLink });
        ctx.report({ done, total, status: "running" });
        log(`✅ [${done}/${total}] ${rawName.slice(0, 26)} → ${ownLink}`);
      } catch (e) {
        if (e.risk) {
          // 取 max 而不是直接赋值：多个 worker 几乎同时撞上风控时，
          // 暂停窗口从"最后一次触发"起算，不会被前一个的旧值缩短。
          pausedUntil = Math.max(pausedUntil, Date.now() + 10 * 60 * 1000);
          log(`⏸ 触发行控（${(e.message || "").slice(0, 40)}），全部账号暂停到 ${new Date(pausedUntil).toLocaleTimeString("zh-CN", { hour12: false })}…`);
          continue;
        }

        // 分享页取不到数据 = 多半是我们打太快被限流（真机实测：同一条隔几分钟再跑同样的流程就成功）。
        // 它与普通失败**必须区别对待**：不当场计失败、不写 failed 状态、也不算进连败 ——
        // 那不是这个账号的错，而是节奏问题；硬记一笔既让失败数虚高，又会误触连败熔断。
        // 做法：记下来，整批跑完再重试一遍；同时**让所有线程一起停一下**，别继续往上撞。
        if (e.sharePageLimited && phase === "main") {
          retryQueue.push(i);
          rateLimitedCount += 1;
          if (Date.now() - lastShareLimitPauseAt > 90 * 1000) {
            lastShareLimitPauseAt = Date.now();
            shareLimitPauses += 1;
            pausedUntil = Math.max(pausedUntil, Date.now() + SHARE_LIMIT_COOLDOWN_MS);
            log(`⏳ 分享页被限流（本批已遇到 ${rateLimitedCount} 条），全部线程暂停 ${Math.round(SHARE_LIMIT_COOLDOWN_MS / 60000)} 分钟；`
              + `这几条已记下，整批跑完会再重试一遍 —— 不是链接坏了，是我们打太快。`
              + `（实测这个窗口要 ${Math.round(SHARE_LIMIT_COOLDOWN_MS / 60000)} 分钟才恢复，等不到就直接白跑）`);
          }
          continue;
        }

        failed += 1;
        consecutiveFails += 1;
        const attempts = ((prev && prev.attempts) || 0) + 1;
        // 截断长度要**给证据留地方**：上一轮我特意把百度返回的原始响应塞进错误信息里，
        // 结果日志行只留 70 字、存档只留 120 字，正好把那段证据砍掉 ——
        // 于是《琉璃》连续三轮失败，我每次都看不到原因，只能靠这次单独去挖。
        const failEntry = { srcLink, name: rawName, status: "failed", attempts, error: (e.message || "").slice(0, 400), at: new Date().toISOString() };
        state.set(srcLink, failEntry);
        saveState(failEntry);
        ctx.emitItem({ ...itemBase, status: `转存失败：${(e.message || "").slice(0, 60)}` });
        log(`✗ ${rawName.slice(0, 26)} → ${e.message.slice(0, 240)}`);
        if (e.fatal) {
          // 容量不足：**只废这个账号，不废整批**（参考实现的结论：应换账号继续）。
          // 全部账号都满时才真正停；并行时本线程绑定的账号满了，本线程退出
          // （不能去抢别的账号 —— 线程≤账号数是避免同 IP 并发的硬前提）。
          const outcome = decideCapacityOutcome({ creds, exhaustedEnvs, env: cred.env, cc });
          exhaustedEnvs.add(cred.env);
          if (outcome.stopAll) {
            log("⛔ 所有转存账号的网盘空间都不足，停止本次任务（已完成部分完好，可清理空间或换号后续跑）。");
            fatalStop = true;
          } else {
            log(`⛔ ${cred.env} 网盘已满，本批**跳过该账号**，其余 ${outcome.restEnvs.length} 个账号继续转（${outcome.restEnvs.join("、")}）。`
              + `这一条已记失败，下次运行会重试。`);
          }
          if (outcome.exitWorker) break;
          continue;
        }
        if (consecutiveFails >= FAIL_STREAK_LIMIT) {
          log(`⚠️ 连续 ${consecutiveFails} 条失败，整条管线停止（断点已存档）。`);
          fatalStop = true;   // 让**所有** worker 都停，而不是只停当前这个
          break;
        }
      }
      await sleep((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cc, total || 1) }, (_, slot) => worker(slot)));

  // ── 限流条目的延后重试轮 ──
  // 只在主轮跑完之后做，而且**先把整批的并发降下来**（1 个线程串行重试）：
  // 重试的目的是"换个时间点再试"，不是"再冲一次" —— 并发重试等于把刚过去的限流窗口又打一遍。
  if (retryQueue.length && !fatalStop && !ctx.shouldStop()) {
    const waiting = retryQueue.length;
    log(`⏳ 有 ${waiting} 条因限流被推迟，等 ${Math.round(RETRY_COOLDOWN_MS / 60000)} 分钟后**串行重试一遍**（不是链接问题，是节奏问题）…`);
    await sleep(RETRY_COOLDOWN_MS);
    if (!ctx.shouldStop()) {
      phase = "retry";
      await Promise.all([worker()]);
      const stillQueued = retryQueue.length;
      log(`重试轮结束：救回 ${waiting - stillQueued} 条${stillQueued ? `，仍有 ${stillQueued} 条没成功（它们已按普通失败记档，下次运行会再试）` : ""}`);
      // 重试失败的会走普通失败分支（计失败 + 写 state），但那时仍处于 retry 阶段、
      // 不会回队；这里再把残留清空，保证不会有人误用这个队列。
      retryQueue.length = 0;
    }
  }

  ctx.report({ done, total, status: (fatalStop || ctx.shouldStop()) ? "stopped" : "done" });

  // 导出上传专用表
  fs.mkdirSync(outDir, { recursive: true });
  let outputPath = "";
  if (qaRows.length) {
    outputPath = path.join(outDir, `${outName}.xlsx`);
    const excel = require("../storage/excel");
    const ws = XLSX.utils.json_to_sheet(qaRows, { header: ["qid", "问题标题", "回答内容"] });
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, "百度知道问答");
    const used = excel.writeWorkbookSafe(outputPath, qaRows, "百度知道问答", ["qid", "问题标题", "回答内容"], log);
    if (used !== outputPath) outputPath = used; // 表格被占用时自动备份
  }
  const totalOk = [...state.values()].filter((s) => s.status === "done").length;
  log(`=== 批量转存完成 === 本轮转存成功 ${done}（其中分享未建成 ${transferredNoShare}）| 失败 ${failed} | 历史累计 ${totalOk}`);
  if (transferredNoShare) {
    const blockedList = shareBlocked.size ? `（${[...shareBlocked].join("、")} 撞上每日 300 上限）` : "";
    log(`（有 ${transferredNoShare} 条资源已转存进网盘但没建成分享链接${blockedList}—— 这些不会进上传专用表，`
      + `可在网盘内手动生成分享，或次日额度恢复后再跑一次补足）`);
  }
  if (shareLimitPauses) {
    // 把"这批到底花了多少时间在等"摆出来 —— 长跑时用户看到进度慢，得知道慢在哪。
    log(`（本批因限流暂停 ${shareLimitPauses} 次，合计等待约 ${shareLimitPauses * Math.round(SHARE_LIMIT_COOLDOWN_MS / 60000)} 分钟；`
      + `单 IP 下这是硬成本，想快只能给账号配代理分摊出口 IP）`);
  }
  if (outputPath) log(`上传专用表已生成：${outputPath}（${qaRows.length} 条，可在 Excel 修改后直接上传）`);
  return { count: done, failed, totalOk, outputPath, shareFailures: transferredNoShare };
}

// isGenericName 一并导出：scripts/pan-transfer-batch.js 里有同一段逻辑的拷贝，
// 而它**只 import 了本文件以外的模块、却直接用这个名字** —— 跑到那里就 ReferenceError。
// 与其让脚本再抄一份，不如从这里引（契约⑥ 扫出来的）。
module.exports = { runBatchTransferTask, isGenericName, parseEnvList, parseEnvListDetailed, resolveTransferParallelism, MAX_TRANSFER_PARALLELISM, runShareStep, nextUsableEnv, decideCapacityOutcome };
