"use strict";

// 网盘管理服务（纯 Cookie 协议 · 无浏览器）
// 凭证 = BDUSS + STOKEN

var path = require("path");
var fs = require("fs");
var protocol = require("./protocol");

var PAN = "https://pan.baidu.com";
var NL = String.fromCharCode(10);

function ManagerJar() {}
ManagerJar.prototype = Object.create(protocol.Jar.prototype);
ManagerJar.prototype.call = function (pathAndQuery, opts) {
  opts = opts || {};
  var self = this;
  // 走协议层统一的 panFetch。以前这里是**裸 fetch**，后果很实在：
  //  · 没带 dispatcher —— 账号配了代理，转存走代理、"管理网盘"（查空间/列目录/删除/清空回收站）却走直连，
  //    同一批操作从两个 IP 发出，比全程直连更可疑（同一个坑在 share.js 里也踩过一次）；
  //  · 没有超时 —— 网络卡住时界面会永久停在"加载中"；
  //  · 不回收 set-cookie —— 百度中途换发的 Cookie 丢了，长会话可能掉登录态。
  // UA 与 protocol.UA 本来就是同一个串，所以这里换成 panFetch 不改变浏览器特征。
  return protocol.panFetch(self, PAN + pathAndQuery, {
    method: opts.method || "GET",
    referer: opts.referer || (PAN + "/disk/main"),
    headers: opts.headers,
    body: opts.body
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
  var jar = new protocol.Jar(account.bduss, account.stoken, account.dispatcher);
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
  var tmp = credFile(dataDir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ accounts: accounts, savedAt: new Date().toISOString() }, null, 1), "utf8");
  fs.renameSync(tmp, credFile(dataDir));
}

function findAccount(dataDir, name) {
  var list = loadAccounts(dataDir);
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === name) return list[i];
  }
  return null;
}

/**
 * 查网盘容量（/api/quota）。
 *
 * ⚠️ 失败时必须说清**为什么**：以前失败一律返回 `{ valid: false }`，调用方拿不到任何原因，
 * 只能继续显示存档里的旧数字 —— 于是账号已经登不上网盘了（errno=-6），界面上还挂着
 * 「总 120 GB | 剩余 120 GB」这种几个月前的快照，用户看到的现象就是"容量显示不准"，
 * 而真正的原因是登录失效。**静默保留旧值**比显示一个错数字更糟：它让人以为数据是最新的。
 *
 * @returns {Promise<{valid: boolean, name: string, totalGB?: number, freeGB?: number, errno: number|null, reason: string}>}
 */
/**
 * 容量查询失败时，给人看的**原因**。
 *
 * ⚠️ errno=-6（"用户未登录"）**不能**直接翻译成"你的号登不上网盘了" —— 2026-10-12 实测：
 *    `/api/quota` 对**所有**参数写法、所有请求头、甚至只带 BDUSS 都返回 -6；
 *    而**同一个 Cookie** 打 `/api/list`、`/api/gettemplatevariable` 却是 errno=0。
 *  也就是说这个接口现在就是取不到容量，**与账号登录态无关**（三个号都这样，稳定复现 3 轮）。
 *  以前那种"看到 -6 就提示用户重新登录"的写法会**骗人**：让人白白重登一遍，而且重登完照样取不到。
 *  所以 -6 要再拿一个**已知能用**的接口（列目录）验一次登录态，再决定怎么说。
 *
 * @param {number|null} errno
 * @param {boolean} netdiskAlive 用 /api/list 验出来的"这个号网盘到底通不通"
 */
function describeQuotaFailure(errno, netdiskAlive) {
  if (!netdiskAlive) return "网盘登录已失效（需重新登录提取）";
  if (errno === -6) return "容量接口不可用（百度 errno=-6，账号登录正常）";
  if (errno === null) return "网盘接口无响应";
  if (errno !== 0) return "网盘接口 errno=" + errno;
  return "响应里没有容量字段";
}

/** 用「列根目录」验证这个号的网盘到底通不通 —— quota 不可用时靠它区分"接口死"和"号真的掉了" */
function netdiskAlive(account) {
  var cli = clientOf(account);
  return cli.call("/api/list?dir=%2F&web=1&num=1").then(function (j) {
    return Boolean(j) && Number(j.errno) === 0;
  }).catch(function () { return false; });
}

