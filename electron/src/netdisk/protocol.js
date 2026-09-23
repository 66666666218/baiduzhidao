"use strict";

/**
 * 百度网盘转存协议客户端（纯 HTTP · 无浏览器）。
 * Jar = 每条资源独立 Cookie 会话；processOne = 单条完整链（verify→mset→建目录→转存）。
 * 参考 qingchuangjy/wangpan + 2026-09-23 实测（38条/分钟）。
 */

const PAN = "https://pan.baidu.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

module.exports = { PAN, UA, Jar, processOne };
