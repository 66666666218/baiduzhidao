"use strict";

const { SEL, activityUrl } = require("./selectors");

/**
 * 百度知道活动页/题目页的页面操作流。
 * 每个操作都带多级降级：locator → DOM evaluate → 诊断 dump（旧版验证过的策略）。
 * 所有选择器取自 selectors.js，本文件不出现裸选择器字面量。
 */

// ---------- 通用 ----------

async function pageLooksLikeVerify(page) {
  try {
    const url = page.url();
    if (/wappass|passport\.baidu\.com|captcha/i.test(url)) return true;
    const content = await page.content().catch(() => "");
    return SEL.verifyPattern.test(content.slice(0, 5000));
  } catch {
    return false;
  }
}

/** 等待页面就绪；若命中百度安全验证，等待人工处理后继续。 */
async function waitForBaiduReady(page, verifyWaitSeconds = 10, hooks = {}) {
  const waitMs = Math.max(5, Number(verifyWaitSeconds) || 10) * 1000;
  const deadline = Date.now() + waitMs;
  let warned = false;
  while (Date.now() < deadline) {
    if (!(await pageLooksLikeVerify(page))) return;
    if (!warned) {
      warned = true;
      hooks.onLog?.("检测到百度安全验证/验证码，请在浏览器窗口中手动完成，程序将等待...");
    }
    await page.waitForTimeout(1500).catch(() => {});
  }
  if (await pageLooksLikeVerify(page)) {
    throw new Error("百度安全验证未通过，请先在浏览器中完成验证后重试。");
  }
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (error) {
    // net::ERR_ABORTED 等由跳转引起的报错可忽略，只要页面可用
    if (!page.url()) throw error;
  }
}

function normalizeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titlesMatch(listTitle, pageTitle) {
  const a = normalizeTitle(listTitle).replace(/[?？!！。.，,：:、\s]/g, "");
  const b = normalizeTitle(pageTitle).replace(/[?？!！。.，,：:、\s]/g, "");
  if (!a || !b) return true; // 拿不到标题时不拦截
  return a.includes(b) || b.includes(a);
}

// ---------- 活动页：进入答题区 / 选分类 ----------

async function enterAnswerZone(page, hooks = {}) {
  const deadline = Date.now() + 150000;
  let refreshed = false;
  let lastWaitLogAt = 0;
  while (Date.now() < deadline) {
    if (await page.locator(SEL.zone.cards).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      hooks.onLog?.("已进入答题区。");
      return;
    }
    if (await clickByText(page, SEL.zone.zoneTabText)) {
      hooks.onLog?.("已点击答题区标签。");
      await page.waitForTimeout(2000).catch(() => {});
      continue;
    }
    if (Date.now() - lastWaitLogAt > 10000) {
      lastWaitLogAt = Date.now();
      hooks.onLog?.("等待活动页加载答题区或题卡...");
      if (!refreshed) {
        refreshed = true;
        hooks.onLog?.("加载较慢，刷新页面重试一次。");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000).catch(() => {});
        continue;
      }
    }
    await page.waitForTimeout(2000).catch(() => {});
  }
  throw new Error("未能进入答题区。");
}

/** 在所有 frame 中点击可见的精确文本元素（可点击祖先优先）。 */
async function clickByText(page, text) {
  const clickedByLocator = await page.getByText(text, { exact: true }).first()
    .click({ timeout: 2000, noWaitAfter: true })
    .then(() => true)
    .catch(() => false);
  if (clickedByLocator) return true;
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate((targetText) => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.pointerEvents !== "none";
      };
      const textOf = (el) => String(el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "")
        .replace(/\s+/g, " ").trim();
      const clickableOf = (el) => el.closest("button,a,[role='button'],li,[onclick]") || el;
      const candidates = Array.from(document.querySelectorAll("button,a,[role='button'],li,div,span"))
        .map((el) => {
          const target = clickableOf(el);
          const rect = target.getBoundingClientRect();
          return { el, target, text: textOf(el), top: rect.top, left: rect.left, active: /active|selected|current/.test(String(target.className || el.className || "")) };
        })
        .filter((item) => item.text === targetText && visible(item.target))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.top - b.top || a.left - b.left);
      const chosen = candidates[0];
      if (!chosen) return false;
      chosen.target.scrollIntoView({ block: "center", inline: "center" });
      chosen.target.click();
      return true;
    }, text).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

