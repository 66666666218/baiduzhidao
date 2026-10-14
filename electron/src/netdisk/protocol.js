"use strict";

/**
 * 百度网盘转存协议客户端（纯 HTTP · 无浏览器）。
 * Jar = 每条资源独立 Cookie 会话；processOne = 单条完整链（verify→mset→建目录→转存）。
 * 参考实现：本机 C:\Users\周万鹏\wangpan（backend/app/providers/baidu/provider.py，
 * 多网盘批量转存项目；其 CHANGELOG 记录了百度侧 errno=115 禁止二次分享、
 * errno=4 按 target_dir+文件名 拼路径等实测结论）+ 本项目 2026-09-23 实测（38条/分钟）。
 * 注意：该参考项目在 Gitee 上的地址（qingchuangjy/wangpan）已不可访问（账号不存在），
 * 要看源码请用本机这份副本。
 *
 * 所有请求都走 `panFetch`（UA/Cookie/代理/超时/set-cookie 回写只有这一处定义）。
 * 别在这份文件里直接写 `fetch(` —— 漏掉代理就会出现"同一批操作从两个 IP 发出"，
 * 漏掉超时就会让整条链在网络上永久吊住。有静态守卫盯着这件事。
 */

const PAN = "https://pan.baidu.com";
// 「一次 /share/transfer 响应意味着什么」的唯一实现：info 提升 / errno=4 已转存 /
// 容量不足 / errno=2 路径不存在 / 异步转存中。三处调用方（本文件、transfer.js、
// scripts/pan-transfer-ui.js）共用它，别再各写一份判断。
const { normalizeTransferBody, DUP_ERRNO } = require("./transfer-outcome");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 网盘单次 API 调用的超时。以前这里**一个超时都没有** —— 网络卡住时整条链就永久吊在那儿，
// 外层只能看到"任务不动了"，日志里连一条错都没有，排查时完全找不到方向。
const TIMEOUT_MS = 20000;

/**
 * 显式 0 字节的**文件** = 占位垃圾（文件夹的 size 也是 0，不能误伤，所以必须先判 isdir）。
 * 放在模块级是因为它同时被 `collect`（慢路径）和 `planFastPath`（快路径）用到 —— 只许一份。
 */
const isZeroSizePlaceholder = (f) => Number(f.isdir) !== 1
  && f.size !== undefined && f.size !== null && f.size !== ""
  && Number(f.size) === 0;

/**
 * 「这条分享能不能走快路径」—— **纯函数**，判据写在这里而不是写在 processOne 的条件里。
 *
 * 为什么非得提出来（2026-10-14 当场撞到的教训）：判据一开始是写在 `processOne` 里的一行
 * `if (...)`。守卫只能扫文本，于是"把闸门去掉"这个突变竟然**测试全绿** —— 因为被删掉的
 * `hasDirAtRoot` 这个名字在文件里还有别的出现处，扫文本看不出来。也就是说那条守卫守的是
 * **接线**（这个变量还在不在），不是**逻辑**（这条闸门还在不在）。
 * 项目里已经为同一件事吃过一次亏（见 CHANGELOG 第 16-E 轮），所以按老规矩办：
 * 规则提到纯函数里，让测试能**真的调用**它、喂进两种分享形状看结果。
 *
 * 三条判据（缺一条都不许启用）：
 *   ① `entries` 非空且**没取满一页**（取满 = 可能被截断，宁可慢也不能静默漏文件）；
 *   ② 根目录里**真的有文件夹** —— 没有文件夹的分享，老路径本来就一次 /share/list 都不打，
 *      省不到的场合必须保持老行为逐字节不变（实测表尾那批小说分享就是这种形状）；
 *   ③ 不是诊断模式的强制慢路径（`dryRun === "slow"`，只给测速探针做对照用）。
 *
 * @returns {{enabled:boolean, hasDirAtRoot:boolean, complete:boolean, ids:number[], paths:string[]}}
 */
