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
async function processOne(jar, { link, pwd, rawName, idx, destDir, destParent, fallbackName, createdDirs, bduss, stoken, makeShare }) {
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
  const uk = String(data.share_uk || data.uk || "");
  const shareid = String(data.shareid || "");
  const bdstoken = String(data.bdstoken || "");
  const rawList = Array.isArray(data.file_list) ? data.file_list : (data.file_list && data.file_list.list) || [];

  // 3) 递归收集 fs_id（root 空时走 /share/list）
  let fsIds = [];
  let dirPaths = [];
  // 与 fsIds 平行收集**分享内的真实相对路径**（/子目录/文件.mp4）。
  // 用途：errno=4（全部重复转存）时百度偶发不返回 duplicated.list，
  // 但文件其实早就在网盘里 —— 落盘路径是可以直接推出来的（转存目标目录 + 这个相对路径）。
  // 参考实现（本机 wangpan baidu provider）在 duplicated 为空时同样按 target_dir+文件名 拼。
  const filePaths = [];
  let zeroSize = 0;
  const collect = (entries) => {
    for (const f of entries) {
      if (Number(f.isdir) === 1) dirPaths.push(f.path);
      else if (f.fs_id) {
        if (f.path) filePaths.push(String(f.path));
        const hasSize = f.size !== undefined && f.size !== null && f.size !== "";
        if (hasSize && Number(f.size) === 0) { zeroSize += 1; continue; }  // 显式 0 字节=占位垃圾
        fsIds.push(Number(f.fs_id));                                        // 缺 size 字段按未知保留
      }
    }
  };
  collect(rawList);
  const listDir = async (dir) => {
    const qs = new URLSearchParams({ web: "5", app_id: "250528", desc: "1", showempty: "0", page: "1", num: "100", order: "time", view_mode: "1", channel: "chunlei", clienttype: "0", shorturl: surl, dir });
    if (bdstoken) qs.set("bdstoken", bdstoken);
    const j = await panFetch(jar, `${PAN}/share/list?${qs}`, { referer: rawUrl }).then((r) => r.json()).catch(() => ({}));
    return j;
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
  await walkDirs(dirPaths);
  if (!fsIds.length) {
    const root = await panFetch(jar, `${PAN}/share/list?web=5&app_id=250528&desc=1&showempty=0&page=1&num=100&order=time&view_mode=1&channel=chunlei&clienttype=0${bdstoken ? "&bdstoken=" + bdstoken : ""}&shorturl=${encodeURIComponent(surl)}&root=1`, { referer: rawUrl }).then((r) => r.json()).catch(() => ({}));
    if (root.errno === 0 && Array.isArray(root.list)) {
      dirPaths = [];
      collect(root.list);
      await walkDirs(dirPaths.slice());
    }
  }
  if (!fsIds.length) {
    throw new Error(zeroSize > 0 ? `分享仅含 ${zeroSize} 个空文件（占位垃圾），已跳过` : "分享里没有文件");
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
    return { toPaths: to, dup: true, usedDir, fellBack };
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
    return { toPaths: [], pending: true, usedDir, fellBack: false, raw: tBody };
  }

  // 把响应本体带一点出来：光说"extra/duplicated 均为空"没法判断是接口改了、
  // 还是这几个文件其实被转到了别的地方。2026-10-10 真机跑批里 10 条里有 1 条撞上，
  // 当时日志什么都没留下，只能再来一次 —— 证据必须当场留下。
  if (!toPaths.length) {
    throw new Error("转存返回成功但未取得落盘路径（extra/duplicated 均为空）。"
      + `原始响应：${JSON.stringify(tBody).slice(0, 300)}${createHint}`);
  }
  return { toPaths, fsIds, usedDir, fellBack };
}

module.exports = { PAN, UA, TIMEOUT_MS, Jar, panFetch, makeClient, processOne, nameFromShare };