/** 选中分类标签；题卡已加载但找不到标签时按当前列表继续（旧版兼容策略）。 */
async function selectCategory(page, categoryLabel, hooks = {}) {
  const label = categoryLabel || SEL.category.labels[0];
  const deadline = Date.now() + 90000;
  let fallbackLogged = false;
  while (Date.now() < deadline) {
    const titlesBefore = await page.locator(SEL.zone.cardTitle).allTextContents().catch(() => []);
    // 优先：真实分类 tab（.answer-section-tab + 精确文本）
    let clicked = await page.locator(SEL.category.tabSelector, { hasText: new RegExp(`^\\s*${label}\\s*$`) })
      .first()
      .click({ timeout: 2000, noWaitAfter: true })
      .then(() => true)
      .catch(() => false);
    if (!clicked) clicked = await clickByText(page, label);
    if (clicked) {
      await waitForCardsChanged(page, titlesBefore);
      hooks.onLog?.(`已锁定分类：${label}`);
      return;
    }
    if (await page.locator(SEL.zone.cards).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      if (!fallbackLogged) {
        hooks.onLog?.(`未识别到“${label}”标签，但题卡已加载，按当前列表继续。`);
        fallbackLogged = true;
      }
      return;
    }
    await page.waitForTimeout(2000).catch(() => {});
  }
  throw new Error(`没有识别到“${label}”标签，也没有加载出题卡。`);
}

async function waitForCardsChanged(page, previousTitles = []) {
  if (previousTitles.length > 0) {
    const titleSel = SEL.zone.cardTitle;
    await page.waitForFunction((sel) => {
      const current = Array.from(document.querySelectorAll(sel))
        .map((el) => el.textContent?.trim() || "");
      return current.length > 0;
    }, titleSel, { timeout: 10000 }).catch(() => {});
  }
  await page.locator(SEL.zone.cards).first().waitFor({ state: "visible", timeout: 30000 });
}

// ---------- 活动页：分页 ----------

async function getActiveListPage(page) {
  const text = await page.locator(SEL.pager.activeNum).first().textContent().catch(() => "");
  const num = Number.parseInt(String(text || ""), 10);
  return Number.isFinite(num) ? num : 0;
}

async function getTotalListPages(page) {
  // 真实页面：页码按钮（1..N）中的最大值；placeholder("1011")不可靠，仅兜底
  const pageNums = await page.locator(SEL.pager.pageNum).allTextContents().catch(() => []);
  const nums = pageNums.map((text) => Number.parseInt(String(text || ""), 10)).filter((num) => Number.isFinite(num) && num > 0);
  if (nums.length) return Math.max(...nums);
  const placeholder = await page.locator(SEL.pager.jumpInput).first().getAttribute("placeholder").catch(() => "");
  const matched = String(placeholder || "").match(/\d+/);
  return matched ? Number.parseInt(matched[0], 10) : 0;
}

async function ensureListPage(page, expected, hooks = {}) {
  const active = await getActiveListPage(page);
  if (active === expected) return;
  if (active && expected === active + 1 && (await clickNextPage(page))) {
    await waitForActivePage(page, expected);
    return;
  }
  if (await clickPageNumber(page, expected)) {
    await waitForActivePage(page, expected);
    return;
  }
  const jumpInput = page.locator(SEL.pager.jumpInput);
  await jumpInput.fill(String(expected));
  await jumpInput.press("Enter");
  await jumpInput.blur().catch(() => {});
  await waitForActivePage(page, expected);
  hooks.onLog?.(`已切换到第 ${expected} 页。`);
}

