"use strict";

/**
 * 错误分类：把底层报错翻译成运维视角的类别，便于快速定位断在哪一环。
 * 类别：captcha（风控验证）、network（网络/连接）、page（页面结构/选择器）、ai（AI 接口）、browser（指纹浏览器）、unknown
 */
function classifyError(error) {
  const message = String((error && error.message) || error || "");
  if (/百度安全验证|验证码|滑动|captcha|wappass|passport\.baidu/i.test(message)) return "captcha";
  if (/比特浏览器|BitBrowser|环境名称|browser\/open|browser\/list/i.test(message)) return "browser";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|超时|timeout|fetch failed|net::|无法连接/i.test(message)) return "network";
  if (/没有找到|没有识别|未识别|没有出现|编辑器|输入框|提交按钮|题卡|选择器|没有找到回答/i.test(message)) return "page";
  if (/AI|API Key|chat\/completions|模型|siliconflow/i.test(message)) return "ai";
  return "unknown";
}

const LABELS = {
  captcha: "风控验证",
  network: "网络/连接",
  page: "页面结构（可能改版）",
  ai: "AI 接口",
  browser: "指纹浏览器",
  unknown: "未知",
};

/** 生成带分类标签的错误描述："【网络/连接】无法连接比特浏览器本地服务：..." */
function describeError(error) {
  const kind = classifyError(error);
  const message = String((error && error.message) || error || "");
  return `【${LABELS[kind]}】${message}`;
}

/**
 * 把「检查更新」的原始报错翻译成用户能看懂的一句话。
 *
 * 只说"失败"没用：这条报错最常见的两种成因是「线上根本没发布过任何版本」和
 * 「国内连不上 GitHub」，两者要处理的事完全不同。而原始串（HttpError 404 /
 * ETIMEDOUT）用户看不懂，也不会想到去查发布页。
 */
function describeUpdateError(error) {
  const text = String((error && error.message) || error || "");
  if (/404|not found|latest\.yml|no release|no published|not published|没有发布/i.test(text)) {
    return "线上可能还没有发布任何版本";
  }
  // ⚠️ 这里**不提**具体是哪个站点：用户明确要求不要把仓库地址暴露出去，
  //   而"国内访问 XX 不稳定"这句话本身就会把人引到那个地址上。
  return "可能是网络问题（更新服务器连不上）";
}

/**
 * 把一段文本里的**网址与仓库坐标**抹掉，然后才允许它进日志/界面。
 *
 * 为什么必须有这一层：electron-updater 的报错原文里会带完整的发布页地址
 * （形如 `https://github.com/<owner>/<repo>/releases/latest`），而我们是直接
 * `emit("task:log", e.message)` 打到运行日志里的 —— 等于把仓库地址逐字印给用户看。
 * 用户明确要求不要暴露，所以**凡是更新相关的文本，进日志前一律先过这个函数**。
 * 之所以做成函数而不是"在那几处各自替换"，是因为这类漏法改一处、别处又冒出来
 * （本仓库已经因为"改了一处没改另一处"吃过好几次亏）。
 *
 * @param {unknown} text
 * @returns {string}
 */
function scrubUrl(text) {
  let out = String(text == null ? "" : text);
  out = out.replace(/https?:\/\/\S+/gi, "（链接已省略）");                       // 带协议的完整 URL
  out = out.replace(/\b(?:www\.)?github\.com\/[^\s，,。）；)"']*/gi, "（链接已省略）"); // 没有协议前缀的
  out = out.replace(/\b66666666218\b/g, "***");                                   // 裸的仓库坐标
  out = out.replace(/(?:（链接已省略）\s*)+/g, "（链接已省略）");                   // 连续重复只留一个
  return out.trim();
}

module.exports = { classifyError, describeError, describeUpdateError, scrubUrl, LABELS };
