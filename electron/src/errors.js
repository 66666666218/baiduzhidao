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
  return "可能是网络问题（国内访问 GitHub 不稳定）";
}

module.exports = { classifyError, describeError, describeUpdateError, LABELS };