function quota(account) {
  var cli = clientOf(account);
  return cli.call("/api/quota?checkfree=1&checkexpire=1&web=1").then(function (q) {
    if (q && Number(q.errno) === 0 && q.total) {
      var GB = 1073741824;
      return {
        valid: true,
        name: account.name,
        errno: 0,
        reason: "",
        loginOk: true,
        totalGB: Math.round((q.total / GB) * 10) / 10,
        freeGB: Math.round(((q.total - q.used) / GB) * 10) / 10
      };
    }
    var errno = q && q.errno !== undefined ? Number(q.errno) : null;
    // 补一次列目录：把"接口取不到"和"号真的掉了"分开，别让人白重登一次
    return netdiskAlive(account).then(function (alive) {
      return {
        valid: false,
        name: account.name,
        errno: errno,
        loginOk: alive,
        reason: describeQuotaFailure(errno, alive)
      };
    });
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
  var roots = ["批量转存", "transfer-batch", "transfer-ui", "transfer-pipeline", "网盘已有资源QA"];
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

/**
 * 按环境名取已保存的网盘凭据（BDUSS/STOKEN），没存过返回 null。
 * 名字必须与「账号凭证」里存的那条**一字不差**（和账号题材绑定同一套规矩）。
 */
function credentialOf(dataDir, envLabel) {
  var wanted = String(envLabel || "").trim();
  if (!wanted) return null;
  var hit = loadAccounts(dataDir).find(function (a) { return String(a.name || "").trim() === wanted; }) || null;
  if (!hit || !String(hit.bduss || "").trim()) return null;
  return { bduss: String(hit.bduss).trim(), stoken: String(hit.stoken || "").trim() };
}

/**
 * 找不到某个环境的凭据时，给一句**能照做**的诊断。
 *
 * 为什么需要：协议模式找不到 Cookie 会**静默回落到开窗口**（这是设计上的兜底），
 * 用户看到的是"我明明选了纯协议，怎么还是开了比特窗口"，而真正原因往往只是
 * **名字一字之差** —— 比如「比特环境名称」写的是 `测试组1`，而「账号凭证」里
 * 存的名字是登录时自动取用的百度账号名 `天一项目社`。
 * 只报"纯协议不可用"等于把用户扔在原地；这里把两边到底叫什么直接摆出来。
 */
function credentialHint(dataDir, envLabel) {
  var names = loadAccounts(dataDir).map(function (a) { return String(a.name || "").trim(); }).filter(Boolean);
  if (!names.length) {
    return "「账号凭证」里一个账号都没有 —— 到那一页点「登录并提取」，登录后会自动入库。";
  }
  // ⚠️ 这里**故意不复述环境名**：日志会把环境名脱敏（测试组1 → 测*1），
  // 一复述就变成"把备注名改成「测*1」"—— 那名字根本不存在，用户照着改只会更错。
  // （第一版就是这么写的，2026-10-10 在用户日志里看到了这个坏后果。）
  // 所以只摆出「存了谁」（账号名不脱敏，能照做），对不上时统一说"改成你在
  // 「比特环境名称」里写的那个名字"。
  return "「账号凭证」里存的是：" + names.join("、") + "；"
    + "和任务要找的那个名字对不上，所以用不上（两边必须**一字不差**）。"
    + "两条路选一条：①到「账号凭证」把备注名改成「在「比特环境名称」里写的那个名字」；"
    + "②或者把「比特环境名称」改成上面其中之一。";
}

module.exports = {
  ManagerJar: ManagerJar,
  credentialOf: credentialOf,
  credentialHint: credentialHint,
  clientOf: clientOf,
  loadAccounts: loadAccounts,
  saveAccounts: saveAccounts,
  findAccount: findAccount,
  quota: quota,
  netdiskAlive: netdiskAlive,
  describeQuotaFailure: describeQuotaFailure,
  listDir: listDir,
  deleteItems: deleteItems,
  emptyRecycleBin: emptyRecycleBin,
  transferRecords: transferRecords
};
