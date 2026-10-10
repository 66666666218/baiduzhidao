"use strict";

/**
 * 网盘协议层 `panFetch` 的单测。全部用假 fetch —— 不碰网络、不碰真实账号。
 *
 * 盯的是三件"漏了不会立刻报错、但后果很实在"的事：
 *   1. UA / Cookie 必须带上（漏了 = 被当成未登录或机器人）；
 *   2. dispatcher 必须带上（漏了 = 这一条走直连，同一批操作从两个 IP 发出）；
 *   3. 超时必须带上（漏了 = 网络卡住时整条链永久吊住，日志里一条错都没有）。
 * 顺带盯 set-cookie 回写：以前每个调用点都要自己 jar.apply，漏一处 Cookie 就丢了。
 */

const test = require("node:test");
const assert = require("node:assert");

const protocol = require("../../electron/src/netdisk/protocol");

/** 造一个够用的假响应：只有 headers.getSetCookie / json / text 被用到 */
function fakeResponse(body = {}, { setCookies = [], status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { getSetCookie: () => setCookies },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** 临时替换 global.fetch，跑完恢复 */
async function withFetch(impl, run) {
  const original = global.fetch;
  global.fetch = impl;
  try { return await run(); } finally { global.fetch = original; }
}

test("panFetch：自动带上统一 UA、jar 的 Cookie、代理 dispatcher、超时", async () => {
  const calls = [];
  const dispatcher = { __fake: "proxy-agent" };
  const jar = new protocol.Jar("BDUSS_VALUE", "STOKEN_VALUE", dispatcher);

  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return fakeResponse({ errno: 0 });
  }, () => protocol.panFetch(jar, "https://pan.baidu.com/api/list?dir=%2F"));

  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.equal(init.headers["User-Agent"], protocol.UA);
  assert.equal(init.headers.Cookie, "BDUSS=BDUSS_VALUE; STOKEN=STOKEN_VALUE");
  assert.equal(init.dispatcher, dispatcher, "漏了它这条请求就走直连 —— 正是要防的那种");
  assert.ok(init.signal, "必须有超时信号");
});

test("panFetch：referer 只在传了的时候才带（没传就不该凭空造一个）", async () => {
  const seen = [];
  const jar = new protocol.Jar("B", "");
  await withFetch(async (url, init) => { seen.push(init.headers); return fakeResponse({}); }, async () => {
    await protocol.panFetch(jar, "https://pan.baidu.com/a", { referer: "https://pan.baidu.com/s/abc" });
    await protocol.panFetch(jar, "https://pan.baidu.com/b");
  });
  assert.equal(seen[0].Referer, "https://pan.baidu.com/s/abc");
  assert.equal(seen[1].Referer, undefined);
});

test("panFetch：调用方传的 header 能覆盖默认值（比如网盘要用客户端型 UA）", async () => {
  const seen = [];
  const jar = new protocol.Jar("B", "");
  await withFetch(async (url, init) => { seen.push(init.headers); return fakeResponse({}); },
    () => protocol.panFetch(jar, "https://pan.baidu.com/x", { headers: { "User-Agent": "netdisk;P2SP" } }));
  assert.equal(seen[0]["User-Agent"], "netdisk;P2SP");
  assert.equal(seen[0].Cookie, "BDUSS=B", "覆盖 UA 不该把 Cookie 一起弄丢");
});

test("panFetch：把响应的 set-cookie 回写进 jar（否则后续请求会丢登录态）", async () => {
  const jar = new protocol.Jar("OLD", "");
  await withFetch(async () => fakeResponse({}, { setCookies: ["BDUSS=NEW; Path=/; HttpOnly", "BAIDUID=XYZ; Path=/"] }),
    () => protocol.panFetch(jar, "https://pan.baidu.com/x"));
  assert.match(jar.str(), /BDUSS=NEW/);
  assert.match(jar.str(), /BAIDUID=XYZ/);
});

test("processOne：不像分享链接的输入给明确报错，而不是 TypeError 崩在 m[1]", async () => {
  const jar = new protocol.Jar("B", "");
  await assert.rejects(
    () => protocol.processOne(jar, { link: "https://pan.baidu.com/", pwd: "", destDir: "/x" }),
    /不认识的分享链接/
  );
});

