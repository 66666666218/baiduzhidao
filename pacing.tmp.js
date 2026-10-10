"use strict";

/**
 * 一次性测量（跑完即删）：放慢写请求的节奏，能不能**不撞**限流窗口？
 *
 * 已知：限流窗口实测持续约 7.5 分钟；撞上之后只能等。
 * 那么"每 20 秒做一次转存（而不是连着冲）"能不能一直不撞？如果能，
 * 长跑就该用"放慢"代替"撞了就停 8 分钟"。
 *
 * 全程用**已转存过的链接**（只返回"已转存"、不新增文件、不占空间）。
 */

const protocol = require("./electron/src/netdisk/protocol");
const manager = require("./electron/src/netdisk/manager");
const excel = require("./electron/src/storage/excel");

const acc = manager.loadAccounts("运行缓存").find((a) => a.name === "测试组2");
const jar = () => new protocol.Jar(acc.bduss, acc.stoken);
const pool = excel.readTableRows("运行缓存/搜资源/_压测_24条.xlsx")
  .filter((r) => String(r["提取码"] || "").trim())
  .map((r) => ({ code: (String(r["链接"]).match(/\/s\/([\w-]+)/) || [])[1], pwd: String(r["提取码"]).trim() }))
  .filter((x) => x.code);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);

async function probe(j, x) {
  const surl = x.code.startsWith("1") ? x.code.slice(1) : x.code;
  await protocol.panFetch(j, `https://pan.baidu.com/share/verify?surl=${encodeURIComponent(surl)}&t=${Date.now()}&channel=chunlei&web=1&bdstoken=null&clienttype=0`,
    { method: "POST", referer: `https://pan.baidu.com/share/init?surl=${encodeURIComponent(surl)}`, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `pwd=${x.pwd}&vcode=&vcode_str=` });
  const p = await protocol.panFetch(j, `https://pan.baidu.com/s/${x.code}`);
  return /(?:yunData\.setData|locals\.mset)\(/.test(await p.text());
}

const GAP_MS = Number(process.argv[2]) || 20000;   // 每条转存之间的间隔
const ROUNDS = Number(process.argv[3]) || 14;

(async () => {
  const J = jar();
  // 先等窗口清干净，否则测的是"窗口还在"而不是"放慢有没有用"
  process.stdout.write(`[${ts()}] 等待窗口清空…`);
  for (let i = 0; i < 60; i += 1) {
    if (await probe(J, pool[0]).catch(() => false)) { console.log(" 已清空"); break; }
    process.stdout.write(".");
    await sleep(15000);
  }

  console.log(`[${ts()}] 开始：每 ${GAP_MS / 1000} 秒做 1 次真转存，共 ${ROUNDS} 次（每条后探一次分享页）`);
  let opened = 0;
  for (let i = 1; i <= ROUNDS; i += 1) {
    const x = pool[i % pool.length];
    let tr = "ok";
    try {
      await protocol.processOne(J, { link: `https://pan.baidu.com/s/${x.code}`, pwd: x.pwd, destDir: "/来自资源批量转存/_限流实验" });
    } catch (e) { tr = String(e.message).slice(0, 20); }
    const ok = await probe(J, pool[(i + 5) % pool.length]).catch(() => false);
    console.log(`[${ts()}] 第 ${i} 次写：转存=${tr} ｜ 探测=${ok ? "✅ 正常" : "❌ 窗口已打开"}`);
    if (!ok) { opened = i; break; }
    await sleep(GAP_MS);
  }
  console.log(opened
    ? `结论：放慢到 ${GAP_MS / 1000} 秒/条，仍在第 ${opened} 次写之后撞上窗口。`
    : `结论：放慢到 ${GAP_MS / 1000} 秒/条，连续 ${ROUNDS} 次写**没有撞上窗口** —— 放慢这条路可行。`);
})();
