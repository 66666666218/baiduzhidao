"use strict";

/**
 * 第 5 轮（一键全自动编排层）回归用例。
 * 编排本身的行为在 auto-pipeline.test.js 里覆盖，这里放**顺带发现**的、不属于编排的那些缺陷。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Config } = require("../../electron/src/config");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-r5-"));

test("「任务总量上限」填 0 必须真的表示「不限」—— 界面这么写、爬题也这么判，唯独设置层把它夹成了 1", () => {
  // 现场：一键全自动跑到爬题阶段，日志说"已达「任务总量上限」1 道题，停止爬取"。
  // 界面标签写着「0=不限」，crawl.js 也是 `maxQuestions > 0` 才算上限，
  // 但 normalizeSettings 的下限是 1 —— 用户填 0 就静默变成 1，不报错也看不出来。
  const dir = tempDir();
  try {
    const config = new Config(dir);
    const saved = config.save({ maxQuestions: 0 });
    assert.equal(saved.maxQuestions, 0, "0 应该原样保留（= 不限）");
    assert.equal(config.load().maxQuestions, 0, "重新读出来也该是 0");

    // 其它值照旧：正常值不被改动，超过上限仍被夹住
    assert.equal(config.save({ maxQuestions: 30 }).maxQuestions, 30);
    assert.equal(config.save({ maxQuestions: 999999 }).maxQuestions, 100000);
    assert.equal(config.save({ maxQuestions: "abc" }).maxQuestions, 20, "非法值回退默认 20");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