test("processOne：verify 返回风控码时标记 risk（供上层全局暂停用）", async () => {
  const jar = new protocol.Jar("B", "");
  await withFetch(async () => fakeResponse({ errno: -62 }), async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "1234", destDir: "/x" }),
      (err) => err.risk === true && /verify风控/.test(err.message)
    );
  });
});

test("processOne：提取码为空且 verify 被拒 → 报错要指向「去补提取码」，而不是只丢一个 errno", async () => {
  // 真机现场：搜到的一条资源提取码为空，而那条分享确实需要码 —— 转存时只报
  // `verify errno=-9`，用户完全不知道该干什么。现在直接告诉他去哪儿补。
  const jar = new protocol.Jar("B", "");
  await withFetch(async () => fakeResponse({ errno: -9 }), async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "", destDir: "/x" }),
      (err) => /提取码/.test(err.message) && /补上|删掉/.test(err.message)
    );
  });
});

test("processOne：有提取码时 verify 被拒仍走原来的错误（不要把所有失败都说成缺码）", async () => {
  const jar = new protocol.Jar("B", "");
  await withFetch(async () => fakeResponse({ errno: -9 }), async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" }),
      (err) => /verify errno=-9/.test(err.message) && !/提取码」是空的/.test(err.message)
    );
  });
});

test("processOne：分享页取不到数据时要打 sharePageLimited 标记（调用方靠它做冷却与延后重试）", async () => {
  // 只有一句"多为限流"的提示没用 —— batch-transfer 得能**认出**这条值得待会儿再试一次，
  // 否则当场连试三次就放弃了（真机实测：同一批失败 6/9，隔几分钟重跑几乎全好）。
  const jar = new protocol.Jar("B", "");
  let sharePageCalls = 0;
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });   // 先让 verify 过
    sharePageCalls += 1;
    return fakeResponse("<html>没有 mset 的页面</html>");
  }, async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" }),
      (err) => {
        assert.equal(err.sharePageLimited, true, "必须带上这个标记");
        assert.match(err.message, /限流/, "文案也要说清");
        return true;
      }
    );
  });
  assert.equal(sharePageCalls, 3, "分享页要重试 3 次才放弃");
});

test("processOne：大文件异步转存（show_msg=文件转存中）要返回 pending，不能当成失败", async () => {
  // 真机现场：《琉璃》4K 全集连续三轮被报「转存返回成功但未取得落盘路径」——
  // 挖出原始响应才看到 show_msg 写着「文件转存中」：百度收下了、正在转，只是这次没给路径。
  // 把它当失败会虚报失败数、可能进黑名单，而且下次运行还会再发起一次转存（可能重复落盘）。
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
    file_list: [{ fs_id: 1, isdir: 0, size: 100, path: "/a.mkv" }] });
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/api/create")) return fakeResponse({ errno: 0 });
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 0, show_msg: "文件转存中", task_id: "t1" });
    return fakeResponse({});
  }, async () => {
    const r = await protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" });
    assert.equal(r.pending, true, "要返回 pending 而不是抛错");
    assert.deepEqual(r.toPaths, [], "这次拿不到路径");
  });
});

test("processOne：errno=0 但没有路径、且不是「转存中」时，仍然按失败报（并带上原始响应）", async () => {
  const jar = new protocol.Jar("B", "");
  const mset = JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
    file_list: [{ fs_id: 1, isdir: 0, size: 100, path: "/a.mkv" }] });
  await withFetch(async (url) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    if (url.includes("/s/1abcdefghij")) return fakeResponse(`<script>locals.mset(${mset});</script>`);
    if (url.includes("/api/create")) return fakeResponse({ errno: 0 });
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 0, show_msg: "", requeno: "x" });
    return fakeResponse({});
  }, async () => {
    await assert.rejects(
      () => protocol.processOne(jar, { link: "https://pan.baidu.com/s/1abcdefghij", pwd: "ab12", destDir: "/x" }),
      (err) => /未取得落盘路径/.test(err.message) && /原始响应/.test(err.message)
    );
  });
});

// ---------- 命名：用分享里的真实文件名（2026-10-10 用户反馈） ----------

