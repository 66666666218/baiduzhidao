"use strict";

/**
 * 百度网盘转存（v2.3 · 执行器架构）：
 *   他人分享 → verify → /share/list(shorturl 形态) → 转存 → 确认落盘。
 *
 * 为什么用执行器（executor）：百度对 Node 直连 fetch 有账号级限频/风控，
 * 而真浏览器上下文（比特浏览器窗口）天然通过。所有 API 通过注入的
 * call(path, opts) 执行——生产默认 createBrowserExecutor，调试可用 createNodeExecutor。
 *
 * 与 netdisk/share.js（创建自有分享）配套，构成"转存确权→自有分享"闭环。
 */

const PAN_API = "https://pan.baidu.com";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function parseShareLink(link) {
  const m = String(link || "").match(/pan\.baidu\.com\/s\/([\w-]+)/);
  if (!m) throw new Error(`无法解析分享链接: ${String(link).slice(0, 60)}`);
  const fullCode = m[1];
  const surl = fullCode.startsWith("1") ? fullCode.slice(1) : fullCode;
  const pwd = (String(link).match(/[?&]pwd=([a-z0-9]{4})/i) || [])[1] || "";
  return { fullCode, surl, pwd };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- 执行器 ----------

/** Node fetch 执行器（调试用；百度有账号级限频，批量场景勿用） */
function createNodeExecutor(cookieStr) {
  return {
    kind: "node",
    async call(pathAndQuery, opts = {}) {
      const resp = await fetch(`${PAN_API}${pathAndQuery}`, {
        method: opts.method || "GET",
        headers: {
          "User-Agent": WEB_UA,
          "Cookie": opts.cookieStr || cookieStr,
          "Referer": opts.referer || `${PAN_API}/disk/main`,
          ...(opts.headers || {}),
        },
        body: opts.body,
      });
      return resp.json().catch(() => ({}));
    },
    seedBDCLND() { /* Node 执行器由 call 的 opts.cookieStr 携带 BDCLND */ },
    withBDCLND(randsk) {
      return createNodeExecutor(cookieStr + `; BDCLND=${randsk}`);
    },
    async callText(pathAndQuery, opts = {}) {
      const resp = await fetch(`${PAN_API}${pathAndQuery}`, {
        headers: { "User-Agent": WEB_UA, "Cookie": opts.cookieStr || cookieStr },
      });
      return resp.text();
    },
  };
}

/** 浏览器上下文执行器（生产默认）：在已登录的 pan.baidu.com 页面里执行 fetch */
function createBrowserExecutor(page) {
  return {
    kind: "browser",
    page,
    async call(pathAndQuery, opts = {}) {
      return page.evaluate(async ({ pathAndQuery, opts }) => {
        const init = { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body };
        // Referer 是 fetch 禁改头，必须用 referrer 选项（转存接口校验分享页 referer）
        if (opts.referrer) init.referrer = opts.referrer;
        const resp = await fetch(`https://pan.baidu.com${pathAndQuery}`, init);
        return resp.json();
      }, { pathAndQuery, opts: { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body, referrer: opts.referrer || "" } });
    },
    async seedBDCLND(randsk) {
      await page.evaluate((r) => { document.cookie = `BDCLND=${r}; path=/; domain=.baidu.com`; }, randsk);
    },
    async callText(pathAndQuery) {
      return page.evaluate(async (p) => {
        const resp = await fetch(`https://pan.baidu.com${p}`);
        return resp.text();
      }, pathAndQuery);
    },
  };
}

/** 从页面/接口取 bdstoken（浏览器执行器走 gettemplatevariable） */
async function getBdstoken(exe) {
  const j = await exe.call(`/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D`);
  return j && j.errno === 0 && j.data ? j.data.bdstoken || "" : "";
}

// ---------- 核心 API ----------

/** verify 提取码 → randsk。errno=2 视为限频自动重试一次。 */
async function verifyPwd(exe, surl, pwd, refererPath) {
  const once = () => exe.call(
    `/share/verify?surl=${encodeURIComponent(surl)}&t=${Date.now()}&channel=chunlei&web=1&app_id=250528&clienttype=web`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `pwd=${encodeURIComponent(pwd)}`, referer: `${PAN_API}${refererPath}` }
  );
  let body = await once();
  if (body.errno === 2) { await sleep(4000); body = await once(); }
  if (body.errno === -9 || body.errno === -12) throw new Error("提取码错误或分享已失效");
  if (body.errno === -62 || body.errno === -70) throw new Error("触发风控（需暂停退避）");
  if (body.errno !== 0 || !body.randsk) throw new Error(`verify失败 errno=${body.errno}`);
  return body.randsk;
}