function planFastPath({ entries, dryRun } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const hasDirAtRoot = list.some((f) => f && Number(f.isdir) === 1);
  const complete = list.length > 0 && list.length < FILE_LIST_PAGE_CAP;
  const allowed = dryRun !== "slow" && complete && hasDirAtRoot;
  const usable = allowed ? list.filter((f) => f && f.fs_id && !isZeroSizePlaceholder(f)) : [];
  return {
    enabled: usable.length > 0,
    hasDirAtRoot,
    complete,
    ids: usable.map((f) => Number(f.fs_id)),
    // 相对路径仍从分享页条目里取：errno=4（已转存）时百度偶发不给 duplicated.list，
    // 那时要靠「目标目录 + 分享内相对路径」拼出落盘路径（见 processOne 的 outcome.dup 分支）。
    paths: allowed ? list.map((f) => String((f && f.path) || "")).filter(Boolean) : [],
  };
}

/**
 * 每一阶段各花了多少毫秒 —— **这是"为什么这么慢"唯一的可信来源**。
 *
 * 为什么必须由程序自己量（2026-10-14）：
 * 用户问「为什么一条要 9 秒、不能一秒几十个」。我最初写了个测速脚本（scripts/probe-transfer-speed.js），
 * 但它有三个先天缺陷：① 要在**别人正在跑批**的账号上抢请求，本身就会把限流窗口打出来
 * （实测：表头那批链接在探针下全部拿到 ~50KB 无 mset 的页面，而同一时刻正在跑批的任务是好的）；
 * ② 只能量到**只读**那几步（verify / 分享页 / 列目录），而最可疑的建目录、转存、建分享全是**写**请求，
 *    探针一碰就污染用户网盘；③ 它挑的链接形状和被跑批的完全可能不是一回事（实测表尾是"单文件分享"，
 *    表头是"文件夹分享"，两种形状的耗时差得远）。
 * 所以：**让生产路径自己把每一步的耗时带回来**，每 25 条在日志里报一次平均值与占比。
 * 下一次真跑批之后，日志里就有答案，不用再猜、也不用再拿用户的额度去做实验。
 */
function phaseMarks() {
  const t = { start: Date.now(), afterVerify: 0, afterPage: 0, afterList: 0, afterCreate: 0, afterTransfer: 0 };
  return t;
}
/** 把 5 段标记折成 {verify,page,list,create,transfer}（单位毫秒） */
function phaseDurations(t) {
  return {
    verify: (t.afterVerify || t.start) - t.start,
    page: (t.afterPage || t.afterVerify) - t.afterVerify,
    list: (t.afterList || t.afterPage) - t.afterPage,
    create: (t.afterCreate || t.afterList) - t.afterList,
    transfer: (t.afterTransfer || t.afterCreate) - t.afterCreate,
  };
}

/**
 * 网盘侧统一的 fetch。三件事以前散在 7 个调用点，漏一个就出问题：
 *   1) **UA / Cookie**：漏了会被当成未登录或机器人；
 *   2) **dispatcher（代理）**：漏了这一条请求就走直连 —— 同一批操作从两个 IP 发出，
 *      比全程直连更可疑（实测时就漏了两处）；
 *   3) **超时**：见上。
 * 顺带统一了 set-cookie 回写：以前每个调用点都要自己 `jar.apply(...)`，漏了 Cookie 就丢了。
 */
async function panFetch(jar, url, { referer, ...init } = {}) {
  const resp = await fetch(url, {
    redirect: "follow",
    ...init,
    headers: {
      "User-Agent": UA,
      Cookie: jar.str(),
      ...(referer ? { Referer: referer } : {}),
      ...(init.headers || {}),
    },
    dispatcher: jar.dispatcher,
    signal: init.signal || (AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined),
  });
  jar.apply(resp.headers.getSetCookie ? resp.headers.getSetCookie() : []);
  return resp;
}