test("nameFromShare：用分享里的**真实文件名**，不是资源表里的问题标题", () => {
  // 用户反馈："资源名不能按表格名称，应该按实际资源名称" —— 表里那列常常是
  // "求XX网盘链接"这种从知道答案抓来的**问题标题**，拿它当资源名很荒唐。
  assert.equal(protocol.nameFromShare({ file_list: [{ isdir: 0, server_filename: "星际穿越.mkv", path: "/电影/星际穿越.mkv" }] }), "星际穿越.mkv");
  // 没有 server_filename 时从 path 取最后一段
  assert.equal(protocol.nameFromShare({ file_list: [{ isdir: 0, path: "/电影/流浪地球2.mp4" }] }), "流浪地球2.mp4");
  // 分享整个文件夹：用文件夹名
  assert.equal(protocol.nameFromShare({ file_list: [{ isdir: 1, path: "/美剧合集" }] }), "美剧合集");
  // 优先文件而不是目录
  assert.equal(protocol.nameFromShare({ file_list: [{ isdir: 1, path: "/合集" }, { isdir: 0, path: "/合集/第1集.mkv" }] }), "第1集.mkv");
});

test("nameFromShare：非法字符要清掉、不能带出路径分隔符（否则会建出多余的目录层）", () => {
  assert.equal(protocol.nameFromShare({ file_list: [{ isdir: 0, server_filename: "a/b:c*d?e\"f<g>h|i.mkv" }] }), "a b c d e f g h i.mkv");
  assert.equal(protocol.nameFromShare({ file_list: [{ isdir: 0, server_filename: "  多余   空格.mkv  " }] }), "多余 空格.mkv");
  assert.ok(protocol.nameFromShare({ file_list: [{ isdir: 0, server_filename: "长".repeat(200) }] }).length <= 60);
});

test("nameFromShare：拿不到名字时返回空串（调用方据此退回序号兜底，而不是建个叫 undefined 的目录）", () => {
  assert.equal(protocol.nameFromShare({}), "");
  assert.equal(protocol.nameFromShare(null), "");
  assert.equal(protocol.nameFromShare({ file_list: [] }), "");
});

test("processOne：目标文件夹用真实资源名，且**公共目录层只建一次**（写请求是限流的触发点）", async () => {
  const jar = new protocol.Jar("B", "");
  const msets = {
    "1aaaaaaaaaa": JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
      file_list: [{ fs_id: 7, isdir: 0, size: 100, server_filename: "星际穿越.mkv", path: "/星际穿越.mkv" }] }),
    "1bbbbbbbbbb": JSON.stringify({ errno: 0, shareid: "111", uk: "222", bdstoken: "bt",
      file_list: [{ fs_id: 8, isdir: 0, size: 100, server_filename: "流浪地球2.mp4", path: "/流浪地球2.mp4" }] }),
  };
  const createPaths = [];
  const created = new Set();
  const fetchImpl = async (url, init) => {
    if (url.includes("/share/verify")) return fakeResponse({ errno: 0, randsk: "r" });
    for (const code of Object.keys(msets)) {
      if (url.includes("/s/" + code)) return fakeResponse(`<script>locals.mset(${msets[code]});</script>`);
    }
    if (url.includes("/api/create")) {
      createPaths.push(decodeURIComponent(String(init.body).replace(/^path=/, "").replace(/&isdir=1$/, "")));
      return fakeResponse({ errno: 0 });
    }
    if (url.includes("/share/transfer")) return fakeResponse({ errno: 0, extra: { list: [{ to: "/x/y.mkv" }] } });
    return fakeResponse({});
  };
  const parent = "/来自资源批量转存/测试组2/搜资源_x";
  await withFetch(fetchImpl, async () => {
    // 第一条：公共层（转存根/账号/资源表）+ 资源名那一层，都要建
    await protocol.processOne(jar, { link: "https://pan.baidu.com/s/1aaaaaaaaaa", pwd: "ab12", destParent: parent, fallbackName: "00001", createdDirs: created });
    assert.ok(createPaths.includes(`${parent}/星际穿越.mkv`), `目标文件夹应是真实资源名，实际建了：${JSON.stringify(createPaths)}`);
    assert.ok(!createPaths.some((p) => /00001/.test(p)), "不该再出现序号");

    // 第二条（同批同账号、**另一条分享**）：公共三层已在缓存里，只该建自己那层
    createPaths.length = 0;
    await protocol.processOne(jar, { link: "https://pan.baidu.com/s/1bbbbbbbbbb", pwd: "ab34", destParent: parent, fallbackName: "00002", createdDirs: created });
    assert.deepEqual(createPaths, [`${parent}/流浪地球2.mp4`],
      `第二条只该建自己那层（公共层已在缓存里），实际：${JSON.stringify(createPaths)}`);
  });
});