async function waitForActivePage(page, expected) {
  const activeSel = SEL.pager.activeNum;
  await page.waitForFunction(
    ({ sel, expected }) => {
      const el = document.querySelector(sel);
      return el?.textContent?.trim() === String(expected);
    },
    { sel: activeSel, expected },
    { timeout: 30000 }
  ).catch(() => {});
  await page.locator(SEL.zone.cards).first().waitFor({ state: "visible", timeout: 30000 });
}

async function clickNextPage(page) {
  // 真实页面：专用 .pager-next 按钮
  const nextBtn = page.locator(SEL.pager.nextBtn).first();
  if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    const disabled = await nextBtn.isDisabled().catch(() => false);
    if (!disabled) {
      await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
      await nextBtn.click({ timeout: 5000, noWaitAfter: true }).catch(() => false);
      return true;
    }
    return false;
  }
  // 兜底：旧版启发式（找与当前页码同排、右侧的"下一页"样式元素）
  return page.evaluate(({ classPattern, textPattern, activeSel }) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.pointerEvents !== "none";
    };
    const textOf = (el) => String(el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").replace(/\s+/g, " ").trim();
    const active = document.querySelector(activeSel);
    if (!active) return false;
    const activeRect = active.getBoundingClientRect();
    const classRe = new RegExp(classPattern.source, classPattern.flags);
    const textRe = new RegExp(textPattern.source, textPattern.flags);
    const candidates = Array.from(document.querySelectorAll("button,a,[role='button'],div,span,li"))
      .map((el) => {
        const target = el.closest("button,a,[role='button'],li,[onclick]") || el;
        const rect = target.getBoundingClientRect();
        return { target, rect, className: String(target.className || el.className || ""), label: textOf(el) || textOf(target) };
      })
      .filter((item) => visible(item.target))
      .filter((item) => Math.abs(item.rect.top - activeRect.top) <= 80 && item.rect.left > activeRect.left)
      .filter((item) => classRe.test(item.className) || textRe.test(item.label))
      .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
    const chosen = candidates[0];
    if (!chosen) return false;
    chosen.target.scrollIntoView({ block: "center" });
    chosen.target.click();
    return true;
  }, { classPattern: { source: SEL.pager.nextClassPattern.source, flags: "i" }, textPattern: { source: SEL.pager.nextTextPattern.source, flags: "" }, activeSel: SEL.pager.activeNum }).catch(() => false);
}

async function clickPageNumber(page, pageNumber) {
  const clicked = await page.locator(SEL.pager.pageNum, { hasText: new RegExp(`^\\s*${pageNumber}\\s*$`) })
    .first()
    .click({ timeout: 2000, noWaitAfter: true })
    .then(() => true)
    .catch(() => false);
  return clicked;
}

// ---------- 活动页：打开题目 ----------

/** 逐个点击“去答题”；跳过已用过的题。返回 {questionPage, listTitle} 或 null。 */
async function openNextQuestion(page, usedKeys, hooks = {}) {
  // 注：不使用 waitForLoadState——back-navigation 后 load 事件可能永不触发，靠下方题卡显式等待
  const cards = page.locator(SEL.zone.cards);
  const hasCards = await cards.first().waitFor({ state: "visible", timeout: 30000 }).then(() => true).catch(() => false);
  if (!hasCards) {
    hooks.onLog?.("答题列表没有出现题卡。");
    return null;
  }
  const count = await cards.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    if (!(await card.isVisible().catch(() => false))) continue;
    const listTitle = normalizeTitle(await card.locator(SEL.zone.cardTitle).textContent().catch(() => ""));
    if (!listTitle || (usedKeys && usedKeys.has(listKey(listTitle)))) continue;
    const button = card.locator(SEL.zone.goAnswerBtn, { hasText: /去答题|答题/ }).first();
    if (!(await button.isVisible().catch(() => false)) || !(await button.isEnabled().catch(() => false))) continue;

    hooks.onLog?.(`打开题目：${listTitle}`);
    const popupPromise = page.context().waitForEvent("page", { timeout: 12000 }).catch(() => null);
    const listUrl = page.url();
    await button.click({ timeout: 30000, noWaitAfter: true });
    // 弹窗与同页跳转竞速：谁先发生用谁（真实页面为同页跳转，弹窗路径兼容旧版/其它平台）
    const popup = await Promise.race([
      popupPromise,
      page.waitForURL(/\/question\//, { timeout: 15000 }).then(() => null).catch(() => null),
    ]);
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      await popup.bringToFront().catch(() => {});
      return { questionPage: popup, listTitle, listUrl, isPopup: true };
    }
    const navigated = /\/question\//.test(page.url());
    if (!navigated) {
      hooks.onLog?.("点击去答题后未发生跳转（可能已答过或入口失效）。");
      await page.waitForTimeout(1000).catch(() => {});
      return null;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});
    await page.bringToFront().catch(() => {});
    return { questionPage: page, listTitle, listUrl, isPopup: false };
  }
  hooks.onLog?.("当前页没有尚未处理的可回答题目。");
  return null;
}

