"use strict";

/**
 * 第 5 轮（一键全自动编排层）回归用例。
 * 编排本身的行为在 auto-pipeline.test.js 里覆盖，这里放**顺带发现**的、不属于编排的那些缺陷。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Config } = require("../../electron/src/config");
const { Store } = require("../../electron/src/storage/store");
const excel = require("../../electron/src/storage/excel");
const { parseEnvList } = require("../../electron/src/tasks/batch-transfer");
const { runSubmitTask } = require("../../electron/src/tasks/submit");
const { randomPickQuestions } = require("../../electron/src/tasks/random-pick");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-r5-"));

test("「任务总量上限」填 0 必须真的表示「不限」—— 界面这么写、爬题也这么判，唯独设置层把它夹成了 1", () => {
  // 现场：一键全自动跑到爬题阶段，日志说"已达「任务总量上限」1 道题，停止爬取"。
  // 界面标签写着「0=不限」，crawl.js 也是 `maxQuestions > 0` 才算上限，
  // 但 normalizeSettings 的下限是 1 —— 用户填 0 就静默变成 1，不报错也看不出来。
  const dir = tempDir();
  try {
    const config = new Config(dir);
    const saved = config.save({ maxQuestions: 0 });
    assert.equal(saved.maxQuestions, 0, "0 应该原样保留（= 不限）");
    assert.equal(config.load().maxQuestions, 0, "重新读出来也该是 0");

    // 其它值照旧：正常值不被改动，超过上限仍被夹住
    assert.equal(config.save({ maxQuestions: 30 }).maxQuestions, 30);
    assert.equal(config.save({ maxQuestions: 999999 }).maxQuestions, 100000);
    assert.equal(config.save({ maxQuestions: "abc" }).maxQuestions, 20, "非法值回退默认 20");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("环境名解析：空格/全角逗号/换行/{label} 写法都要吃得住", () => {
  // 现场：以前这里只是 `Array.isArray ? 原样 : String(x).split(",")`，既不 trim 也不认 {label}。
  // `"账号1, 账号2"`（逗号后带空格，用户手写很常见）会得到名字 `" 账号2"` ——
  // 取不到已存的 Cookie、也匹配不上比特环境（要求名字一字不差），
  // 最后报出来的是「没有任何窗口具备 pan.baidu.com 登录态」，完全看不出真凶是一个空格。
  assert.deepEqual(parseEnvList({ bitEnvs: "账号1, 账号2" }), ["账号1", "账号2"]);
  assert.deepEqual(parseEnvList({ bitEnvs: "账号1，账号2" }), ["账号1", "账号2"], "全角逗号");
  assert.deepEqual(parseEnvList({ bitEnvs: "账号1\n账号2\r\n账号3" }), ["账号1", "账号2", "账号3"], "换行分隔");
  assert.deepEqual(parseEnvList({ bitEnvs: " 账号1 ,, 账号2 , " }), ["账号1", "账号2"], "空项要剔掉");
  assert.deepEqual(parseEnvList({ bitEnvs: [{ label: "账号1" }, { name: "账号2" }] }), ["账号1", "账号2"], "{label}/{name} 写法");
  assert.deepEqual(parseEnvList({ bitEnvs: ["账号1", " 账号2 "] }), ["账号1", "账号2"], "数组也要 trim");

  // 单账号兼容字段
  assert.deepEqual(parseEnvList({ bitEnv: "账号1" }), ["账号1"]);
  // bitEnvs 为空字符串时回落到 bitEnv（老调用方可能传空串）
  assert.deepEqual(parseEnvList({ bitEnvs: "", bitEnv: "账号1" }), ["账号1"]);
  // 空数组 = 明确什么都没给（不是"回落到 bitEnv"）
  assert.deepEqual(parseEnvList({ bitEnvs: [], bitEnv: "账号1" }), []);
  // 什么都没给
  assert.deepEqual(parseEnvList({}), []);
  assert.deepEqual(parseEnvList(null), []);
});

// ---------- 存储层：落盘失败不能静默，也不能连累别的文件 ----------

test("flushAll：一个文件写失败不能连累其它文件，也不向上抛（否则跑完的任务会被报成失败）", () => {
  const dir = tempDir();
  const store = new Store(dir, { owner: "r5" });
  try {
    store.bank = [{ title: "题1" }];
    store.answers = [{ title: "题1", status: "已提交" }];
    // 把 bank 的目标路径变成一个**目录** -> 落盘时 renameSync 必然失败
    fs.mkdirSync(path.join(dir, "bank.json"), { recursive: true });

    let failed = null;
    assert.doesNotThrow(() => { failed = store.flushAll(); }, "不该把异常抛给调用方");
    assert.equal(failed.length, 1, `应报告 1 个失败，实际 ${JSON.stringify(failed)}`);
    assert.equal(failed[0].name, "bank");

    const written = JSON.parse(fs.readFileSync(path.join(dir, "answers.json"), "utf8"));
    assert.equal(written.length, 1, "bank 写失败不该让 answers 也不写（以前是中途抛出，后面的全跳过）");
  } finally {
    store.stopLockHeartbeat();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flushAll：全部正常时返回空数组（调用方据此判断有没有东西没落盘）", () => {
  const dir = tempDir();
  const store = new Store(dir, { owner: "r5" });
  try {
    store.bank = [{ title: "题1" }];
    assert.deepEqual(store.flushAll(), []);
  } finally {
    store.stopLockHeartbeat();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("心跳不会抢走别的写入者的锁 —— 抢了就等于把「另一个写入者」的警告永久关掉", () => {
  const dir = tempDir();
  let store = null;
  try {
    // 造假：另一个**活着的**进程（用父进程 pid）持有锁
    const lockFile = path.join(dir, ".store.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, owner: "script", at: Date.now() }));
    store = new Store(dir, { owner: "gui" });
    assert.ok(store.foreignWriter, "构造时就应该发现外来写入者");

    store.heartbeatTick();   // 30 秒后真实心跳会做的事
    const after = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(after.pid, process.ppid, "心跳把锁改写成自己了 —— 对方的警告从此消失");
    assert.ok(store.detectForeignWriter(), "任务启动前的复查也必须仍然看得见对方");
  } finally {
    if (store) store.stopLockHeartbeat();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 质检结论：从生成一路带到提交 ----------

test("表格往返：生成时写进「质检」列的结论必须能读回来", () => {
  // answerToRow 一直在写「质检」列，importRowToAnswer 却从来没读过 ——
  // 于是"判为需复核"的结论一进表格就丢了，提交流程完全看不到它。
  const row = excel.answerToRow({ title: "标题", questionUrl: "https://x/1", answer: "回答", quality: "REVIEW(15)：含 AI 痕迹" });
  const back = excel.importRowToAnswer(row);
  assert.equal(back.quality, "REVIEW(15)：含 AI 痕迹", "质检列必须被读回");
  assert.equal(back.answer, "回答", "其它列不受影响");
  // 老表格没有「质检」列时给空串，不是 undefined
  assert.equal(excel.importRowToAnswer({ 标题: "t", 回答内容: "a" }).quality, "");
});

test("提交：不勾「跳过需复核」时，REVIEW 的条数与原因必须报出来（否则用户永远不知道）", async () => {
  const rows = [
    { title: "题A", questionUrl: "https://zhidao.baidu.com/question/1", answer: "答案一（够长够长够长够长）", quality: "READY(90)" },
    { title: "题B", questionUrl: "https://zhidao.baidu.com/question/2", answer: "答案二（够长够长够长够长）", quality: "REVIEW(15)：含 AI 痕迹、答非所问" },
  ];
  const logs = [];
  const deps = {
    store: { upsertAnswer: () => {} },
    config: { load: () => ({ skipReviewAnswers: false }) },
    log: (m) => logs.push(m),
    copy: async () => {},
  };
  // 不传 bitEnvs：任务会在"没有账号"处停下，但质检告警在那之前就该打出来
  await assert.rejects(() => runSubmitTask({ payload: { results: rows, checkCompletedEnvs: false }, shouldStop: () => false, livePayload: () => ({ results: rows }), delay: async () => {}, report: () => {}, emitItem: () => {} }, deps));

  const text = logs.join("\n");
  assert.match(text, /1 条被质检判为「需复核」/, `应报出条数：\n${text}`);
  assert.match(text, /含 AI 痕迹/, "应报出原因");
  assert.match(text, /仍会照常提交/, "必须说明它们不会被自动跳过（否则用户以为拦下了）");
});

test("提交：勾了「跳过需复核」时，REVIEW 的行一条都不提交", async () => {
  const rows = [
    { title: "题B", questionUrl: "https://zhidao.baidu.com/question/2", answer: "答案二（够长够长够长够长）", quality: "REVIEW(15)：含 AI 痕迹" },
  ];
  const logs = [];
  const deps = {
    store: { upsertAnswer: () => {} },
    config: { load: () => ({ skipReviewAnswers: true }) },
    log: (m) => logs.push(m),
    copy: async () => {},
  };
  const result = await runSubmitTask(
    { payload: { results: rows, checkCompletedEnvs: false }, shouldStop: () => false, livePayload: () => ({ results: rows }), delay: async () => {}, report: () => {}, emitItem: () => {} },
    deps
  );
  assert.equal(result.count, 0);
  assert.equal(result.total, 0, "全部被跳过时应该直接结束，不该再去开窗口");
  assert.match(logs.join("\n"), /跳过/);
});

test("随机抽题：策略名大小写不敏感（否则会出现「报告说按最新抽、实际在乱抽」）", () => {
  const bank = [1, 2, 3, 4, 5].map((i) => ({ title: `题${i}`, questionUrl: `https://x/${i}`, category: "情感类", createdAt: `2026-10-0${i}` }));
  const upper = randomPickQuestions(bank, [], { count: 3, strategy: "Newest" });
  const lower = randomPickQuestions(bank, [], { count: 3, strategy: "newest" });
  assert.equal(upper.strategy, "newest", "返回值早就归一化了");
  assert.deepEqual(upper.picked.map((p) => p.title), lower.picked.map((p) => p.title),
    "实际采样也必须按归一化后的策略走");
});
