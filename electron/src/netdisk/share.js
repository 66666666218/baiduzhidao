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

module.exports = { createShare, listDir, NETDISK_UA };