function listKey(title) {
  return `title:${String(title || "").replace(/\s+/g, "").toLowerCase()}`;
}

/** 从题卡 DOM 直接收集标题与链接（爬题备用通道）。 */
async function collectQuestionCards(page) {
  await page.locator(SEL.zone.cards).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  return page.evaluate(({ cardSel, titleSel }) => {
    const textOf = (el) => String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const absoluteUrl = (value) => {
      const raw = String(value || "").trim();
      if (!raw || raw === "#" || raw.startsWith("javascript:")) return "";
      try {
        return new URL(raw, location.href).href;
      } catch {
        return "";
      }
    };
    const extractUrl = (card) => {
      const link = Array.from(card.querySelectorAll("a[href]"))
        .map((el) => absoluteUrl(el.getAttribute("href")))
        .find(Boolean);
      if (link) return link;
      for (const el of card.querySelectorAll("button,a,[role='button'],div,span")) {
        const values = [el.getAttribute("data-url"), el.getAttribute("data-href"), el.getAttribute("href"), el.getAttribute("onclick"), el.outerHTML];
        const matched = values.join(" ").match(/https?:\\?\/\\?\/[^'"<>\s]+|\/question\/\d+[^'"<>\s]*/i);
        const url = matched && absoluteUrl(matched[0].replace(/\\\//g, "/"));
        if (url) return url;
      }
      return "";
    };
    return Array.from(document.querySelectorAll(cardSel))
      .map((card) => ({
        title: textOf(card.querySelector(titleSel) || card.querySelector("[class*='question'][class*='title']")),
        questionUrl: extractUrl(card),
      }))
      .filter((item) => item.title);
  }, { cardSel: SEL.zone.cards, titleSel: SEL.zone.cardTitle }).catch(() => []);
}

// ---------- 题目详情页 ----------

async function readQuestionTitle(page) {
  // 新版详情页：干净标题在 .main-column-title-content
  const clean = await page.locator(".main-column-title-content").first().textContent({ timeout: 600 }).catch(() => "");
  if (clean && clean.trim()) return normalizeTitle(clean);
  for (const selector of SEL.question.titleCandidates) {
    const text = await page.locator(selector).first().textContent({ timeout: 1500 }).catch(() => "");
    if (text && text.trim()) return normalizeTitle(text);
  }
  const fallback = await page.title().catch(() => "");
  return normalizeTitle(fallback.replace(/[_-]s*百度知道.*$/, ""));
}

async function openQuestionByUrl(page, questionUrl, hooks = {}) {
  hooks.onLog?.(`打开题目链接：${questionUrl}`);
  await page.goto(questionUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});
}

// ---------- 题目详情页：填答案 ----------

async function fillAnswerDraft(page, answer, hooks = {}) {
  const result = await fillAnswerByLocator(page, answer, hooks)
    .catch((error) => ({ ok: false, how: `locator: ${error.message}` }));
  if (result.ok) {
    hooks.onLog?.(`答案已填入（方式：${result.how}，长度 ${result.length}）。`);
    return true;
  }
  hooks.onLog?.(`答案填入失败（${result.how}），请手动粘贴。已把答案复制到剪贴板。`);
  return false;
}

async function fillAnswerByLocator(page, answer, hooks = {}) {
  // 1) 若编辑器不可见，先点“我来答/回答”入口
  let editor = await findAnswerEditor(page, 2000);
  if (!editor) {
    await clickAnswerEntry(page);
    editor = await findAnswerEditor(page, 5000);
  }
  if (!editor) throw new Error("没有找到回答输入框");
  await editor.scrollIntoViewIfNeeded().catch(() => {});
  return typeAnswerWithPasteFallback(editor, answer, hooks);
}

async function findAnswerEditor(page, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of SEL.question.editorCandidates) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 500 }).catch(() => false)) return locator;
    }
    // iframe 富文本
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const locator = frame.locator("[contenteditable='true'], body").first();
      if (await locator.isVisible({ timeout: 300 }).catch(() => false)) return locator;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return null;
}

