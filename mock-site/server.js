"use strict";

/**
 * 模拟"百度知道 21 周年活动"站点 + 模拟比特浏览器 API。
 * 用途：无真实账号/比特浏览器时的全链路 E2E 测试与回归基线。
 *
 * - GET  /hd/21th_activity/            活动页（SPA：答题区/分类/分页/去答题弹新窗）
 * - GET  /question/:id                 题目页（标题 + 编辑器 + 提交回答）
 * - POST /api/submit                   记录提交内容
 * - GET  /api/submissions              查看已提交（供测试断言）
 * - GET  /api/questions?cat=&page=     题卡数据
 * - POST /browser/list|open|close      模拟比特浏览器本地 API
 * - POST /v1/chat/completions          模拟 OpenAI 兼容 LLM
 */

const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const CATEGORIES = ["情感类", "教育类", "综合类"];
const PAGES_PER_CATEGORY = 2;
const QUESTIONS_PER_PAGE = 3;

function buildQuestions() {
  const questions = [];
  let id = 900001;
  for (const cat of CATEGORIES) {
    for (let page = 1; page <= PAGES_PER_CATEGORY; page += 1) {
      for (let index = 1; index <= QUESTIONS_PER_PAGE; index += 1) {
        id += 1;
        questions.push({
          id: String(id),
          category: cat,
          page,
          title: `${cat}测试题${id}：这是第${page}页第${index}道题目`,
          content: `${cat}类问题的详细内容描述，题目编号 ${id}，用于验证内容透传。`,
        });
      }
    }
  }
  return questions;
}

