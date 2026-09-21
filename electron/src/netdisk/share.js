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

/**
 * 通过 /share/pset 创建分享链接。
 * @param {string} bduss
 * @param {string} stoken
 * @param {string[]} paths - 文件完整路径数组
 * @param {object} [opts] - { password: "提取码", expireDays: 0(永久) }
 * @returns {{ link: string, password: string, raw: object }}
 */
async function createShare({ bduss, stoken, paths, password = "", expireDays = 0 }) {
  if (!bduss) throw new Error("缺少 BDUSS cookie");
  if (!paths || !paths.length) throw new Error("路径列表为空");

  const period = expireDays > 0 ? String(expireDays) : "0";
  const schannel = password ? "4" : "0";
  const cookieStr = "BDUSS=" + bduss + (stoken ? "; STOKEN=" + stoken : "");

  const res = await fetch(`${PAN_API}/share/pset`, {
    method: "POST",
    headers: {
      "User-Agent": NETDISK_UA,
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
async function listDir({ bduss, stoken, dir = "/" }) {
  if (!bduss) throw new Error("缺少 BDUSS cookie");
  const cookieStr = "BDUSS=" + bduss + (stoken ? "; STOKEN=" + stoken : "");
  const res = await fetch(`${PAN_API}/api/list?dir=${encodeURIComponent(dir)}&order=name&desc=0&showempty=0&num=1000&page=1&channel=chunlei&web=1&clienttype=0`, {
    headers: { "User-Agent": NETDISK_UA, "Cookie": cookieStr },
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