async function clickAnswerEntry(page) {
  for (const selector of SEL.question.answerButtonCandidates) {
    const clicked = await page.locator(selector).first()
      .click({ timeout: 2000, noWaitAfter: true })
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      await page.waitForTimeout(1200).catch(() => {});
      return true;
    }
  }
  return clickByText(page, "我来答") || clickByText(page, "回答");
}

async function typeAnswerWithPasteFallback(editor, text, hooks = {}) {
  const typed = await typeAndVerify(editor, text, 7000);
  if (typed.ok) return { ok: true, how: typed.how, length: typed.length };
  hooks.onLog?.(`直接输入未完成（${typed.how}），尝试 DOM 注入剩余内容...`);
  const injected = await appendByDom(editor, text);
  if (injected.ok) return { ok: true, how: "dom-inject", length: injected.length };
  return { ok: false, how: `${typed.how} / dom-inject 失败` };
}

async function typeAndVerify(editor, text, budgetMs) {
  const deadline = Date.now() + budgetMs;
  try {
    await editor.click({ timeout: 3000 }).catch(() => {});
    const tag = await editor.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    if (tag === "textarea" || tag === "input") {
      await editor.fill("");
      await editor.type(text, { delay: 10 });
    } else {
      // contenteditable：先聚焦再分块输入
      await editor.focus().catch(() => {});
      await editor.type("", { delay: 0 }).catch(() => {});
      const chunkSize = 60;
      for (let offset = 0; offset < text.length && Date.now() < deadline; offset += chunkSize) {
        await editor.type(text.slice(offset, offset + chunkSize), { delay: 10 });
      }
    }
    const length = await editor.evaluate((el) => (el.value !== undefined ? String(el.value).length : (el.innerText || el.textContent || "").length)).catch(() => 0);
    if (length >= Math.min(text.length - 5, text.length)) return { ok: true, how: tag || "editor", length };
    return { ok: false, how: `长度不足（${length}/${text.length}）`, length };
  } catch (error) {
    return { ok: false, how: error.message, length: 0 };
  }
}

async function appendByDom(editor, text) {
  try {
    const length = await editor.evaluate((el, content) => {
      if (el.value !== undefined) {
        el.value = content;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return String(el.value).length;
      }
      el.innerHTML = String(content)
        .split(/\n{2,}/)
        .map((para) => `<p>${para.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`)
        .join("");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: content, inputType: "insertText" }));
      return (el.innerText || "").length;
    }, text);
    return { ok: length >= Math.min(text.length - 5, text.length), length };
  } catch {
    return { ok: false, length: 0 };
  }
}

// ---------- 题目详情页：提交 ----------