/** /share/list（shorturl 形态；root=1 或 dir=xxx） */
async function listShareDir(exe, { surl, bdstoken, dir }) {
  const qs = new URLSearchParams({
    web: "5", app_id: "250528", desc: "1", showempty: "0", page: "1", num: "100",
    order: "time", view_mode: "1", channel: "chunlei", clienttype: "0",
    ...(bdstoken ? { bdstoken } : {}),
    ...(dir ? { dir } : { root: "1" }),
    shorturl: surl,
  });
  return exe.call(`/share/list?${qs.toString()}`, { referer: `${PAN_API}/s/1${surl}` });
}

/** 递归展开分享目录（最多 3 层），收集全部文件 */
async function listShareTree(exe, { surl, bdstoken, maxDepth = 3 }) {
  const files = [];
  const walk = async (entries, depth) => {
    for (const f of entries) {
      if (Number(f.isdir) === 1 && depth < maxDepth) {
        const sub = await listShareDir(exe, { surl, bdstoken, dir: f.path });
        if (sub.errno === 0 && Array.isArray(sub.list)) await walk(sub.list, depth + 1);
      } else if (Number(f.isdir) !== 1 && f.path) {
        files.push({ path: f.path, server_filename: f.server_filename || "", fs_id: f.fs_id });
      }
    }
  };
  const root = await listShareDir(exe, { surl, bdstoken });
  if (root.errno !== 0 || !Array.isArray(root.list)) {
    const e = new Error(`share/list 失败 errno=${root.errno}`);
    e.errno = root.errno;
    throw e;
  }
  await walk(root.list, 0);
  return files;
}

/**
 * 解析他人分享：verify → 种 BDCLND → bdstoken → 递归清单。
 * @returns {{ shareid: string, from: string, sekey: string, files: {path:string}[] }}
 */
async function resolveShare(exe, { link }) {
  const { fullCode, surl, pwd } = parseShareLink(link);
  if (!pwd) throw new Error("分享链接缺提取码");

  const randsk = await verifyPwd(exe, surl, pwd, `/s/${fullCode}`);
  await exe.seedBDCLND(randsk);
  const bdstoken = await getBdstoken(exe);

  // 分享页（HTML）取 shareid / uk
  const html = await exe.callText(`/s/${fullCode}`);
  const shareid = (html.match(/"shareid":"?(\d+)"?/) || [])[1] || "";
  const from = (html.match(/"uk":"(\d+)"/) || html.match(/"share_uk":"(\d+)"/) || [])[1] || "";
  if (!shareid || !from) {
    if (html.includes("分享的文件已经被取消") || html.includes("分享已过期")) throw new Error("分享已失效");
    throw new Error("解析分享页失败（shareid/uk 缺失）");
  }

  const files = await listShareTree(exe, { surl, bdstoken });
  if (!files.length) throw new Error("分享里没有文件");
  return { shareid, from, sekey: decodeURIComponent(randsk), bdstoken, files, sharePageUrl: `${PAN_API}/s/${fullCode}?pwd=${pwd}` };
}

/**
 * 转存到自己网盘（2026-09 抓包校准：body 用 fsidlist 而非 filelist；sekey/bdstoken 走 query）。
 * 返回 { errno, toFsIds }
 */
async function transferFiles(exe, { shareid, from, sekey, files, destDir, bdstoken, sharePageUrl }) {
  const qs = new URLSearchParams({
    shareid: String(shareid),
    from: String(from),
    sekey: encodeURIComponent(sekey),
    channel: "chunlei",
    web: "1",
    app_id: "250528",
    clienttype: "0",
    ...(bdstoken ? { bdstoken } : {}),
  });
  const body = new URLSearchParams({
    fsidlist: JSON.stringify(files.map((f) => Number(f.fs_id))),
    path: destDir,
    type: "1",
  });
  return exe.call(`/share/transfer?${qs.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
    referrer: sharePageUrl || `${PAN_API}/disk/main`,
  });
}

/** 确认文件已落盘：列自己的目录比对文件名 */
async function verifyTransferred(exe, { destDir, expectNames }) {
  const j = await exe.call(`/api/list?dir=${encodeURIComponent(destDir)}&web=1&channel=dubox&clienttype=0`);
  if (j.errno !== 0 || !Array.isArray(j.list)) return { ok: false, found: [] };
  const have = new Set(j.list.map((f) => f.server_filename || (f.path || "").split("/").pop()));
  const found = expectNames.filter((n) => have.has(n));
  return { ok: found.length === expectNames.length, found };
}

module.exports = {
  PAN_API,
  parseShareLink,
  createNodeExecutor,
  createBrowserExecutor,
  getBdstoken,
  verifyPwd,
  listShareDir,
  listShareTree,
  resolveShare,
  transferFiles,
  verifyTransferred,
  sleep,
};
