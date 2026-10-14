"use strict";

/**
 * 突变测试跑一次（第 21 轮沉淀）。
 *
 * 为什么要有这个脚本：
 *   本项目的核心纪律是「守卫必须用注入突变验」（改坏 → 当场红 → 还原）。
 *   但这件事在沙箱里**手工做很容易得出假结论** —— 之前用
 *   `spawnSync(process.execPath, ["--test", …])` 在进程里抓子进程 stdout，
 *   沙箱禁止带管道的子进程 → **输出永远是空** → 于是"守卫不敏感"的假象。
 *   正确做法是 shell 重定向到文件再 grep。
 *
 * 用法：
 *   node scripts/mutation-check.js <文件> <测试文件> <旧串> <新串> [<旧串2> <新串2> …]
 *
 * 退出码：0 = 突变被守卫抓到（好）；1 = 突变后测试全绿（守卫不敏感，坏）。
 * 无论成败都**从备份还原**，并在最后核对 md5，确保仓库没被改动。
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * 跑一次测试并把 stdout/stderr 落到文件，返回 {pass, fail, redLines}。
 *
 * ⚠️ 必须走 shell 重定向。用 `spawnSync(..., {encoding:"utf8"})` 在沙箱里是 EBUSY，
 * 拿回来的 stdout 是空字符串 —— 那会让"红了 0 项"变成一句弥天大谎。
 */
function runTests(testFile) {
  const out = path.join(process.env.TEMP || "/tmp", `mutation-out-${process.pid}.txt`);
  const testAbs = path.isAbsolute(testFile) ? testFile : path.join(process.cwd(), testFile);
  // 用 cmd 的 ">" 重定向；Git Bash 下 bash -c 也可以，这里走 bash 更稳
  // ⚠️ `node --test` 在有用例失败时**退出码是 1**，`execFileSync` 会因此抛异常。
  // 那个异常正是我们要的结果（红了 = 好事），所以必须吞掉，只看输出文件。
  try {
    execFileSync("bash", ["-c", `node --test "${testAbs}" > "${out}" 2>&1`], {
      stdio: "ignore",
    });
  } catch (_e) {
    /* 退出码非 0 = 有用例红了，正常 */
  }
  const text = fs.readFileSync(out, "utf8");
  fs.unlinkSync(out);
  const redLines = text.split(/\r?\n/).filter((l) => l.startsWith("not ok"));
  const fail = Number((text.match(/^# fail (\d+)/m) || [0, 0])[1]);
  const pass = Number((text.match(/^# pass (\d+)/m) || [0, 0])[1]);
  return { pass, fail, redLines };
}

function main() {
  const [target, testFile, ...pairs] = process.argv.slice(2);
  if (!target || !testFile || pairs.length === 0 || pairs.length % 2 !== 0) {
    console.error("用法: node scripts/mutation-check.js <文件> <测试文件> <旧串> <新串> [<旧> <新> …]");
    process.exit(2);
  }
  const abs = path.resolve(target);
  const original = fs.readFileSync(abs, "utf8");

  let mutated = original;
  for (let i = 0; i < pairs.length; i += 2) {
    const from = pairs[i];
    const to = pairs[i + 1];
    const hits = mutated.split(from).length - 1;
    if (hits === 0) {
      console.error(`❌ 突变串在文件里找不到（第 ${i / 2 + 1} 条）：${JSON.stringify(from)}`);
      process.exit(2);
    }
    if (hits > 1) {
      console.error(`⚠️ 突变串命中 ${hits} 次（第 ${i / 2 + 1} 条），加长前缀再试：${JSON.stringify(from)}`);
      process.exit(2);
    }
    mutated = mutated.split(from).join(to);
  }

  try {
    fs.writeFileSync(abs, mutated);
    const r = runTests(testFile);
    const caught = r.fail > 0;
    console.log(`突变后：pass=${r.pass} fail=${r.fail}`);
    if (caught) {
      console.log(`✅ 守卫咬住了（红了 ${r.fail} 项）：`);
      r.redLines.slice(0, 5).forEach((l) => console.log("   " + l));
    } else {
      console.log("❌ 突变后测试全绿 —— 守卫不敏感，逻辑没被真守住");
    }
    process.exitCode = caught ? 0 : 1;
  } finally {
    fs.writeFileSync(abs, original);
    // 还原必须字节一致，否则"验完"反而把仓库改坏了
    const back = fs.readFileSync(abs, "utf8");
    if (back !== original) {
      console.error("‼️ 还原后与原文不一致！仓库可能已被改坏");
      process.exitCode = 3;
    }
  }
}

main();