async function submitAnswer(page, hooks = {}) {
  for (const selector of SEL.question.submitCandidates) {
    const clicked = await page.locator(selector).first()
      .click({ timeout: 2000, noWaitAfter: true })
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      await page.waitForTimeout(2500).catch(() => {});
      hooks.onLog?.("已点击提交按钮。");
      if (await pageLooksLikeVerify(page)) {
        hooks.onLog?.("提交后出现安全验证，请在浏览器中手动完成。");
      }
      return true;
    }
  }
  const clickedByText = (await clickByText(page, "提交回答")) || (await clickByText(page, "提交"));
  if (clickedByText) {
    await page.waitForTimeout(2500).catch(() => {});
    hooks.onLog?.("已通过文本匹配点击提交按钮。");
    return true;
  }
  throw new Error("没有找到提交按钮");
}

/** 提交确认：捕捉页面上的成功信号（提交成功/回答成功/审核中等），3 秒内多次探测。 */
async function readSubmitConfirmation(page, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const found = await page.evaluate(() => {
      const pattern = /回答已发布|提交成功|回答成功|发布成功|成功提交|审核中|已提交成功|已发布/;
      const nodes = document.querySelectorAll("div,p,span,td,h1,h2,h3,li");
      for (const node of nodes) {
        // 只认可见文本（innerText），避免读到页面预置但隐藏的成功提示
        const text = String(node.innerText || "").replace(/\s+/g, " ").trim();
        if (text && text.length < 60 && pattern.test(text)) return text;
      }
      return "";
    }).catch(() => "");
    if (found) return { confirmed: true, signal: found };
    lastText = found;
    await page.waitForTimeout(500).catch(() => {});
  }
  return { confirmed: false, signal: lastText };
}

// ---------- 活动页：当天通过数 ----------

async function scrollActivityToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 800);
        total += 800;
        if (total >= document.body.scrollHeight || total > 60000) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  }).catch(() => {});
  await page.waitForTimeout(1000).catch(() => {});
}

/**
 * 从活动页读取当天答题进度。
 * 支持两种格式："x/y"（配额型）与 真实活动页的 "已答 N"（2026-09 校准，无总量上限）。
 * 识别不到返回空数组。
 */
async function readDailyPassed(page) {
  await scrollActivityToBottom(page);
  return page.evaluate(({ progressPattern, answeredPattern }) => {
    const re = new RegExp(progressPattern.source, progressPattern.flags);
    const ansRe = new RegExp(answeredPattern.source, answeredPattern.flags);
    const results = [];
    const seen = new Set();
    const textOf = (el) => String(el?.innerText || "").replace(/\s+/g, " ").trim();
    const nodes = document.querySelectorAll("[class*='account'],[class*='progress'],[class*='quest'],li,p,div");
    for (const node of nodes) {
      const text = textOf(node);
      if (!text || text.length > 200 || seen.has(text)) continue;
      const matched = text.match(re);
      if (matched) {
        seen.add(text);
        results.push({ label: text.slice(0, 60), done: Number(matched[1]), total: Number(matched[2]) });
        continue;
      }
      // 真实活动页格式："已答 49"（当天已回答数，无总量上限）
      const ans = text.match(ansRe);
      if (ans) {
        seen.add(text);
        results.push({ label: text.slice(0, 60), done: Number(ans[1]), total: 0, format: "answered-only" });
      }
    }
    return results;
  }, {
    progressPattern: { source: SEL.passed.progressPattern.source, flags: "" },
    answeredPattern: { source: "已答\\s*(\\d+)", flags: "" },
  }).catch(() => []);
}

module.exports = {
  activityUrl,
  waitForBaiduReady,
  pageLooksLikeVerify,
  safeGoto,
  enterAnswerZone,
  selectCategory,
  clickByText,
  getActiveListPage,
  getTotalListPages,
  ensureListPage,
  clickNextPage,
  openNextQuestion,
  collectQuestionCards,
  readQuestionTitle,
  titlesMatch,
  openQuestionByUrl,
  fillAnswerDraft,
  submitAnswer,
  readSubmitConfirmation,
  readDailyPassed,
  listKey,
  normalizeTitle,
};
