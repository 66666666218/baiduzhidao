"use strict";

/** 账号代理解析的单测（纯函数，不碰网络）。 */

const test = require("node:test");
const assert = require("node:assert");
const { parseAccountProxies } = require("../../electron/src/netdisk/proxy");

test("parseAccountProxies：认 = 也认全角等号/冒号", () => {
  const m = parseAccountProxies([
    "测试组1=http://1.2.3.4:8080",
    "测试组2＝http://5.6.7.8:8080",
    "测试组3：socks5://9.9.9.9:1080",
  ].join("\n"));
  assert.equal(m["测试组1"], "http://1.2.3.4:8080");
  assert.equal(m["测试组2"], "http://5.6.7.8:8080");
  assert.equal(m["测试组3"], "socks5://9.9.9.9:1080");
});

test("parseAccountProxies：空行与 # 注释跳过，账号名两侧空白去掉", () => {
  const m = parseAccountProxies("\n  # 这是注释\n  账号A = http://a:1 \n\n");
  assert.deepEqual(Object.keys(m), ["账号A"]);
  assert.equal(m["账号A"], "http://a:1");
});

test("parseAccountProxies：没配代理时返回空表（= 全部直连，与功能引入前一致）", () => {
  assert.deepEqual(parseAccountProxies(""), {});
  assert.deepEqual(parseAccountProxies(undefined), {});
  assert.deepEqual(parseAccountProxies("只有账号名没有代理地址"), {});
});

test("parseAccountProxies：代理地址里的账号密码不会被等号切坏", () => {
  // http://user:pass@host:port 这种带冒号的很常见，别把 user:pass 当成"账号:代理"
  const m = parseAccountProxies("测试组1=http://u:p@1.2.3.4:8080");
  assert.equal(m["测试组1"], "http://u:p@1.2.3.4:8080");
});
