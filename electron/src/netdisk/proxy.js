"use strict";

/**
 * 每个账号一个出口 IP —— 纯协议模式下的**真隔离**。
 *
 * 为什么要它：纯协议请求走 node 的 fetch，所有账号共享同一个出口 IP 和同一份
 * TLS 指纹。IP 从来就没隔离过（用比特时也一样，除非在比特里配了代理），
 * 但既然现在能配，就给每个账号配一条代理 —— **IP 隔离比指纹隔离更实在**。
 *
 * 用法：设置页「账号代理」按 `账号=代理地址` 一行一个，例如
 *   测试组1=http://user:pass@1.2.3.4:8080
 *   测试组2=socks5://1.2.3.5:1080
 * 没配的账号直连（行为与以前完全一致）。
 *
 * 技术说明：Node 的 fetch 走 undici，`dispatcher` 是它认的代理入口。
 * 这里按代理地址缓存 Agent —— 每次请求新建会白白多一轮 TLS 握手。
 */

const { ProxyAgent } = require("undici");

/** 代理地址 -> Agent（复用连接，别每次重建） */
const cache = new Map();

/**
 * 取得该代理地址对应的 dispatcher；没配代理或地址非法时返回 undefined（= 直连）。
 * 返回 undefined 是安全的：fetch 会忽略这个字段。
 */
function dispatcherFor(proxyUrl) {
  const url = String(proxyUrl || "").trim();
  if (!url) return undefined;
  if (cache.has(url)) return cache.get(url);
  let agent;
  try {
    agent = new ProxyAgent(url);
  } catch (error) {
    // 地址写错不该让整个任务炸掉 —— 记一条警告然后直连
    // **脱敏**：代理地址的常见写法是 http://user:pass@host:port，整串打出去等于
    // 把代理账号密码写进日志文件（日志还会被用户导出、贴给别人看）。
    // 用 indexOf 而不是正则：正则里的反斜杠在层层工具链里被吞过两次，字符串操作不会。
    const schemeEnd = url.indexOf("//");
    const atSign = url.indexOf("@");
    const masked = (schemeEnd >= 0 && atSign > schemeEnd)
      ? url.slice(0, schemeEnd + 2) + "***@" + url.slice(atSign + 1)
      : url;
    console.warn(`[proxy] 代理地址无法解析，本次直连：${masked}（${error.message}）`);
    agent = undefined;
  }
  cache.set(url, agent);
  return agent;
}

/**
 * 把「账号=代理地址」的文本解析成映射表。
 * 认全角等号/冒号，容忍空行与 # 注释 —— 和「账号题材绑定」同一套写法。
 */
function parseAccountProxies(text) {
  const map = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([^=＝:：]+)[=＝:：]\s*(.+)$/);
    if (!m) continue;
    const account = m[1].trim();
    const proxy = m[2].trim();
    if (account && proxy) map[account] = proxy;
  }
  return map;
}

/** 清空缓存（设置变更时调用，避免旧代理一直生效） */
function resetProxyCache() {
  for (const agent of cache.values()) {
    try { if (agent && typeof agent.close === "function") agent.close(); } catch { /* 忽略 */ }
  }
  cache.clear();
}

module.exports = { dispatcherFor, parseAccountProxies, resetProxyCache };
