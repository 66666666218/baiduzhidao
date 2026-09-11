"use strict";

/**
 * 比特浏览器（BitBrowser）本地 API 适配器。
 * 文档：比特浏览器客户端开启“本地设置 → API”后，默认 http://127.0.0.1:54345。
 * 接口约定见 BrowserAdapter 注释（browser/index.js）。
 */
class BitBrowserAdapter {
  constructor(baseUrl = "http://127.0.0.1:54345", fetchImpl = globalThis.fetch) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:54345").replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async checkConnection(timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl, { method: "GET", signal: controller.signal });
      return { ok: true, status: response.status };
    } catch (error) {
      const reason = error && error.name === "AbortError" ? "连接超时" : error.message;
      throw new Error(`无法连接比特浏览器本地服务：${reason}。请先打开比特浏览器客户端并开启本地 API，确认 API 地址为 ${this.baseUrl}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async listByName(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("比特环境名称不能为空");
    for (const page of [0, 1]) {
      const response = await this.post("/browser/list", { page, pageSize: 100, name: cleanName });
      const browsers = extractBrowserList(response);
      if (browsers.length) {
        const exact = browsers.find((item) => String(item.name || item.browserName || "").trim() === cleanName);
        return exact || browsers[0];
      }
    }
    throw new Error(`没有找到名称包含“${cleanName}”的比特浏览器环境`);
  }

  async open(idOrName) {
    const target = String(idOrName || "").trim();
    let id = target;
    if (!/^[0-9a-f]{8,}$/i.test(target)) {
      const browser = await this.listByName(target);
      id = browser.id || browser.browserId;
    }
    if (!id) throw new Error(`比特环境没有有效 id：${target}`);
    const data = await this.post("/browser/open", { id });
    const cdpUrl = extractCdpUrl(data);
    if (!cdpUrl) throw new Error(`比特浏览器已响应但没有调试地址：${JSON.stringify(data)}`);
    return { id: String(id), cdpUrl, driverPath: data?.data?.driver || "" };
  }

  async close(id) {
    return this.post("/browser/close", { id: String(id) });
  }

  async post(apiPath, payload) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
    } catch (error) {
      throw new Error(`无法连接比特浏览器本地服务：${error.message}。请确认客户端已打开、本地 API 已开启且地址正确。`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`比特浏览器 API 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`比特浏览器返回了非 JSON 内容：${text.slice(0, 200)}`);
    }
    if (data.success === false || (data.code !== undefined && data.code !== 0)) {
      throw new Error(`比特浏览器 API 返回失败：${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  }
}

function extractCdpUrl(response) {
  const data = response && typeof response.data === "object" && !Array.isArray(response.data) ? response.data : response;
  if (!data || typeof data !== "object") return "";
  if (data.ws && typeof data.ws === "object") {
    for (const key of ["playwright", "puppeteer", "selenium"]) {
      if (typeof data.ws[key] === "string" && data.ws[key]) return data.ws[key];
    }
  }
  for (const key of ["ws", "debuggerAddress", "debuggingAddress"]) {
    const value = data[key];
    if (typeof value === "string" && value) return value;
  }
  if (typeof data.http === "string" && data.http) {
    return data.http.startsWith("http") ? data.http : `http://${data.http}`;
  }
  const port = data.debuggingPort || data.remoteDebuggingPort;
  return port ? `http://127.0.0.1:${port}` : "";
}

function extractBrowserList(response) {
  const data = response && response.data;
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === "object");
  if (data && typeof data === "object") {
    for (const key of ["list", "data", "items", "records"]) {
      if (Array.isArray(data[key])) return data[key].filter((item) => item && typeof item === "object");
    }
  }
  for (const key of ["list", "items", "records"]) {
    if (Array.isArray(response && response[key])) return response[key].filter((item) => item && typeof item === "object");
  }
  return [];
}

module.exports = { BitBrowserAdapter, extractCdpUrl, extractBrowserList };
