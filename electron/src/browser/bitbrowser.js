"use strict";

/**
 * 比特浏览器（BitBrowser）本地 API 适配器。
 * 文档：比特浏览器客户端开启“本地设置 → API”后，默认 http://127.0.0.1:54345。
 * 接口约定见 BrowserAdapter 注释（browser/index.js）。
 */
/** 单次本地 API 调用的兜底超时；开环境本身就要十几秒，给足余量只为了不无限挂住 */
const POST_TIMEOUT_MS = 60 * 1000;

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
    let candidates = [];
    for (const page of [0, 1]) {
      const response = await this.post("/browser/list", { page, pageSize: 100, name: cleanName });
      const browsers = extractBrowserList(response);
      if (browsers.length) { candidates = browsers; break; }
    }
    if (!candidates.length) throw new Error(`没有找到名称包含“${cleanName}”的比特浏览器环境`);
    const nameOf = (item) => String(item.name || item.browserName || "").trim();
    const exact = candidates.find((item) => nameOf(item) === cleanName);
    if (exact) return exact;
    // 【为什么宁可报错也不兜底】/browser/list 的 name 是**模糊**匹配，返回的列表里
    // 可能一个精确匹配都没有。以前这里是 `return exact || browsers[0]`：名字差一个字
    // （多空格/带后缀/大小写不同）就会静默打开**另一个**窗口 —— 那个窗口没登录百度就报
    // 「未登录百度账号」，登录的是别的号就读到别的额度；而日志从头到尾只显示你配的那个
    // 名字，于是"名字明明写对了"怎么查都查不出来。换新电脑/新环境时最容易踩这个。
    const near = candidates.map(nameOf).filter(Boolean).slice(0, 8);
    throw new Error(`比特环境名不匹配：没有名为“${cleanName}”的窗口。`
      + `名称里含“${cleanName}”的有：${near.join("、") || "（无）"}。`
      + `请把「比特环境」页里的名称改成与比特浏览器里的窗口名一字不差。`);
  }

  async open(idOrName) {
    const target = String(idOrName || "").trim();
    let id = target;
    let windowName = "";
    if (!/^[0-9a-f]{8,}$/i.test(target)) {
      const browser = await this.listByName(target);
      id = browser.id || browser.browserId;
      windowName = String(browser.name || browser.browserName || "").trim();
    }
    if (!id) throw new Error(`比特环境没有有效 id：${target}`);
    const data = await this.post("/browser/open", { id });
    const cdpUrl = extractCdpUrl(data);
    if (!cdpUrl) throw new Error(`比特浏览器已响应但没有调试地址：${JSON.stringify(data)}`);
    // 把实际窗口名透出去，调用方才能在日志里报"打开的是哪个窗口"（见 upload-batch）
    return { id: String(id), cdpUrl, name: windowName || target, driverPath: data?.data?.driver || "" };
  }

  async close(id) {
    return this.post("/browser/close", { id: String(id) });
  }

  async post(apiPath, payload) {
    // 没有超时的话：客户端端口在但卡住不响应，这个 await 永远不返回，
    // 任务停在 RUNNING，此后 assertIdle() 拒掉一切任务，只能靠重启进程解开。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error && error.name === "AbortError" ? `响应超过 ${POST_TIMEOUT_MS / 1000} 秒` : error.message;
      throw new Error(`无法连接比特浏览器本地服务：${reason}。请确认客户端已打开、本地 API 已开启且地址正确。`);
    } finally {
      clearTimeout(timer);
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
