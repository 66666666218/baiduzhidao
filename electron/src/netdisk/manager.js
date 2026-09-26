"use strict";

// 网盘管理服务（纯 Cookie 协议 · 无浏览器）
// 凭证 = BDUSS + STOKEN

var path = require("path");
var fs = require("fs");
var protocol = require("./protocol");

var PAN = "https://pan.baidu.com";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var NL = String.fromCharCode(10);

function ManagerJar() {}
ManagerJar.prototype = Object.create(protocol.Jar.prototype);
ManagerJar.prototype.call = function (pathAndQuery, opts) {
  opts = opts || {};
  var self = this;
  return fetch(PAN + pathAndQuery, {
    method: opts.method || "GET",
    headers: {
      "User-Agent": UA,
      "Cookie": self.str(),
      "Referer": opts.referer || (PAN + "/disk/main")
    },
    body: opts.body,
    redirect: "follow"
  }).then(function (r) { return r.json().catch(function () { return {}; }); });
};
ManagerJar.prototype.bdstoken = function () {
  var self = this;
  return self.call("/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D")
    .then(function (j) {
      if (j && j.errno === 0 && j.data) return j.data.bdstoken || "";
      return "";
    });
};
ManagerJar.prototype.constructor = ManagerJar;

function clientOf(account) {
  var jar = new protocol.Jar(account.bduss, account.stoken);
  Object.setPrototypeOf(jar, ManagerJar.prototype);
  return jar;
}

function credFile(dataDir) {
  return path.join(dataDir, "网盘账号.json");
}

function loadAccounts(dataDir) {
  try {
    var j = JSON.parse(fs.readFileSync(credFile(dataDir), "utf8"));
    if (Array.isArray(j.accounts)) return j.accounts;
    return [];
  } catch (e) {
    return [];
  }
}

function saveAccounts(dataDir, accounts) {
  fs.mkdirSync(path.dirname(credFile(dataDir)), { recursive: true });
  fs.writeFileSync(credFile(dataDir), JSON.stringify({ accounts: accounts, savedAt: new Date().toISOString() }, null, 1), "utf8");
}

function findAccount(dataDir, name) {
  var list = loadAccounts(dataDir);
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === name) return list[i];
  }
  return null;
}

function quota(account) {
  var cli = clientOf(account);
  return cli.call("/api/quota?checkfree=1&checkexpire=1&web=1").then(function (q) {
    if (!q || q.errno !== 0 || !q.total) return { valid: false, name: account.name };
    var GB = 1073741824;
    return {
      valid: true,
      name: account.name,
      totalGB: Math.round((q.total / GB) * 10) / 10,
      freeGB: Math.round(((q.total - q.used) / GB) * 10) / 10
    };
  });
}

function listDir(account, dir) {
  var cli = clientOf(account);
  return cli.call("/api/list?dir=" + encodeURIComponent(dir) + "&web=1&num=500").then(function (j) {
    var items = (j.list || []).map(function (f) {
      return {
        path: f.path,
        name: f.server_filename,
        isDir: Number(f.isdir) === 1,
        size: Number(f.size) || 0
      };
    });
    return { exists: j.errno === 0, errno: j.errno, items: items };
  });
}

function deleteItems(account, paths) {
  var cli = clientOf(account);
  return cli.bdstoken().then(function (token) {
    var qs = "async=2&bdstoken=" + encodeURIComponent(token) + "&web=1&channel=chunlei&clienttype=0";
    return cli.call("/api/filemanager?" + qs, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: "filelist=" + encodeURIComponent(JSON.stringify(paths)) + "&delete=1"
    });
  });
}

function emptyRecycleBin(account) {
  var cli = clientOf(account);
  return cli.bdstoken().then(function (token) {
    var qs = "web=1&channel=chunlei&clienttype=0&bdstoken=" + encodeURIComponent(token);
    return cli.call("/api/recyclebin/clear?" + qs, { method: "POST" });
  });
}

// 转存记录聚合：扫描 dataDir 下各管线的 state.jsonl
function collectStateFiles(dataDir, files) {
  var roots = ["批量转存", "transfer-batch", "transfer-ui", "网盘已有资源QA"];
  roots.forEach(function (r) {
    var dir = path.join(dataDir, r);
    try {
      fs.readdirSync(dir).forEach(function (sub) {
        var f = path.join(dir, sub, "state.jsonl");
        if (fs.existsSync(f)) files.push(f);
      });
    } catch (e) { /* 目录不存在 */ }
  });
  return files;
}

function transferRecords(dataDir) {
  var records = [];
  collectStateFiles(dataDir, []).forEach(function (f) {
    var lines = fs.readFileSync(f, "utf8").split(NL);
    lines.forEach(function (line) {
      if (!line.trim()) return;
      var r;
      try { r = JSON.parse(line); } catch (e) { return; }
      records.push({
        name: r.name || "",
        srcLink: r.srcLink || r.srcPath || "",
        status: r.status || "",
        phase: r.phase || "",
        ownLink: r.ownLink || "",
        error: r.error || "",
        source: path.basename(path.dirname(f)),
        at: r.at || ""
      });
    });
  });
  records.sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")); });
  return { count: records.length, records: records };
}

module.exports = {
  ManagerJar: ManagerJar,
  clientOf: clientOf,
  loadAccounts: loadAccounts,
  saveAccounts: saveAccounts,
  findAccount: findAccount,
  quota: quota,
  listDir: listDir,
  deleteItems: deleteItems,
  emptyRecycleBin: emptyRecycleBin,
  transferRecords: transferRecords
};
