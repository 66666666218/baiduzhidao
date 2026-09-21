"use strict";

/**
 * 网盘分享链路验证：上传 1KB 测试文件 → 创建分享链接（含提取码）→ 产出资源行。
 * 在「测试组1」窗口的百度登录态内执行。验证后可手动删除该测试文件。
 * 用法：node scripts/netdisk-share-test.js
 */

const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const cdp = fs.readFileSync(path.join(root, "运行缓存", "cdp.txt"), "utf8").trim();
const { chromium } = require("playwright-core");

(async () => {
  // 1) 造 1KB 测试文件
  const testFile = path.join(root, "运行缓存", "netdisk-share-test.txt");
  const content = "网盘分享链路自动化测试文件，验证后可删除。" + "x".repeat(900) + "\n";
  fs.writeFileSync(testFile, content, "utf8");
  console.log("测试文件已生成:", fs.statSync(testFile).size, "字节");

  const browser = await chromium.connectOverCDP(`http://${cdp}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes("pan.baidu.com")) || (await context.newPage());
  await page.goto("https://pan.baidu.com/", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 2) 上传：找隐藏的 file input
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.setInputFiles(testFile);
  console.log("已挂载上传文件，等待上传完成…");
  // 等上传完成（1KB 很快，轮询 30s）
  const upDeadline = Date.now() + 30000;
  while (Date.now() < upDeadline) {
    await page.waitForTimeout(2000);
    const uploading = await page.evaluate(() => {
      const t = document.body.innerText;
      /上传中|秒后|%/g;
      return /(\d+%)|上传中/.test(t.replace(/100%/g, ""));
    }).catch(() => false);
    if (!uploading) break;
  }
  await page.waitForTimeout(2000);

  // 3) 勾选该文件并分享
  const fileName = path.basename(testFile);
  const checked = await page.evaluate((name) => {
    const rows = document.querySelectorAll('[class*=file] [class*=item], tr, li');
    for (const row of rows) {
      if (row.innerText.includes(name)) {
        const box = row.querySelector('input[type=checkbox]');
        if (box && !box.checked) { box.click(); return 'checkbox'; }
        const label = row.querySelector('[class*=check]');
        if (label) { label.click(); return 'label'; }
      }
    }
    return null;
  }, fileName).catch(() => null);

  if (!checked) {
    // 兜底：勾第一行（测试环境）
    await page.locator('input[type=checkbox]').first().check().catch(() => {});
  }
  console.log("文件已勾选:", checked || "first-checkbox");

  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a,button,span,div')).find(el => el.textContent.trim() === '分享' && el.getBoundingClientRect().width > 0);
    if (el) el.click();
  });
  await page.waitForTimeout(2500);

  // 4) 分享弹窗：选提取码 → 创建链接
  const shareState = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasDialog: /创建链接|分享设置|提取码/.test(text),
      text: text.replace(/\n+/g, ' | ').slice(0, 300),
    };
  });
  console.log("分享弹窗:", JSON.stringify(shareState));

  // 选自定义提取码或随机，然后创建
  await page.evaluate(() => {
    const codes = Array.from(document.querySelectorAll('[class*=code],[class*=pwd],input,li,div,span')).filter(el => /自定义提取码|随机提取码|提取码/.test(el.textContent || el.placeholder || '') && el.getBoundingClientRect().width > 0);
    const custom = codes.find(el => /自定义/.test(el.textContent || ''));
    if (custom) custom.click();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button,a')).find(el => /创建链接|确定/.test(el.textContent.trim()) && el.getBoundingClientRect().width > 0);
    if (el) el.click();
  });
  await page.waitForTimeout(2500);

  // 5) 提取分享链接和提取码
  const share = await page.evaluate(() => {
    const text = document.body.innerText;
    const link = (text.match(/https:\/\/pan\.baidu\.com\/s\/[^\s|]+/) || [])[0] || "";
    const code = (text.match(/提取码[:：]\s*([a-z0-9]{4})/) || [])[1] || "";
    return { link, code };
  });
  console.log("分享结果:", JSON.stringify(share));
  if (share.link && share.code) {
    console.log("=== 链路验证成功 ===");
    console.log("资源行:", JSON.stringify({ 名称: fileName, 网盘链接: `${share.link} 提取码: ${share.code}` }));
    fs.writeFileSync(path.join(root, "运行缓存", "share-test-result.json"), JSON.stringify(share, null, 2));
  } else {
    await page.screenshot({ path: path.join(root, "运行缓存", "share-debug.png") });
    console.log("截图已存 运行缓存/share-debug.png");
  }
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message.slice(0, 160)); process.exit(1); });
