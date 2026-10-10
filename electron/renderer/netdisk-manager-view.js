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

  // 软件内登录提取：弹一个登录窗口，登进去自动关闭并填好 —— 不用 F12、不用比特。
  document.getElementById("nmLoginExtract").addEventListener("click", async function () {
    var url = document.getElementById("nmLoginUrl").value.trim();
    var typed = document.getElementById("nmAccountName").value.trim();
    // 上一轮"登录成功但没能自动取名"时，凭据留在了这里。用户按提示填好名字再点一次，
    // 就该**直接用那份凭据入库** —— 以前这个变量写进去却从来没有任何地方读它，
    // 提示里的"不用重新登录"是假的：照做只会又弹一次登录窗口、让人重登一遍。
    var pending = window.__pendingCred;
    if (pending && pending.ok && pending.bduss && typed) {
      window.__pendingCred = null;
      try {
        var info = await rpc.invoke("netdisk:accounts:add", { name: typed, bduss: pending.bduss, stoken: pending.stoken });
        appendLog("✅ " + typed + " 已入库（用的是上一次登录的 Cookie，没有重新登录）"
          + (info && info.netdiskOk ? "，网盘已连接" : "，网盘未连接（只影响转存，答题链可用）"));
        loadAccounts();
      } catch (e) { appendLog("入库失败：" + e.message + "（可再点一次「登录并提取」重新登一次）"); }
      return;
    }
    if (pending && !typed) {
      appendLog("上一轮登录的 Cookie 还在，请先在「账号备注名」填一个名字，再点一次即可入库（不用重新登录）。");
      return;
    }
    appendLog("已打开登录窗口：在里面登录百度，登进去会自动关闭并入库。");
    try {
      var creds = await rpc.invoke("auth:login-and-extract", { url: url });
      if (!creds || !creds.ok) { appendLog("登录提取失败：" + ((creds && creds.reason) || "未知原因")); return; }
      // 备注名空着时**用百度账号名自动命名** —— 以前这里直接 return，
      // 等于"登录成功却把 Cookie 丢了、要用户再登一次"，与界面承诺的
      // "登进去就会自动关闭并填好"自相矛盾。
      //
      // ⚠️ 但"用百度账号名命名"**本身是个陷阱**：那个名字（如「天一项目社」）
      // 几乎不可能和「比特环境名称」（用户自己起的「测试组1」「测试组2」）对上，
      // 而对不上就等于这份 Cookie 白存了 —— 任务按环境名找 Cookie 找不到，
      // 只能回落到开比特窗口，用户看到的是"我明明选了纯协议却开了比特窗口"。
      // （2026-10-10 用户就是这么踩的。）所以：优先用**「还没有凭据的那个环境名」**。
      // 只有一个环境缺凭据时就直接用它 —— 那正是用户此刻要登录的那个号。
      var name = typed;
      if (!name) {
        try {
          var envs = ((await rpc.invoke("settings:get")).bitEnvs || []).map(function (e) { return e.label || e; });
          var have = new Set((await rpc.invoke("netdisk:accounts:list") || []).map(function (a) { return a.name; }));
          var missing = envs.filter(function (e) { return !have.has(e); });
          if (missing.length === 1) {
            name = missing[0];
            appendLog("未填备注名 —— 已按「比特环境名称」里还缺凭据的那个用「" + name + "」命名（这样任务才能按名字找到它）。");
          }
        } catch (e) { /* 拿不到就用下面的兜底 */ }
      }
      if (!name) name = String(creds.userName || "").trim();
      if (!name) {
        appendLog("登录成功（账号 " + (creds.userName || "?") + "），但没能自动取名 —— 请在「账号备注名」填一个再点一次；Cookie 已暂存在本次会话里，不用重新登录。");
        window.__pendingCred = creds;
        return;
      }
      if (!typed && name === String(creds.userName || "").trim()) {
        appendLog("⚠️ 未填备注名，只能用百度账号名「" + name + "」命名 —— **它必须和「比特环境名称」里的一字不差**，否则任务找不到这份 Cookie、会回落到开比特窗口。"
          + "建议：到「账号凭证」删掉它，用「登录并提取」重登一次，备注名填成你的比特环境名。");
      }
      var info2 = await rpc.invoke("netdisk:accounts:add", { name: name, bduss: creds.bduss, stoken: creds.stoken });
      appendLog("✅ " + name + " 已入库（账号 " + ((info2 && info2.userName) || "?") + "）" + (info2 && info2.netdiskOk ? "，网盘已连接" : "，网盘未连接（只影响转存，答题链可用）"));
      loadAccounts();
    } catch (e) { appendLog("登录提取失败：" + e.message); }
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

  // ⚠️ 这个按钮以前**完全没有绑定**：HTML 有它、`manager.emptyRecycleBin()` 也早就写好了，
  // 但中间的 IPC 通道、preload 白名单、渲染端监听三处全缺 —— 点下去毫无反应、连日志都没有。
  // 网盘满了想清回收站时，用户只会以为软件坏了。现在把这条链补齐。
  document.getElementById("nmClearRecycle").addEventListener("click", async function () {
    if (!nmAccount) { appendLog("请先选择网盘账号。"); return; }
    if (!confirm("清空「" + nmAccount + "」的回收站？回收站里的文件将无法恢复。")) return;
    try {
      var r = await rpc.invoke("netdisk:empty-recycle", { name: nmAccount });
      if (r && r.errno === 0) appendLog("✅ 已清空「" + nmAccount + "」的回收站");
      else appendLog("清空回收站失败 errno=" + (r && r.errno) + "（若是 -6 多为权限或账号问题）");
    } catch (e) { appendLog("清空回收站失败：" + e.message); }
  });

  loadAccounts();
  loadRecords();

  window.netdiskManager = { loadAccounts: loadAccounts, browse: browse, loadRecords: loadRecords };
})();
