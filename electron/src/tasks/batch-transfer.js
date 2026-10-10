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
const { createShare } = require("../netdisk/share");
const { Jar, processOne } = require("../netdisk/protocol");
const qaLib = require("../netdisk/qa-template-lib");
const { credentialHint } = require("../netdisk/manager");
const { envLabelsOf } = require("../domain/account-topic");


// 打包后 __dirname 在 asar 内且安装目录不可写：数据一律放用户数据目录（%AppData%\zhidao-answer-studio）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function parseLinkCell(text) {
  const s = String(text || "");
  const link = (s.match(/https?:\/\/pan\.baidu\.com\/s\/[\w-]+(?:\?pwd=[a-z0-9]{4})?/i) || [])[0] || "";
  let pwd = (s.match(/[?&]pwd=([a-z0-9]{4})/i) || [])[1] || "";
  if (!pwd) pwd = (s.match(/(?:提取码|密码|访问码)[:：\s]*([a-z0-9]{4})/i) || [])[1] || "";
  return { link, pwd };
}
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

function randomPwd() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

/**
 * 把 payload 里的环境名解析成干净的字符串数组。
 *
 * 以前这里是 `Array.isArray(x) ? x : String(x).split(",")` —— 既不 trim、也不认 `{label}` 写法。
 * 于是 `"账号1, 账号2"`（逗号后带空格，用户手写时很常见）会得到名字 `" 账号2"`：
 * 取不到已存的 Cookie、也匹配不上比特环境（比特那边要求名字一字不差），
 * 最后报出来的是「没有任何窗口具备 pan.baidu.com 登录态」—— 完全看不出真凶是一个空格。
 * 现在统一交给 `envLabelsOf`（trim + 剔空 + 取出 label），与其它任务同一套规则。
 */
