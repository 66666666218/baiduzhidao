"use strict";

/**
 * 百度网盘分享创建（v2.1 补充）。
 * 参考 BaiduPCS-Go 的 /share/pset 实现：
 *   - 使用 NetdiskUA（客户端型 UA），无需 bdstoken
 *   - path_list 为 JSON 字符串数组（完整路径）
 *   - schannel=4（有密码），schannel=0（无密码）
 *   - share_type=9（私密分享）
 *
 * 凭证来源：BDUSS + STOKEN cookie（从比特浏览器窗口提取）
 */

const NETDISK_UA = "netdisk;P2SP;2.2.51.6;netdisk;11.0.0.0;PC;PC-Windows;6.2.9200;WindowsBaiduYunGuanJia";
const PAN_API = "https://pan.baidu.com";
const TIMEOUT_MS = 20000;

/**
 * 百度硬限制：**单账号每日最多创建 300 个分享链接**（来自 BaiduPanFilesTransfers 等
 * 开源工具的实测文档，以及百度侧的非程序性限制）。超出后 share/pset 会拒绝。
 * 这不是 bug、也不是 Cookie 失效 —— 但 batch-transfer 以前把"建分享失败"误当成"整条转存失败"，
 * 于是已经落盘的文件被反复重传 + 反复建分享（继续被拒），形成虚假失败死循环。
 */
const SHARE_DAILY_LIMIT = 300;
/** 距上限多少条开始提前警告（留 10 条余量，避免恰好踩在边界上） */
const SHARE_SOFT_WARN_AT = SHARE_DAILY_LIMIT - 10;

/**
 * 生成一个 4 位随机提取码（建分享时用）。
 *
 * 字符集**故意剔掉了 i / l / o / 0 / 1** —— 提取码是要人工照着敲/认的，
 * 这几个字符在多数字体下会互相混淆（l 和 1、o 和 0）。
 *
 * 原本这段在三个文件里各写了一遍（`tasks/batch-transfer.js`、
 * `scripts/netdisk-share-existing.js`、`scripts/pan-transfer-pipeline.js`），
 * 内容完全相同、只是变量名不同 —— 收敛到这里，改字符集只需改一处。
 */
function randomPwd() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/**
 * 判定一次 share/pset 失败是否是「单账号每日分享上限」。
 * 百度的分享上限错误常见 errno=120，或返回文案含"分享"+"上限/次数/限制/已达/当天/每日/超过"。
 * 只有这种才把账号加入"仅转存不建分享"名单（见 batch-transfer 的 runShareStep）；
 * 其它分享错误（网络抖动、偶发拒绝）仍按"转移成功但分享失败"记档，等下次运行再试。
 */
function isShareLimitError(e) {
  const errno = Number(e && e.errno);
  if (errno === 120) return true;
  const msg = String((e && e.message) || "");
  return /分享/.test(msg) && /(上限|次数|限制|已达|当天|每日|超过)/.test(msg);
}

/**
 * 判定一次 share/pset 失败是否是「**该资源**被百度禁止二次分享」（errno=115）。
 * 依据：参考实现（本机 wangpan 项目 baidu provider）的 CHANGELOG 明确记录
 * "百度 errno=115 禁止二次分享"，它的做法是降级为目录直达链接。
 *
 * 这与"每日上限"必须分开 —— 两者处置完全不同：
 *   - 每日上限：**换号或等明天**就能好 → 封禁该账号本批剩余项，下次运行重试；
 *   - 禁止分享：**无论换哪个号、等多久都不会成功**（是这条分享本身不允许被再分享）
 *     → 只放弃这一条的分享，**不封禁账号**（同账号其它资源照样能建分享）。
 */
function isShareForbiddenError(e) {
  const errno = Number(e && e.errno);
  if (errno === 115) return true;
  const msg = String((e && e.message) || "");
  return /分享/.test(msg) && /(禁止|不允许|无法分享|封禁|违规|sorry)/i.test(msg);
}

/**
 * 本文件里所有请求都从这里出去。以前这两处请求**既没有超时、也没有代理**：
 *   - 没超时：网络卡住时"创建分享"这一步会永久挂住，用户只看到任务不动了；
 *   - 没代理：转存走代理、创建分享却走直连 —— 同一批操作从两个 IP 发出，
 *     比全程直连更可疑（转存那边是真的走代理的，这里漏了）。
 */
async function panFetch(url, { dispatcher, referer, ...init } = {}) {
  return fetch(url, {
    redirect: "follow",
    ...init,
    headers: {
      "User-Agent": NETDISK_UA,
      ...(referer ? { Referer: referer } : {}),
      ...(init.headers || {}),
    },
    dispatcher,
    signal: init.signal || (AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined),
  });
}

/**
 * 通过 /share/pset 创建分享链接。
 * @param {string} bduss
 * @param {string} stoken
 * @param {string[]} paths - 文件完整路径数组
 * @param {object} [opts] - { password: "提取码", expireDays: 0(永久), dispatcher: 该账号的代理 }
 * @returns {{ link: string, password: string, raw: object }}
 */
async function createShare({ bduss, stoken, paths, password = "", expireDays = 0, dispatcher }) {
  if (!bduss) throw new Error("缺少 BDUSS cookie");
  if (!paths || !paths.length) throw new Error("路径列表为空");

  const period = expireDays > 0 ? String(expireDays) : "0";
  const schannel = password ? "4" : "0";
  const cookieStr = "BDUSS=" + bduss + (stoken ? "; STOKEN=" + stoken : "");

  const res = await panFetch(`${PAN_API}/share/pset`, {
    dispatcher,
    method: "POST",
    headers: {
      "Cookie": cookieStr,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      path_list: JSON.stringify(paths),
      schannel,
      channel_list: "[]",
      period,
      pwd: password,
      share_type: "9",
    }).toString(),
  });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch {
    throw new Error(`share/pset 非 JSON: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  if (data.errno !== 0) {
    const err = new Error(`share/pset errno=${data.errno}: ${data.show_msg || body.slice(0, 200)}`);
    err.errno = data.errno;
    throw err;
  }
  return {
    link: data.link || data.shorturl || "",
    password,
    raw: data,
  };
}

/** 获取文件列表（找 fs_id 和 path 用） */
async function listDir({ bduss, stoken, dir = "/", dispatcher }) {
  if (!bduss) throw new Error("缺少 BDUSS cookie");
  const cookieStr = "BDUSS=" + bduss + (stoken ? "; STOKEN=" + stoken : "");
  const res = await panFetch(`${PAN_API}/api/list?dir=${encodeURIComponent(dir)}&order=name&desc=0&showempty=0&num=1000&page=1&channel=chunlei&web=1&clienttype=0`, {
    dispatcher,
    headers: { "Cookie": cookieStr },
  });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch {
    throw new Error(`api/list 非 JSON: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  if (data.errno !== 0) throw new Error(`api/list errno=${data.errno}`);
  return data.list || [];
}

module.exports = { createShare, listDir, randomPwd, NETDISK_UA, SHARE_DAILY_LIMIT, SHARE_SOFT_WARN_AT, isShareLimitError, isShareForbiddenError };
