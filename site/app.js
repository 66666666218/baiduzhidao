"use strict";

// 展示站前端逻辑：数据面板 + 演示触发与日志渲染

const $ = (sel) => document.querySelector(sel);

// ---------- 数据面板 ----------
(async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    if (data.bank) $("#stBank").textContent = fmt(data.bank);
    if (data.generated) $("#stGen").textContent = fmt(data.generated);
    if (data.audit) $("#stAudit").textContent = fmt(data.audit);
  } catch {
    // 后端未启动时保持占位
  }
})();

function fmt(n) {
  return Number(n) >= 10000 ? (n / 10000).toFixed(1) + "w" : String(n);
}

// ---------- 演示 ----------
document.querySelectorAll("[data-demo]").forEach((button) => {
  button.addEventListener("click", async () => {
    const kind = button.dataset.demo;
    const logBox = $("#log-" + kind);
    logBox.hidden = false;
    logBox.textContent = "启动演示环境…";
    button.disabled = true;

    try {
      const res = await fetch("/api/demo/" + kind, { method: "POST" });
      const data = await res.json();
      logBox.textContent = (data.log || []).join("\n");
      if (!data.ok) logBox.textContent += "\n[演示未全部通过——细节见上方日志]";
    } catch (error) {
      logBox.textContent = "演示服务未启动：请在本机运行 node site/server.js 后刷新页面。\n(" + error.message + ")";
      logBox.classList.add("err");
    } finally {
      button.disabled = false;
    }
  });
});