function pageHtml(questions) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>模拟活动页 - 百度知道</title>
<style>
  body { font-family: sans-serif; margin: 0; background: #f6f7fb; }
  .hd { background: #2f6fed; color: #fff; padding: 18px 24px; font-size: 20px; }
  .wrap { max-width: 760px; margin: 24px auto; }
  .tabs, .cats { display: flex; gap: 12px; margin-bottom: 16px; }
  .tab, .cat { padding: 8px 18px; border-radius: 20px; background: #e8ecf5; cursor: pointer; border: 0; font-size: 14px; }
  .cat.active { background: #2f6fed; color: #fff; }
  .answer-section__question { background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .answer-section__question-title { font-size: 16px; font-weight: 600; margin-bottom: 10px; }
  .answer-section__btn { background: #2f6fed; color: #fff; border: 0; border-radius: 8px; padding: 8px 22px; cursor: pointer; }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: center; margin-top: 20px; }
  .answer-section__pager-num { padding: 6px 12px; border-radius: 6px; background: #fff; cursor: pointer; border: 1px solid #dde3ee; }
  .answer-section__pager-num.is-active { background: #2f6fed; color: #fff; }
  .answer-section__pager-jump-input { width: 90px; padding: 6px; border: 1px solid #dde3ee; border-radius: 6px; }
</style>
</head>
<body>
<div class="hd">百度知道 · 模拟答题活动</div>
<div class="wrap">
  <div class="tabs"><button class="tab" id="zoneTab">答题区</button><button class="tab">榜单区</button></div>
  <div id="answerZone" hidden>
    <div class="cats" id="cats"></div>
    <div class="account-progress" style="margin-bottom:10px;color:#666">账号1：2/5</div>
    <div id="cards"></div>
    <div class="pager">
      <span id="pageNums" style="display:flex;gap:8px"></span>
      <input class="answer-section__pager-jump-input" id="jump" placeholder="共__页" />
      <button class="answer-section__pager-num" id="next">›</button>
    </div>
  </div>
</div>
<script>
window.__QUESTIONS__ = ${JSON.stringify(questions)};
const CATS = ${JSON.stringify(CATEGORIES)};
let state = { cat: null, page: 1 };

function renderCats() {
  const box = document.getElementById('cats');
  box.innerHTML = '';
  for (const cat of CATS) {
    const btn = document.createElement('button');
    btn.className = 'cat' + (state.cat === cat ? ' active' : '');
    btn.textContent = cat;
    btn.onclick = () => { state.cat = cat; state.page = 1; render(); };
    box.appendChild(btn);
  }
}

function render() {
  document.getElementById('zoneTab').dataset.loaded = '1';
  document.getElementById('answerZone').hidden = false;
  renderCats();
  const list = window.__QUESTIONS__.filter(q => (!state.cat || q.category === state.cat) && q.page === state.page);
  const box = document.getElementById('cards');
  box.innerHTML = '';
  for (const q of list) {
    const card = document.createElement('div');
    card.className = 'answer-section__question';
    const title = document.createElement('div');
    title.className = 'answer-section__question-title';
    title.textContent = q.title;
    const btn = document.createElement('button');
    btn.className = 'answer-section__btn';
    btn.textContent = '去答题';
    btn.onclick = () => window.open('/question/' + q.id, '_blank');
    card.append(title, btn);
    box.appendChild(card);
  }
  const total = ${PAGES_PER_CATEGORY};
  const nums = document.getElementById('pageNums');
  nums.innerHTML = '';
  for (let p = 1; p <= total; p += 1) {
    const span = document.createElement('span');
    span.className = 'answer-section__pager-num' + (p === state.page ? ' is-active' : '');
    span.textContent = String(p);
    span.onclick = () => { state.page = p; render(); };
    nums.appendChild(span);
  }
  const jump = document.getElementById('jump');
  jump.placeholder = '共' + total + '页，输入页码';
  jump.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const p = Number(jump.value);
      if (p >= 1 && p <= total) { state.page = p; render(); }
    }
  };
  document.getElementById('next').onclick = () => {
    if (state.page < total) { state.page += 1; render(); }
  };
}

document.getElementById('zoneTab').onclick = () => {
  if (!document.getElementById('answerZone').hidden) return;
  render();
};
</script>
</body>
</html>`;
  return html;
}

function questionHtml(question) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${question.title}_百度知道</title>
<style>
  body { font-family: sans-serif; background: #fff; margin: 0; }
  .wrap { max-width: 720px; margin: 30px auto; }
  h1 { font-size: 20px; }
  .ueditor textarea { width: 100%; min-height: 140px; border: 1px solid #dde3ee; border-radius: 8px; padding: 10px; font-size: 14px; }
  .answer-button { margin-top: 12px; background: #2f6fed; color: #fff; border: 0; border-radius: 8px; padding: 10px 26px; cursor: pointer; }
  .ok { color: #30a46c; margin-top: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1 class="question-title">${question.title}</h1>
  <p class="question-content">${question.content}</p>
  <div class="ueditor"><textarea id="editor" placeholder="快来写下你的答案吧"></textarea></div>
  <button class="answer-button" id="submit">提交回答</button>
  <div class="ok" id="ok" hidden>回答提交成功</div>
</div>
<script>
document.getElementById('submit').onclick = async () => {
  const content = document.getElementById('editor').value;
  await fetch('/api/submit', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ questionId: '${question.id}', title: ${JSON.stringify(question.title)}, content }) });
  document.getElementById('ok').hidden = false;
  document.getElementById('submit').disabled = true;
};
</script>
</body>
</html>`;
}

class MockSite {
  constructor({ cdpUrl = "http://127.0.0.1:9333", port = 0 } = {}) {
    this.cdpUrl = cdpUrl;
    this.port = port;
    this.questions = buildQuestions();
    this.submissions = [];
    this.openedEnvs = new Map();
    this.llmCalls = [];
    this.server = null;
  }

  handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json; charset=utf-8") => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(code, { "Content-Type": type });
      res.end(payload);
    };
    const readBody = () => new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => resolve(data));
    });

    // ---- 站点 ----
    if (url.pathname === "/hd/21th_activity/") {
      return send(200, pageHtml(this.questions), "text/html; charset=utf-8");
    }
    if (url.pathname.startsWith("/question/")) {
      const id = url.pathname.split("/").pop();
      const question = this.questions.find((item) => item.id === id);
      if (!question) return send(404, "not found", "text/plain");
      return send(200, questionHtml(question), "text/html; charset=utf-8");
    }
    if (url.pathname === "/api/questions") {
      const cat = url.searchParams.get("cat") || "";
      const page = Number(url.searchParams.get("page")) || 1;
      return send(200, this.questions.filter((q) => q.category === cat && q.page === page));
    }
    if (url.pathname === "/api/submit" && req.method === "POST") {
      return readBody().then((body) => {
        this.submissions.push(JSON.parse(body));
        return send(200, { ok: true });
      });
    }
    if (url.pathname === "/api/submissions") {
      return send(200, this.submissions);
    }
    if (url.pathname === "/api/questions-count") {
      return send(200, { count: this.questions.length });
    }

    // ---- 模拟比特浏览器 ----
    if (url.pathname === "/browser/list" && req.method === "POST") {
      return readBody().then((body) => {
        const { name } = JSON.parse(body || "{}");
        return send(200, { success: true, data: { list: [{ id: `env-${name}`, name }] } });
      });
    }
    if (url.pathname === "/browser/open" && req.method === "POST") {
      return readBody().then((body) => {
        const { id } = JSON.parse(body || "{}");
        this.openedEnvs.set(id, (this.openedEnvs.get(id) || 0) + 1);
        return send(200, { success: true, data: { id, ws: { playwright: this.cdpUrl } } });
      });
    }
    if (url.pathname === "/browser/close" && req.method === "POST") {
      return readBody().then((body) => {
        const { id } = JSON.parse(body || "{}");
        this.openedEnvs.delete(id);
        return send(200, { success: true });
      });
    }

    // ---- 模拟 LLM ----
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return readBody().then((body) => {
        const payload = JSON.parse(body || "{}");
        this.llmCalls.push({ model: payload.model, user: payload.messages?.[1]?.content || "" });
        const answer = `这是一条模拟生成的回答，共约一百字。针对你提出的问题，我的看法是：先沟通、再观察、最后做决定。沟通时把感受说清楚，观察对方的反应是否匹配，最后基于事实而不是情绪做出选择，这样无论结果如何都不会后悔。`;
        return send(200, {
          choices: [{ message: { role: "assistant", content: answer } }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        });
      });
    }

    return send(404, { error: "not found" });
  }

  listen(port = 0) {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handler(req, res));
      this.server.listen(port, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }
}

module.exports = { MockSite, buildQuestions, CATEGORIES };