class Jar {
  /**
   * @param dispatcher 可选：该账号的代理（undici Agent）。挂在 Jar 上而不是模块级变量，
   *   因为并发 cc>1 时每个 worker 有自己的 Jar —— 用模块级变量会让几条资源串用同一条代理。
   */
  constructor(bduss, stoken, dispatcher) {
    this.map = new Map([["BDUSS", bduss]]);
    if (stoken) this.map.set("STOKEN", stoken);
    this.dispatcher = dispatcher;
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

/**
 * 把 Jar 包成一个「只给相对路径」的小客户端（自带 UA/Cookie/代理/超时，见 panFetch）。
 * 导出它是为了让 CLI 脚本（scripts/pan-transfer-batch.js 的 quota 查询）也能用 ——
 * 那些脚本以前各自抄了一份 makeClient，抄的那份**没有 dispatcher、没有超时**。
 */
function makeClient(jar) {
  return async (pathAndQuery, opts = {}) => {
    const resp = await panFetch(jar, `${PAN}${pathAndQuery}`, {
      method: opts.method || "GET",
      referer: opts.referer || `${PAN}/disk/main`,
      headers: opts.headers,
      body: opts.body,
    });
    return resp.json().catch(() => ({}));
  };
}

/**
 * 从分享页的 mset 里取「这条资源叫什么」—— 用**真实文件/文件夹名**，不要用资源表里的名字。
 *
 * 关键：这一步发生在**转存之前**（分享页里本来就有 file_list），所以可以拿真实名字去命名
 * 目标文件夹 —— 既不用转存完再改名（那要多一次写请求，而写请求正是限流的触发点），
 * 也不会出现"序号_表里的问题标题"这种名字。
 */
function nameFromShare(data) {
  const list = Array.isArray(data && data.file_list) ? data.file_list : [];
  const seg = (p) => String(p || "").split("/").filter(Boolean).pop() || "";
  // 优先用第一个**文件**的名字；全是文件夹时退回第一个文件夹的名字。
  const file = list.find((x) => x && Number(x.isdir) !== 1 && (x.server_filename || x.path));
  const dir = list.find((x) => x && Number(x.isdir) === 1 && (x.server_filename || x.path));
  const picked = file || dir;
  const raw = String((picked && (picked.server_filename || seg(picked.path))) || "").trim();
  // 去掉文件名里的非法字符并限长（百度侧目录名上限远大于此，60 字足够辨识）
  return raw.replace(/[\/:*?"<>|\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

// ---------- 单条完整链（纯协议） ----------
/** /share/list 一页取多少条（实测多看不少时间），以及最多翻几页（防异常分享把循环拖死） */
const SHARE_LIST_PAGE = 1000;
const SHARE_LIST_MAX_PAGES = 50;
/**
 * 「快路径」的判据常量：分享页 `file_list` 的一页上限（经验值 100）。
 *
 * 为什么需要它：**取满一页 = 可能被截断**。这时绝对不许走快路径 —— 否则会变成
 * "只转存了前 100 个，这一条还记成成功"，正是最难被发现的部分成功（同一族问题
 * 刚在 /share/list 上修过一次，见 listDir 的注释）。取不满（< 100）才认为它列全了根目录。
 */
const FILE_LIST_PAGE_CAP = 100;

async function processOne(jar, { link, pwd, rawName, idx, destDir, destParent, fallbackName, createdDirs, bduss, stoken, makeShare, dryRun }) {
  const tMark = phaseMarks();   // 每一步各花多久（见 phaseMarks 的注释：这是"为什么慢"的唯一可信来源）
  const m = String(link || "").match(/\/s\/(1[\w-]+)/);
  if (!m) throw new Error(`不认识的分享链接，已跳过：${link}`);
  const fullCode = m[1];
  const surl = fullCode.startsWith("1") ? fullCode.slice(1) : fullCode;
  const rawUrl = `${PAN}/s/${fullCode}?pwd=${pwd}`;

  // 1) verify
  const vResp = await panFetch(jar, `${PAN}/share/verify?surl=${encodeURIComponent(surl)}&t=${Date.now()}&channel=chunlei&web=1&bdstoken=null&clienttype=0`, {
    method: "POST",
    referer: `${PAN}/share/init?surl=${encodeURIComponent(surl)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `pwd=${pwd}&vcode=&vcode_str=`,
  });
  const vBody = await vResp.json().catch(() => ({}));
  if (vBody.errno === -65 || vBody.errno === -62 || vBody.errno === -70) throw Object.assign(new Error(`verify风控 errno=${vBody.errno}`), { risk: true });
  // 提取码为空 + verify 被拒 → 几乎一定是"这条分享需要码而我们没有"。
  // 光报 `verify errno=xxx` 用户看不出该干什么；直接告诉他去哪补。
  if (vBody.errno !== 0 && !String(pwd || "").trim()) {
    throw new Error(`verify errno=${vBody.errno} —— 这条的「提取码」是空的，而分享需要提取码。`
      + "请回资源表把该行的提取码补上（或删掉这一行）再跑；已转存的不会重复。");
  }
  if (vBody.errno !== 0 || !vBody.randsk) throw new Error(`verify errno=${vBody.errno}`);
  tMark.afterVerify = Date.now();

  // 2) 分享页 → mset
  // 分享页偶发返回不含 mset 的响应（限流 / 半渲染）。一次拿不到就整条判死太脆：
  // 实测同一条链接、同一份 Cookie，第一次 fetch 解析为空、重试就能拿到。
  //
  // ⚠️ 退避**必须够长**。2026-10-10 真机跑批实测：10 条连着跑（并发 2、条间隔约 1 秒）时有 3 条
  // 卡在这里失败，响应 52KB 无 mset；而几分钟后对**同样的链接**走**完全相同的流程**，一次就拿到
  // 78KB 带 mset 的正常页面。也就是说链接是好的，是我们自己打太快被限流了 ——
  // 而原来的退避只有 1s / 2s，3 次全撞在限流窗口里，等于白重试。
  // 现在改成 2s / 6s / 12s 并加抖动（抖动是为了避免并发的那几条同时再撞上去）。
  const SHARE_RETRY_DELAYS = [2000, 6000, 12000];
  const SHARE_DATA_RE = /(?:yunData\.setData|locals\.mset)\(([\s\S]+?)\);/;
  let html = "";
  let data = null;
  let sharePageAttempts = 0;   // 这条实际打了几次分享页（dryRun 会把它带出来，见下面的诊断口）
  let listCalls = 0;           // 这条打了几次 /share/list（快路径应当为 0 —— 这是"提速了吗"的硬证据）
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    sharePageAttempts = attempt;
    const pResp = await panFetch(jar, `${PAN}/s/${fullCode}`);
    html = await pResp.text();
    const mm = html.match(SHARE_DATA_RE);
    if (mm) {
      try { data = JSON.parse(mm[1]); } catch { data = null; }
      if (data && Number(data.errno) === 0) break;
    }
    if (attempt < 3) await sleep(SHARE_RETRY_DELAYS[attempt - 1] + Math.random() * 1500);
  }
  if (!data) {
    const err = new Error(`分享页无数据（重试 3 次仍失败；响应 ${html.length} 字节）。`
      + "**先别急着当链接失效**：连续跑批时这一条多半是限流 —— 隔几分钟重跑同一条若能成功就是限流，"
      + "把「转存并发」调小、或加大条间间隔再试（已转存的会自动跳过）。"
      + "若隔多久都拿不到，才是分享被取消或链接本身失效。");
    // 打上标记：调用方（batch-transfer）据此做**自适应冷却**和**批次末尾延后重试** ——
    // 光有一句提示没用，得让它自己知道"这条值得待会儿再试一次"。
    err.sharePageLimited = true;
    throw err;
  }
  if (Number(data.errno) !== 0) throw new Error(`分享数据 errno=${data.errno}`);
  tMark.afterPage = Date.now();
  const uk = String(data.share_uk || data.uk || "");
  const shareid = String(data.shareid || "");
  const bdstoken = String(data.bdstoken || "");
  const rawList = Array.isArray(data.file_list) ? data.file_list : (data.file_list && data.file_list.list) || [];

  // 3) 收集要转存的 fs_id（默认走快路径；快路径不成立时才 BFS 完整枚举）
  let fsIds = [];
  let dirPaths = [];
  // 与 fsIds 平行收集**分享内的真实相对路径**（/子目录/文件.mp4）。
  // 用途：errno=4（全部重复转存）时百度偶发不返回 duplicated.list，
  // 但文件其实早就在网盘里 —— 落盘路径是可以直接推出来的（转存目标目录 + 这个相对路径）。
  // 参考实现（本机 wangpan baidu provider）在 duplicated 为空时同样按 target_dir+文件名 拼。
  let filePaths = [];
  let zeroSize = 0;
  const collect = (entries) => {
    for (const f of entries) {
      if (Number(f.isdir) === 1) dirPaths.push(f.path);
      else if (f.fs_id) {
        if (f.path) filePaths.push(String(f.path));
        if (isZeroSizePlaceholder(f)) { zeroSize += 1; continue; }  // 显式 0 字节=占位垃圾
        fsIds.push(Number(f.fs_id));                                 // 缺 size 字段按未知保留
      }
    }
  };
  /**
   * 取一次 /share/list（某一页）。
   *
   * num 从 100 提到 1000：2026-10-14 实测百度对 num **不敏感** —— 同一个分享
   * `num=100 / 1000 / 10000` 分别 1504 / 1802 / 1154 毫秒，换句话说"要多一点"是免费的。
   */
  const listDirOnce = async ({ dir = "", page = 1, root = false } = {}) => {
    listCalls += 1;   // 只用于诊断（dryRun），生产路径不看它
    const qs = new URLSearchParams({ web: "5", app_id: "250528", desc: "1", showempty: "0", page: String(page), num: String(SHARE_LIST_PAGE), order: "time", view_mode: "1", channel: "chunlei", clienttype: "0", shorturl: surl });
    if (root) qs.set("root", "1"); else qs.set("dir", dir);
    if (bdstoken) qs.set("bdstoken", bdstoken);
    return panFetch(jar, `${PAN}/share/list?${qs}`, { referer: rawUrl }).then((r) => r.json()).catch(() => ({}));
  };
  /**
   * 取一个目录的**全部**条目（自动翻页）。
   *
   * 为什么要翻页：以前写死 `page=1&num=100`，**既不翻页也不检查是否取满** ——
   * 分享里某个目录一旦超过 100 条，多出来的文件会被**静默漏掉**：不报错、这一条还记成"转存成功"，
   * 但网盘里少文件、问答行指向的资源也不完整。这种"部分成功"最难被发现，所以必须修。
   * 终止判据用"这一页取满了才继续下一页"，而不是相信 num 一定够大；`SHARE_LIST_MAX_PAGES`
   * 只是防止异常分享把循环拖死。
   */
  const listDir = async (dir) => {
    const all = [];
    let errno = 0;
    for (let page = 1; page <= SHARE_LIST_MAX_PAGES; page += 1) {
      const j = await listDirOnce({ dir, page });
      if (j.errno !== undefined) errno = j.errno;
      const list = Array.isArray(j.list) ? j.list : [];
      all.push(...list);
      if (list.length < SHARE_LIST_PAGE) break;
    }
    return { errno, list: all };
  };
  // BFS 递归展开全部子目录（上限 100 个目录，超限告警防异常分享）
  const walkDirs = async (seedDirs) => {
    const queue = seedDirs.slice();
    const seen = new Set(queue);
    let visited = 0;
    while (queue.length) {
      if (visited >= 100) { console.warn(`[protocol] 分享目录超过 100 个，已截断（${surl}）`); break; }
      const d = queue.shift();
      visited += 1;
      const j = await listDir(d);
      if (j.errno === 0 && Array.isArray(j.list)) {
        collect(j.list);
        for (const f of j.list) {
          if (Number(f.isdir) === 1 && f.path && !seen.has(f.path)) { seen.add(f.path); queue.push(f.path); }
        }
      }
    }
  };
  /** root=1 的根目录列表（分享页 file_list 为空时才用），同样翻页 */
  const rootListAll = async () => {
    const root = { errno: 0, list: [] };
    for (let page = 1; page <= SHARE_LIST_MAX_PAGES; page += 1) {
      const j = await listDirOnce({ page, root: true });
      if (j.errno !== undefined) root.errno = j.errno;
      const list = Array.isArray(j.list) ? j.list : [];
      root.list.push(...list);
      if (list.length < SHARE_LIST_PAGE) break;
    }
    return root;
  };

  /**
   * 慢路径：**完整枚举**分享里的每一个文件（老行为，保留下来当兜底）。
   * 它会 BFS 展开整棵目录树，每个目录一次 /share/list —— 而它是单条链里最贵的一环
   * （实测平均 2.90 秒，占"解析阶段"的 72%）。能走快路径时就不会到这里。
   */
  const fullCollect = async () => {
    fsIds = []; filePaths = []; zeroSize = 0; dirPaths = [];
    collect(rawList);
    await walkDirs(dirPaths);
    if (!fsIds.length) {
      // 分享页里的 file_list 有时是空的，这时必须问 root=1 要根目录列表（也翻页）
      const root = await rootListAll();
      if (root.errno === 0 && root.list.length) {
        dirPaths = [];
        collect(root.list);
        await walkDirs(dirPaths.slice());
      }
    }
    return { fsIds, filePaths, zeroSize };
  };

  // ─────── 快路径：直接拿分享页的根目录条目去转存，**一次 /share/list 都不打** ───────
  //
  // 依据（2026-10-14 从用户自己机器上那份参考实现读出来的，不是推测）：
  //   本机 `C:\Users\周万鹏\wangpan` 的 `backend/app/providers/baidu/provider.py`，
  //   `transfer()` 用的就是分享页 `file_list` 里的条目：
  //       `fs_ids = [int(f["fs_id"]) for f in files]`   ← **没有任何 isdir 过滤**
  //   而且那个文件**从头到尾没有调用过 /share/list**。
  //   也就是说：把**文件夹**的 fs_id 放进 fsidlist，百度会在服务端递归复制整个文件夹。
  //   我们原来为了"收集文件的 fs_id"把整棵目录树 BFS 展开一遍，**那份数据 /share/transfer 根本不需要**。
  //
  // 判据本身在 `planFastPath`（纯函数、可单测）；万一百度真的拒绝了快路径，
  // 下面转存那一步之后会自动退回完整枚举再试一次（只回退一次）。
  const fast = planFastPath({ entries: rawList, dryRun });
  let usedFastPath = false;
  if (fast.enabled) {
    usedFastPath = true;
    fsIds = fast.ids;
    filePaths = fast.paths;
  } else {
    await fullCollect();
  }
  if (!fsIds.length) {
    throw new Error(zeroSize > 0 ? `分享仅含 ${zeroSize} 个空文件（占位垃圾），已跳过` : "分享里没有文件");
  }
  tMark.afterList = Date.now();

  // ── 只读诊断口：到"解析完成"为止就返回 ──
  //
  // 为什么要有它（2026-10-14）：用户问"为什么一条要 9 秒、不能一秒几十个吗"。查下来的第一件事
  // 就是**得知道那 9 秒花在哪一步**，而在此之前这一步根本没法单独测 —— 想测它就必须真的转存一次，
  // 于是只能拿"总耗时减掉别的"去倒推，等于猜。开了这个口子，`scripts/probe-transfer-speed.js`
  // 就能用**已转存过的链接**把 verify / 分享页 / 列目录 三段的耗时和三段重试次数直接量出来，
  // **不建目录、不转存、不建分享 —— 对网盘零副作用**。
  //
  // 它不是给生产路径用的：批量转存永远不传 dryRun。默认 undefined = 老行为，完全不变。
  //
  // `usedFastPath` / `listCalls` 是给"快路径到底省了多少"准备的硬证据：快路径成立时
  // listCalls 必须是 0（一次 /share/list 都没打），否则说明又退回慢路径了。
  if (dryRun) {
    return { dryRun: true, shareid, uk, bdstoken, fsIds, filePaths, zeroSize, sharePageAttempts, usedFastPath, listCalls, rootEntries: rawList.length, timings: phaseDurations(tMark) };
  }

  // 4) 建目录 + 转存
  //
  // 逐层 create（/api/create?a=commit&isdir=1）。
  //
  // ⚠️ 更正（2026-10-09 复测）：这里曾写下一条**错误结论** ——
  //   "百度的 /api/create 已经用不了，一律返回 errno=-6，目录并未被创建"。
  //   真相是同一份代码当天重跑就通了：三层嵌套目录 errno=0、列目录可见、
  //   转存落盘 4 个文件且未回落。当初那串 -6 来自账号侧（该账号网盘剩余 0）
  //   叠加偶发限流，不是接口失效。把一次失败写死成"接口已死"，会让后来的人绕远路。
  //
  // 另一个真缺陷：建目录结果以前是 `await cResp.json().catch(() => ({}))` 直接丢掉的，
  //   于是下文 errno=2「目的路径不存在」时，完全看不出是建目录那步没成。
  //   现在把每层 errno 收进 createLog，跟着错误信息一起冒出来。
  const createLog = [];
  // 目标文件夹 = 父目录（账号/资源表）+ **分享里的真实名字**；
  // 没给 destParent 时退回旧的 destDir 语义（脚本/老调用方兼容）。
  const folder = (destParent ? nameFromShare(data) : "") || fallbackName || "资源";
  const finalDir = destParent ? `${String(destParent).replace(/\/+$/, "")}/${folder}` : String(destDir || "");
  const segments = finalDir.split("/").filter(Boolean);
  let acc = "";
  for (const seg of segments) {
    acc += `/${seg}`;
    // **建过的目录不再重复建**：原来每条资源都把 4 层目录各建一遍，其中 3 层
    //（来自资源批量转存 / 账号 / 资源表）每条完全相同 —— 白跑 3 个**写请求**，
    // 而写请求正是触发限流的东西（读请求实测打满 5/秒都没事）。缓存一次，之后每条只建自己那层。
    if (createdDirs && createdDirs.has(acc)) continue;
    const cResp = await panFetch(jar, `${PAN}/api/create?a=commit&bdstoken=${encodeURIComponent(bdstoken)}&web=1&channel=chunlei&clienttype=0`, {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: `path=${encodeURIComponent(acc)}&isdir=1`,
    });
    const cBody = await cResp.json().catch(() => ({}));
    // errno=0 新建成功；目录已存在时百度会返回非 0（见过 -8），也算可用。
    // 不在这里判成败——真正作数的是紧随其后的 transfer 结果，这里只留证据。
    if (Number(cBody.errno) !== 0) createLog.push(`${acc}=${cBody.errno}`);
    // **只有确实可用时才进缓存**（0=新建成功，-8=已存在）。
    // 别在失败时也缓存：那样后面的资源会跳过建目录，直接以 errno=2「目的路径不存在」失败。
    if (createdDirs && (Number(cBody.errno) === 0 || Number(cBody.errno) === -8)) createdDirs.add(acc);
  }
  tMark.afterCreate = Date.now();

  const transferTo = async (target) => {
    const resp = await panFetch(jar, `${PAN}/share/transfer?shareid=${shareid}&from=${uk}&bdstoken=${encodeURIComponent(bdstoken)}&channel=chunlei&clienttype=0&web=1`, {
      method: "POST",
      referer: rawUrl,
      headers: { Origin: PAN, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: `fsidlist=${encodeURIComponent(JSON.stringify(fsIds))}&path=${encodeURIComponent(target)}`,
    });
    return resp.json().catch(() => ({}));
  };

  let usedDir = finalDir;
  let tBody = await transferTo(usedDir);
  // 「这次转存到底成没成」——**不要在这里自己写判断**，统一走 transfer-outcome.js。
  // 那段判断的另外两份拷贝（transfer.js / pan-transfer-ui.js）已经因为没跟上而把
  // errno=4（已转存）、异步转存中、info 层真实错误都误判成失败，见该文件头注释。
  let outcome = normalizeTransferBody(tBody);
  // 快路径被百度拒了 → **自动退回完整枚举再试一次**（只回退一次，不会循环）。
  //
  // 为什么必须有这条兜底：快路径的依据是"参考实现从来不过滤 isdir，也从不用 /share/list"，
  // 那是间接证据。万一百度对某个分享拒绝整目录转存，没有这条兜底就会把一条本来能成的资源
  // 记成失败 —— 而"改快了却开始失败"比"慢"严重得多。排除掉"已转存 / 异步中 / 容量不足 /
  // info 层其实成功"这四种**不是拒绝**的形态，剩下的才触发回退。
  if (usedFastPath && !outcome.dup && !outcome.pending && !outcome.capacityFull
    && outcome.errno !== 0 && !outcome.infoSucceeded) {
    await fullCollect();
    if (fsIds.length) {
      usedFastPath = false;
      tBody = await transferTo(usedDir);
      outcome = normalizeTransferBody(tBody);
    }
  }
  // errno=2：目的路径不存在。子目录建不出来时，回落到顶层目录再试一次——
  // 顶层（如 /来自资源批量转存）通常是早就存在的，能传进去。
  if (outcome.pathMissing) {
    const fallback = `/${segments[0] || ""}`;
    if (fallback !== finalDir) {
      const retry = await transferTo(fallback);
      // 回落是否被接受，看的是**原始 errno**（不做 info 提升）：提升只会把 0 变成非 0，
      // 对"这次到底成没成"没有帮助，反而会让一个 errno=0 的响应被自己的 info 层否掉。
      const retryRaw = normalizeTransferBody(retry).rawErrno;
      if (retryRaw === 0 || retryRaw === DUP_ERRNO) {
        tBody = retry;
        outcome = normalizeTransferBody(retry);
        usedDir = fallback;
      }
    }
  }
  tMark.afterTransfer = Date.now();
  const fellBack = usedDir !== finalDir;
  if (outcome.capacityFull) throw Object.assign(new Error("网盘容量不足"), { fatal: true });

  // errno=4：文件此前已转存过 → 视为成功，复用已有路径
  if (outcome.dup) {
    const alt = outcome.infoPaths;
    let to = outcome.dupPaths.length ? outcome.dupPaths : alt;
    // duplicated/info 都没给路径时，用「转存目标目录 + 分享里的真实相对路径」拼出来盘路径。
    // 实测里百度会偶发在 errno=4 时不返回 duplicated.list（文件确实已在网盘里），
    // 以前这里直接抛错 → 该条每轮都被当成"失败"重来一遍（重传 + 再分享），纯属自伤。
    if (!to.length && filePaths.length) {
      to = filePaths.map((p) => `${usedDir}${String(p).startsWith("/") ? p : `/${p}`}`);
    }
    if (!to.length) throw new Error("重复转存但未取得已有文件路径");
    return { toPaths: to, dup: true, usedDir, fellBack, usedFastPath, timings: phaseDurations(tMark) };
  }
  const createHint = createLog.length ? `（建目录返回：${createLog.join(", ")}）` : "";
  // info[0].errno === 0 是「文件其实成功了」的形态 —— 此时顶层 errno 非 0 也**不许**报错，
  // 否则会把一次真实成功判成失败（历史上就是这么把成功打成失败的）。
  if (outcome.errno !== 0 && !outcome.infoSucceeded) throw new Error(`转存 errno=${outcome.errno} ${outcome.showMsg}${createHint}`);

  // 5) 权威落盘路径（extra.list 取 .to；duplicated.list 取 .path；全部字段化后合并）
  const toPaths = outcome.extraPaths.concat(outcome.dupPaths);
  // 大文件是**异步转存**的：errno=0 但响应里没有落盘路径，`show_msg` 写着「文件转存中」。
  // 真机现场：《琉璃》4K 全集连续三轮都被报成「转存返回成功但未取得落盘路径」——
  // 我们把它当失败记档、还计进了失败数，其实文件正在转。这不是失败，是"还没转完"。
  // 返回 pending 让调用方**按"待确认"处理**：不计失败、不进黑名单，下次运行再来看
  //（到那时文件已在网盘里，百度会返回 errno=4「已转存」并给出路径）。
  if (outcome.pending) {
    return { toPaths: [], pending: true, usedDir, fellBack: false, raw: tBody, usedFastPath, timings: phaseDurations(tMark) };
  }

  // 把响应本体带一点出来：光说"extra/duplicated 均为空"没法判断是接口改了、
  // 还是这几个文件其实被转到了别的地方。2026-10-10 真机跑批里 10 条里有 1 条撞上，
  // 当时日志什么都没留下，只能再来一次 —— 证据必须当场留下。
  if (!toPaths.length) {
    throw new Error("转存返回成功但未取得落盘路径（extra/duplicated 均为空）。"
      + `原始响应：${JSON.stringify(tBody).slice(0, 300)}${createHint}`);
  }
  return { toPaths, fsIds, usedDir, fellBack, usedFastPath, timings: phaseDurations(tMark) };
}

module.exports = { PAN, UA, TIMEOUT_MS, Jar, panFetch, makeClient, processOne, nameFromShare, phaseMarks, phaseDurations, planFastPath, FILE_LIST_PAGE_CAP };
