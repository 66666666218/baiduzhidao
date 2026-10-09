"use strict";

/**
 * 百度网盘转存协议客户端（纯 HTTP · 无浏览器）。
 * Jar = 每条资源独立 Cookie 会话；processOne = 单条完整链（verify→mset→建目录→转存）。
 * 参考 qingchuangjy/wangpan + 2026-09-23 实测（38条/分钟）。
 */

const PAN = "https://pan.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      dispatcher: jar.dispatcher,
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
    dispatcher: jar.dispatcher,
    body: `pwd=${pwd}&vcode=&vcode_str=`,
  });
  jar.apply(vResp.headers.getSetCookie ? vResp.headers.getSetCookie() : []);
  const vBody = await vResp.json().catch(() => ({}));
  if (vBody.errno === -65 || vBody.errno === -62 || vBody.errno === -70) throw Object.assign(new Error(`verify风控 errno=${vBody.errno}`), { risk: true });
  if (vBody.errno !== 0 || !vBody.randsk) throw new Error(`verify errno=${vBody.errno}`);

  // 2) 分享页 → mset
  // 分享页偶发返回不含 mset 的响应（限流 / 半渲染）。一次拿不到就整条判死太脆：
  // 实测同一条链接、同一份 Cookie，第一次 fetch 解析为空、重试就能拿到。所以给 3 次。
  const SHARE_DATA_RE = /(?:yunData\.setData|locals\.mset)\(([\s\S]+?)\);/;
  let html = "";
  let data = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pResp = await fetch(`${PAN}/s/${fullCode}`, { headers: { "User-Agent": UA, "Cookie": jar.str() }, redirect: "follow", dispatcher: jar.dispatcher });
    jar.apply(pResp.headers.getSetCookie ? pResp.headers.getSetCookie() : []);
    html = await pResp.text();
    const mm = html.match(SHARE_DATA_RE);
    if (mm) {
      try { data = JSON.parse(mm[1]); } catch { data = null; }
      if (data && Number(data.errno) === 0) break;
    }
    if (attempt < 3) await sleep(1000 * attempt);
  }
  if (!data) throw new Error(`分享页无数据（重试 3 次仍失败；响应 ${html.length} 字节，多为限流或分享已失效）`);
  if (Number(data.errno) !== 0) throw new Error(`分享数据 errno=${data.errno}`);
  const uk = String(data.share_uk || data.uk || "");
  const shareid = String(data.shareid || "");
  const bdstoken = String(data.bdstoken || "");
  const rawList = Array.isArray(data.file_list) ? data.file_list : (data.file_list && data.file_list.list) || [];

  // 3) 递归收集 fs_id（root 空时走 /share/list）
  let fsIds = [];
  let dirPaths = [];
  let zeroSize = 0;
  const collect = (entries) => {
    for (const f of entries) {
      if (Number(f.isdir) === 1) dirPaths.push(f.path);
      else if (f.fs_id) {
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
    const j = await fetch(`${PAN}/share/list?${qs}`, { headers: { "User-Agent": UA, "Cookie": jar.str(), "Referer": rawUrl } }).then((r) => r.json()).catch(() => ({}));
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
    const root = await fetch(`${PAN}/share/list?web=5&app_id=250528&desc=1&showempty=0&page=1&num=100&order=time&view_mode=1&channel=chunlei&clienttype=0${bdstoken ? "&bdstoken=" + bdstoken : ""}&shorturl=${encodeURIComponent(surl)}&root=1`, { headers: { "User-Agent": UA, "Cookie": jar.str(), "Referer": rawUrl } }).then((r) => r.json()).catch(() => ({}));
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
  const segments = String(destDir || "").split("/").filter(Boolean);
  let acc = "";
  for (const seg of segments) {
    acc += `/${seg}`;
    const cResp = await fetch(`${PAN}/api/create?a=commit&bdstoken=${encodeURIComponent(bdstoken)}&web=1&channel=chunlei&clienttype=0`, {
      method: "POST",
      headers: { "User-Agent": UA, "Cookie": jar.str(), "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      dispatcher: jar.dispatcher,
      body: `path=${encodeURIComponent(acc)}&isdir=1`,
    });
    const cBody = await cResp.json().catch(() => ({}));
    // errno=0 新建成功；目录已存在时百度会返回非 0（见过 -8），也算可用。
    // 不在这里判成败——真正作数的是紧随其后的 transfer 结果，这里只留证据。
    if (Number(cBody.errno) !== 0) createLog.push(`${acc}=${cBody.errno}`);
  }

  const transferTo = async (target) => {
    const resp = await fetch(`${PAN}/share/transfer?shareid=${shareid}&from=${uk}&bdstoken=${encodeURIComponent(bdstoken)}&channel=chunlei&clienttype=0&web=1`, {
      method: "POST",
      headers: { "User-Agent": UA, "Cookie": jar.str(), "Referer": rawUrl, "Origin": PAN, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      dispatcher: jar.dispatcher,
      body: `fsidlist=${encodeURIComponent(JSON.stringify(fsIds))}&path=${encodeURIComponent(target)}`,
    });
    return resp.json().catch(() => ({}));
  };

  let usedDir = destDir;
  let tBody = await transferTo(usedDir);
  // errno=2：目的路径不存在。子目录建不出来时，回落到顶层目录再试一次——
  // 顶层（如 /来自资源批量转存）通常是早就存在的，能传进去。
  if (Number(tBody.errno) === 2) {
    const fallback = `/${segments[0] || ""}`;
    if (fallback !== destDir) {
      const retry = await transferTo(fallback);
      if (Number(retry.errno) === 0 || Number(retry.errno) === 4) {
        tBody = retry;
        usedDir = fallback;
      }
    }
  }
  const fellBack = usedDir !== destDir;
  const infoErr = tBody.info && tBody.info[0] && Number(tBody.info[0].errno);
  if (tBody.errno === 12 || tBody.errno === -10) throw Object.assign(new Error("网盘容量不足"), { fatal: true });

  // errno=4：文件此前已转存过 → 视为成功，复用已有路径
  if (Number(tBody.errno) === 4) {
    const dupPaths = ((tBody.duplicated && tBody.duplicated.list) || []).map((x) => x.path).filter(Boolean);
    const alt = (tBody.info || []).map((x) => x.path).filter(Boolean);
    const to = dupPaths.length ? dupPaths : alt;
    if (!to.length) throw new Error("重复转存但未取得已有文件路径");
    return { toPaths: to, dup: true, usedDir, fellBack };
  }
  const createHint = createLog.length ? `（建目录返回：${createLog.join(", ")}）` : "";
  if (Number(tBody.errno) !== 0 && !(infoErr === 0)) throw new Error(`转存 errno=${tBody.errno} ${tBody.show_msg || ""}${createHint}`);

  // 5) 权威落盘路径（extra.list 取 .to；duplicated.list 取 .path；全部字段化后合并）
  const extraPaths = ((tBody.extra && tBody.extra.list) || []).map((x) => x && x.to).filter(Boolean);
  const dupPaths = ((tBody.duplicated && tBody.duplicated.list) || []).map((x) => x && x.path).filter(Boolean);
  const toPaths = extraPaths.concat(dupPaths);
  if (!toPaths.length) throw new Error("转存返回成功但未取得落盘路径（extra/duplicated 均为空）");
  return { toPaths, fsIds, usedDir, fellBack };
}

module.exports = { PAN, UA, Jar, processOne };
