"use strict";
// 浏览器脚本，在 renderer.js 之后加载：直接自初始化（此前用 module.exports 工厂
// 却被 <script> 加载，首行即 ReferenceError，整个视图事件从未绑定过）
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var rpc = window.api;
  var appendLog = window.appendLog;
  var nmPath = "/";
  var nmAccount = "";
  function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function sz(n) { return n > 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : n > 1048576 ? (n / 1048576).toFixed(0) + " MB" : (n / 1024).toFixed(0) + " KB"; }

  async function loadAccounts() {
    try {
      var list = await rpc.invoke("netdisk:accounts:list");
      var body = document.getElementById("nmAccountsBody");
      body.innerHTML = "";
      var sel = document.getElementById("nmSelectAccount");
      sel.innerHTML = "";
      list.forEach(function (a) {
        var tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(a.name) + "</td><td>" + (a.totalGB || "-") + " GB</td><td>" + (a.freeGB != null ? a.freeGB + " GB" : "-") + "</td><td><button class='btn danger outline nm-del' data-name='" + esc(a.name) + "'>删除</button></td>";
        body.appendChild(tr);
        var opt = document.createElement("option");
        opt.value = a.name;
        opt.text = a.name;
        sel.appendChild(opt);
      });
    } catch (e) { appendLog("账号加载失败：" + e.message); }
  }

  async function browse(dirPath) {
    nmPath = dirPath || "/";
    document.getElementById("nmPath").value = nmPath;
    nmAccount = document.getElementById("nmSelectAccount").value;
    if (!nmAccount) { appendLog("请先选择网盘账号。"); return; }
    try {
      var r = await rpc.invoke("netdisk:list", { name: nmAccount, dir: nmPath });
      if (!r.exists) { appendLog("路径不存在：" + nmPath); return; }
      var body = document.getElementById("nmFilesBody");
      body.innerHTML = "";
      (r.items || []).forEach(function (f) {
        var tr = document.createElement("tr");
        tr.innerHTML = "<td><input type='checkbox' class='nm-file-check' data-path='" + esc(f.path) + "' /></td><td>" + (f.isDir ? "📁 " : "📄 ") + esc(f.name) + "</td><td>" + (f.isDir ? "目录" : sz(f.size)) + "</td>";
        body.appendChild(tr);
      });
      var q = await rpc.invoke("netdisk:accounts:check", { name: nmAccount }).catch(function () { return null; });
      if (q && q.valid) document.getElementById("nmQuota").textContent = "总 " + q.totalGB + " GB | 剩余 " + q.freeGB + " GB";
    } catch (e) { appendLog("浏览失败：" + e.message); }
  }

    async function loadRecords() {
    try {
      var r = await rpc.invoke('netdisk:records');
      var recs = r.records || [];
      document.getElementById('nmRecordsInfo').textContent = '共 ' + recs.length + ' 条';
      var body = document.getElementById('nmRecordsBody');
      body.innerHTML = '';
      recs.slice(0, 200).forEach(function (rec) {
        var tr = document.createElement('tr');
        var clr = rec.status === 'done' ? '#4caf50' : rec.status === 'failed' ? '#f44336' : '#ff9800';
        tr.innerHTML = '<td>' + esc((rec.at || '').slice(0, 16).replace('T', ' ')) + '</td><td>' + esc((rec.name || '').slice(0, 36)) + '</td><td style="color:' + clr + '">' + esc(rec.status) + '</td><td>' + esc((rec.source || '').slice(0, 14)) + '</td><td>' + (rec.ownLink ? "<a href='" + esc(rec.ownLink) + "' target='_blank'>链接</a>" : '-') + '</td>';
        body.appendChild(tr);
      });
    } catch (e) { appendLog('记录加载失败：' + e.message); }
  }

  // 解析用户粘贴的 Cookie 文本 → { bduss, stoken }
  // 支持三种写法：完整 Cookie 串（BDUSS=xx; STOKEN=yy）、换行/分号分隔的两个纯值、单个纯 BDUSS 值
  function parseCookie(text) {
    var s = String(text || "").trim();
    if (!s) return { bduss: "", stoken: "" };
    var mBd = s.match(/BDUSS\s*=\s*([^;,\s]+)/i);
    var mSt = s.match(/STOKEN\s*=\s*([^;,\s]+)/i);
    if (mBd) return { bduss: mBd[1], stoken: mSt ? mSt[1] : "" };
    var parts = s.split(/[\n;,\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length === 1) return { bduss: parts[0], stoken: "" };
    if (parts.length >= 2) {
      // BDUSS 约 190 位、STOKEN 约 32 位，按长度判别避免粘贴顺序干扰
      return parts[0].length >= parts[1].length ? { bduss: parts[0], stoken: parts[1] } : { bduss: parts[1], stoken: parts[0] };
    }
    return { bduss: "", stoken: "" };
  }

  async function addAccountFromCookie() {
    var name = document.getElementById("nmAccountName").value.trim();
    var cookieText = document.getElementById("nmCookie").value.trim();
    if (!cookieText) { appendLog("请先粘贴 Cookie：浏览器登录 pan.baidu.com 后 F12 → 网络 → 复制任意请求头里的整串 Cookie。"); return; }
    var creds = parseCookie(cookieText);
    if (!creds.bduss) { appendLog("未解析到 BDUSS，请检查粘贴内容（需含 BDUSS，或直接粘贴纯 BDUSS 值）。"); return; }
    if (!name) name = "账号" + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
    try {
      var q = await rpc.invoke("netdisk:accounts:add", { name: name, bduss: creds.bduss, stoken: creds.stoken });
      appendLog("✅ " + name + " 添加成功（总 " + q.totalGB + " GB | 剩余 " + q.freeGB + " GB）");
      document.getElementById("nmCookie").value = "";
      loadAccounts();
    } catch (e) { appendLog("添加账号失败：" + e.message); }
  }

  async function removeAccount(name) {
    if (!confirm("移除账号「" + name + "」？（仅从软件移除，不删除网盘文件）")) return;
    try {
      await rpc.invoke("netdisk:accounts:remove", { name: name });
      appendLog("✅ 已移除账号 " + name);
      loadAccounts();
    } catch (e) { appendLog("移除账号失败：" + e.message); }
  }

  document.getElementById("nmAddAccount").addEventListener("click", addAccountFromCookie);

  document.getElementById("nmExtract").addEventListener("click", async function () {
    var win = document.getElementById("nmWindowName").value.trim();
    var name = document.getElementById("nmAccountName").value.trim() || win;
    if (!win) { appendLog("请填写窗口名。"); return; }
    try {
      var creds = await rpc.invoke("netdisk:accounts:extract-from-window", { bitEnv: win });
      await rpc.invoke("netdisk:accounts:add", { name: name, bduss: creds.bduss, stoken: creds.stoken });
      appendLog("✅ " + name + " 已入库");
      loadAccounts();
    } catch (e) { appendLog("提取失败：" + e.message); }
  });

  document.getElementById("nmRefreshAccounts").addEventListener("click", loadAccounts);
  document.getElementById("nmAccountsBody").addEventListener("click", function (e) {
    var btn = e.target.closest(".nm-del");
    if (btn) removeAccount(btn.dataset.name);
  });
  document.getElementById("nmGo").addEventListener("click", function () { browse(document.getElementById("nmPath").value.trim() || "/"); });
  document.getElementById("nmUp").addEventListener("click", function () {
    var p = nmPath.replace(/\/+$/, "");
    browse(p.slice(0, p.lastIndexOf("/")) || "/");
  });
  document.getElementById("nmRefresh").addEventListener("click", function () { browse(nmPath); });
  document.getElementById("nmSelectAccount").addEventListener("change", function () { browse("/"); });
  document.getElementById("nmCheckAll").addEventListener("change", function (e) {
    document.querySelectorAll(".nm-file-check").forEach(function (c) { c.checked = e.target.checked; });
  });
  document.getElementById("nmDeleteSelected").addEventListener("click", async function () {
    var checked = [];
    document.querySelectorAll(".nm-file-check:checked").forEach(function (c) { checked.push(c.dataset.path); });
    if (!checked.length || !nmAccount) return;
    if (!confirm("删除选中的 " + checked.length + " 项？")) return;
    try {
      var r = await rpc.invoke("netdisk:delete", { name: nmAccount, paths: checked });
      if (r.errno === 0) { appendLog("✅ 已删 " + checked.length + " 项"); browse(nmPath); }
      else appendLog("删除失败 errno=" + r.errno);
    } catch (e) { appendLog("删除失败：" + e.message); }
  });
  document.getElementById("nmRefreshRecords").addEventListener("click", loadRecords);

  loadAccounts();
  loadRecords();

  window.netdiskManager = { loadAccounts: loadAccounts, browse: browse, loadRecords: loadRecords };
})();