function parseEnvList(payload) {
  const p = payload || {};
  const raw = (p.bitEnvs !== undefined && p.bitEnvs !== null && p.bitEnvs !== "") ? p.bitEnvs : p.bitEnv;
  if (Array.isArray(raw)) return envLabelsOf(raw);
  return envLabelsOf(String(raw || "").replace(/[，\r\n]/g, ",").split(","));
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
  const envList = parseEnvList(payload);
  if (!envList.length) throw new Error("请填写至少一个比特环境名（多账号每行一个）");
  const perEnv = Math.max(1, Number(payload.perEnv) || 50); // 每窗口连续处理条数（轮换粒度）
  const destRoot = String(payload.destDir || "/来自资源批量转存").trim() || "/来自资源批量转存";
  const limit = Math.max(0, Number(payload.limit) || 0);
  // 默认并发从 4 改成 1。依据是 2026-10-10 的真机对照实验（同一批链接、同一账号、同一套请求）：
  //   串行 cc=1  → 28 个请求 0 失败
  //   并发 cc=2  → 9/9 失败
  //   并发 cc=4  → 4/9 失败
  // 也就是说"分享页取不到数据"**不是链接坏、不是格式问题、也不是账号被封**，
  // 而是**同一个出口 IP 短时间内的并发请求数**触发的降级窗口（两个账号共用 IP 时会出现
  // "账号1 失败、账号2 正常"的交替现象，正因为谁的请求落在窗口里谁中招）。
  // 并发换来的速度，抵不过失败后要等几分钟重试的代价 —— 所以保守取 1；
  // 想快就自己调大（--cc / payload.cc），但要知道失败率会跟着上去。
  const cc = Math.max(1, Number(payload.cc) || 1);
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
    const wb = XLSX.readFile(filePath);
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  }
  if (!rows.length) throw new Error("资源表为空");
  const keys = Object.keys(rows[0]);
  const nameKey = keys.find((k) => /文件名|名称|标题|资源/.test(k)) || keys.find((k) => !/链接|网址|url/i.test(k)) || keys[0];
  const linkKey = keys.find((k) => /链接|网址|url/i.test(k)) || keys.find((k) => /pan\.baidu\.com/.test(String(rows[0][k] || ""))) || keys[1];
  const pwdKey = keys.find((k) => /提取码|密码|访问码/.test(k)) || "";
  log(`资源表 ${rows.length} 行 | 名称列="${nameKey}" 链接列="${linkKey}"`);

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
  const state = new Map();
  try {
    for (const line of fs.readFileSync(stateFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); state.set(r.srcLink, r); } catch { /* 跳过 */ }
    }
  } catch { /* 首次 */ }
  const saveState = (e) => { fs.mkdirSync(workDir, { recursive: true }); fs.appendFileSync(stateFile, JSON.stringify(e) + "\n"); };

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
  log(`开始纯协议批量转存：目标 ${total} 条 | 并发 ${cc} | 目标目录 ${destRoot}`);
  if (cc > 1) {
    // 把实测数字直接摆出来：用户调大并发时该知道代价，而不是等失败了再来问。
    log(`⚠️ 转存并发 ${cc}：真机对照实验里，并发 2 时「分享页取不到数据」的失败率是 100%、并发 4 是 44%，`
      + `而串行（并发 1）跑 28 个请求零失败 —— 这是**同一出口 IP 的短时并发**触发的降级，不是链接坏。`
      + `失败的那几条会在整批跑完后自动重试一遍，但会明显变慢。想稳就把并发调回 1。`);
  }
  ctx.report({ done: 0, total, status: "running" });

  let done = 0, failed = 0, fatalStop = false;
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
  let shareLimited = 0;            // 本批因限流被推迟的条数（日志用）
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
  function pickEnv() { return creds[envCursor % creds.length]; }
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
  async function worker() {
    let myCount = 0;
    while (!fatalStop && !ctx.shouldStop()) {
      // 全局暂停：任何 worker 触发风控，其它 worker 也在这里一起等
      if (pausedUntil > Date.now()) {
        await sleep(Math.min(pausedUntil - Date.now(), 60 * 1000));
        continue;
      }
      if (myCount > 0 && myCount % perEnv === 0) { envCursor += 1; myCount = 0; } // 轮换下一窗口
      const cred = pickEnv();
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
        const { toPaths } = oneResult;

        let ownLink = "", ownPwd = "";
        if (makeShare) {
          const ownPwdR = randomPwd();
          // 创建分享也带上同一条代理：以前这里漏了，于是"转存走代理、建分享走直连"，
          // 同一批操作从两个 IP 发出 —— 正好是上面那句注释想避免的情况。
          const share = await createShare({ bduss: cred.bduss, stoken: cred.stoken, paths: toPaths, password: ownPwdR, dispatcher });
          if (!share.link) throw new Error("创建分享失败");
          ownLink = `${share.link}?pwd=${share.password}`;
          ownPwd = share.password;
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
          shareLimited += 1;
          if (Date.now() - lastShareLimitPauseAt > 90 * 1000) {
            lastShareLimitPauseAt = Date.now();
            shareLimitPauses += 1;
            pausedUntil = Math.max(pausedUntil, Date.now() + SHARE_LIMIT_COOLDOWN_MS);
            log(`⏳ 分享页被限流（本批已遇到 ${shareLimited} 条），全部线程暂停 ${Math.round(SHARE_LIMIT_COOLDOWN_MS / 60000)} 分钟；`
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
        if (e.fatal) { log("⛔ 容量不足，停止本次任务（已完成部分完好）。"); fatalStop = true; break; }
        if (consecutiveFails >= FAIL_STREAK_LIMIT) {
          log(`⚠️ 连续 ${consecutiveFails} 条失败，整条管线停止（断点已存档）。`);
          fatalStop = true;   // 让**所有** worker 都停，而不是只停当前这个
          break;
        }
      }
      await sleep((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cc, total || 1) }, () => worker()));

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
  log(`=== 批量转存完成 === 本轮成功 ${done} | 失败 ${failed} | 历史累计 ${totalOk}`);
  if (shareLimitPauses) {
    // 把"这批到底花了多少时间在等"摆出来 —— 长跑时用户看到进度慢，得知道慢在哪。
    log(`（本批因限流暂停 ${shareLimitPauses} 次，合计等待约 ${shareLimitPauses * Math.round(SHARE_LIMIT_COOLDOWN_MS / 60000)} 分钟；`
      + `单 IP 下这是硬成本，想快只能给账号配代理分摊出口 IP）`);
  }
  if (outputPath) log(`上传专用表已生成：${outputPath}（${qaRows.length} 条，可在 Excel 修改后直接上传）`);
  return { count: done, failed, totalOk, outputPath };
}

// isGenericName 一并导出：scripts/pan-transfer-batch.js 里有同一段逻辑的拷贝，
// 而它**只 import 了本文件以外的模块、却直接用这个名字** —— 跑到那里就 ReferenceError。
// 与其让脚本再抄一份，不如从这里引（契约⑥ 扫出来的）。
module.exports = { runBatchTransferTask, isGenericName, parseEnvList };
