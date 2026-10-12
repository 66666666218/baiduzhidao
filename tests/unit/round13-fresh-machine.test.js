"use strict";

/**
 * 第 13 轮：**模仿「新电脑」环境**的体检 + 我惯踩的坑的机械守卫。
 *
 * 为什么单开一轮、且要专门模拟新电脑：
 *   本仓库所有脚本的数据都写在 `<repo>/运行缓存/`，而它被 `.gitignore` 忽略 ——
 *   **新电脑 git clone 下来根本没有这个目录**。于是「本机跑得好好的」这件事
 *   完全不能证明换台机器还能跑。本文件要回答的就是：新电脑上，这些脚本
 *   ① 会不会一打开就崩；② 报错能不能照着做；③ 会不会读错地方。
 *
 * **本文件一个子进程都不起**（这条很重要，见 D5）：
 *   本机沙箱里 `child_process.spawnSync` / `execSync` 一律 EBUSY —— 实测连
 *   `git ls-files` 都跑不起来（`status=null, code:'EBUSY'`）。所以：
 *   · 语法检查用 `new vm.Script(src)`（**只编译不执行**，不起进程）；
 *   · 文件清单用 `fs.readdirSync` 自己递归；
 *   · 「git 追踪了哪些文件」这件事不用 git，改成扫全部 .js 再排除构建产物 —— 更严也更稳。
 *
 * 本轮真抓到并修掉的一个线上级 bug（写在这里当活教材）：
 *   `scripts/workbench-upload.js` 在第 14 行调了 `resolveDataDir(root)`，而它的
 *   `require` 被我接线时漏在了第 20 行 → 整个脚本一跑就
 *   `ReferenceError: Cannot access 'resolveDataDir' before initialization`（const 暂时性死区）。
 *   **`node --check` 查不出来**（语法合法），`契约⑥` 也没覆盖到。D1 就是为它立的。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// ─────────────── 文件清单（不依赖 git / 不起子进程） ───────────────

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "mock-site", "site", "docs", ".github", "运行缓存",
]);

/** 递归收集 .js，返回相对 root 的 posix 风格路径 */
function walkJs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue; // .git / .github / .gitignore …
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.name.endsWith(".js")) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

const ALL_JS = walkJs(root, []);
/** 生产代码 = 会上机器跑的（electron/ + scripts/），测试夹具允许写假绝对路径 */
const PROD_JS = ALL_JS.filter((f) => f.startsWith("electron/") || f.startsWith("scripts/"));

/**
 * 剥注释但**保留字符串**、且**逐字符保留换行**（注释字符换成空格）——
 * 行号不漂，才能拿它做「行号先后」判断（D1）。
 * 这是 round11 `stripComments` 的「保换行」变体；那个版本会把块注释里的换行一起吃掉。
 */
function blankComments(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i += 1;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "\n") break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") { out[i] = " "; i += 1; } continue; }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] !== "\n") out[k] = " ";
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * 注释**和字符串**都剥掉（保留换行）——判断「名字在代码里被用到没有」时必须用它：
 * 名字出现在字符串（测试标题、日志文案）里不算使用。
 */
function blankAll(src) {
  return blankComments(src).split(/\r?\n/).map((l) =>
    l.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, (m) => " ".repeat(m.length)),
  ).join("\n");
}

// ─────────────── A. 新电脑：数据目录怎么解析、CDP 怎么读 ───────────────

const { resolveDataDir, cdpFilePath, readCdp } = require("../../electron/src/data-dir");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-fresh-"));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } });

/** 临时改 ZHIDAO_DATA_DIR 跑一段，跑完恢复（同进程里别的用例不受污染） */
function withEnvDataDir(value, fn) {
  const saved = Object.prototype.hasOwnProperty.call(process.env, "ZHIDAO_DATA_DIR")
    ? process.env.ZHIDAO_DATA_DIR : undefined;
  if (value === undefined) delete process.env.ZHIDAO_DATA_DIR;
  else process.env.ZHIDAO_DATA_DIR = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.ZHIDAO_DATA_DIR;
    else process.env.ZHIDAO_DATA_DIR = saved;
  }
}

test("A1：默认数据目录 = <root>/运行缓存（纯函数，不碰磁盘、目录不存在也不报错）", () => {
  const fakeRoot = path.join(TMP, "一个不存在的项目");
  withEnvDataDir(undefined, () => {
    assert.equal(resolveDataDir(fakeRoot), path.join(fakeRoot, "运行缓存"));
  });
});

test("A2：ZHIDAO_DATA_DIR 优先；相对路径会 resolve；全空白串当没设", () => {
  withEnvDataDir(path.join(TMP, "自定义目录"), () => {
    assert.equal(resolveDataDir("/项目"), path.join(TMP, "自定义目录"));
  });
  withEnvDataDir("  ", () => {
    assert.equal(resolveDataDir("/项目"), path.join("/项目", "运行缓存"), "空白串必须当没设，否则会落到 cwd");
  });
  withEnvDataDir("rel/子目录", () => {
    assert.equal(resolveDataDir("/项目"), path.resolve("rel/子目录"));
  });
});

test("A3：cdpFilePath = <dataDir>/cdp.txt", () => {
  assert.equal(cdpFilePath(path.join(TMP, "d")), path.join(TMP, "d", "cdp.txt"));
});

test("A4：cdp.txt 不存在 → 抛「能照着做」的错误，不是裸 ENOENT", () => {
  const dir = path.join(TMP, "没连接过比特浏览器");
  assert.throws(() => readCdp(dir), (e) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /比特浏览器/, "要告诉用户去开比特浏览器");
    assert.match(e.message, /ZHIDAO_DATA_DIR/, "要给出改目录的办法");
    assert.ok(!/\bENOENT\b/.test(e.message), "别把裸 ENOENT 丢给用户（新电脑必踩）");
    assert.ok(e.message.includes(path.join(dir, "cdp.txt")), "要点名到底是哪个文件");
    assert.match(e.message, /gitignore|clone|git/i, "要说明这文件本来就不在 git 里");
    return true;
  });
});

test("A5：cdp.txt 存在但是空的 → 另一种错误（细分原因，别跟「没文件」混为一谈）", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "empty-"));
  fs.writeFileSync(path.join(dir, "cdp.txt"), "   \n\r\n", "utf8");
  assert.throws(() => readCdp(dir), (e) => {
    assert.match(e.message, /空/);
    assert.ok(e.message.includes(path.join(dir, "cdp.txt")));
    assert.ok(!/找不到比特浏览器 CDP 端口文件/.test(e.message), "空文件不该报「找不到文件」");
    return true;
  });
});

test("A6：正常端口号会被 trim（末尾换行不能带进 URL）", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "ok-"));
  fs.writeFileSync(path.join(dir, "cdp.txt"), "  9222\r\n", "utf8");
  assert.equal(readCdp(dir), "9222");
  assert.equal(readCdp(dir, path.join(dir, "cdp.txt")), "9222", "显式传 file 也要能用");
});

test("A7：本组用例只在系统临时目录里建文件，绝不碰真实的 运行缓存/", () => {
  assert.ok(TMP.startsWith(os.tmpdir()), "临时目录必须落在 os.tmpdir() 下");
  assert.ok(!TMP.includes(path.join(root, "运行缓存")), "不能污染仓库的 运行缓存/");
});

// ─────────────── B. 全仓：数据目录 / CDP 不再各写各的 ───────────────

test("B1：可执行代码里不再有人自己拼 \"运行缓存\"（只允许 data-dir.js 与 app-context.js）", () => {
  const ALLOWED = new Set(["electron/src/data-dir.js", "electron/app-context.js"]);
  const bad = [];
  for (const f of PROD_JS) {
    if (ALLOWED.has(f)) continue;
    const code = blankComments(read(f));
    if (/path\.(?:join|resolve)\s*\([^)]*["'`]运行缓存/.test(code)) bad.push(f);
  }
  // app-context.js 是**应用内**的取法（打包版走 %APPDATA%），脚本拿不到 app.getPath，
  // 所以它保留自己的分支是合理的；脚本侧必须统一走 resolveDataDir。
  assert.deepEqual(bad, [], "这些文件自己拼了运行缓存路径，会绕过 ZHIDAO_DATA_DIR：\n" + bad.join("\n"));
});

test("B2：读 cdp.txt 只有 readCdp 一个入口", () => {
  const bad = [];
  for (const f of PROD_JS) {
    if (f === "electron/src/data-dir.js") continue;
    const code = blankComments(read(f));
    // 裸的 "cdp.txt"（带头引号）——注意 "panlay-cdp.txt" 是**另一个**文件，不该误判
    if (/["'`]cdp\.txt["'`]/.test(code)) bad.push(`${f}（拼了裸 cdp.txt 路径）`);
    if (/readFileSync\s*\([^)]*cdp\.txt/i.test(code)) bad.push(`${f}（直接 readFileSync 读 cdp）`);
  }
  assert.deepEqual(bad, [], "这些地方绕过了 readCdp，新电脑上会抛裸 ENOENT：\n" + bad.join("\n"));
});

test("B3：用到 resolveDataDir/readCdp 的文件都真的 require 了 data-dir", () => {
  const users = PROD_JS.filter((f) => f !== "electron/src/data-dir.js" && /resolveDataDir|readCdp/.test(read(f)));
  assert.ok(users.length >= 20, `接线面应有 20+ 个脚本，实际 ${users.length} —— 是不是接线被回退了`);
  const bad = users.filter((f) => !/require\s*\(\s*["'][^"']*data-dir["']\s*\)/.test(blankComments(read(f))));
  assert.deepEqual(bad, [], "用了但没 require，运行必 ReferenceError：\n" + bad.join("\n"));
});

test("B4：electron/src/headed-edge-launcher.js 用的 panlay-cdp.txt 是另一个文件，别被 B2 误伤", () => {
  const code = blankComments(read("electron/src/headed-edge-launcher.js"));
  assert.ok(code.includes("panlay-cdp.txt"), "这个文件应该自己管 panlay-cdp.txt（不是 cdp.txt）");
  assert.ok(!/["'`]cdp\.txt["'`]/.test(code), "但它不能碰通用的 cdp.txt");
});

// ─────────────── C. 本机绝对路径不许进生产代码 ───────────────

test("C1：生产代码的可执行部分不得出现本机盘符路径（注释里的参考实现路径允许）", () => {
  // 只认「盘符 + \Users\ 或 \code\」这种真的指向某台机器的绝对路径；
  // 不认 `C:/Program Files/...`（找 Edge/Chrome 的候选路径，本来就该是绝对路径），
  // 也不认 GitHub URL 里的 `.../baiduzhidao/releases`。
  const machinePath = /[A-Za-z]:[\\/]{1,2}(?:Users|code)[\\/]{1,2}/;
  const bad = [];
  for (const f of PROD_JS) {
    const code = blankComments(read(f));
    code.split(/\r?\n/).forEach((line, i) => {
      if (machinePath.test(line)) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], "换台机器这些路径就不存在了：\n" + bad.join("\n"));
});

test("C2：运行缓存/、*.log、cdp*.txt 必须还在 .gitignore 里（否则新电脑 clone 会带一坨本地数据）", () => {
  const gi = read(".gitignore");
  assert.match(gi, /^\s*运行缓存\/\s*$/m, "运行缓存/ 必须忽略");
  assert.match(gi, /^\s*\*\.log\s*$/m, "*.log 必须忽略");
  assert.match(gi, /^\s*node_modules\/\s*$/m);
  // 本轮真抓到：`cdp2.txt` 被误提交进 git，里面写死 `127.0.0.1:57776`。
  // 新电脑 clone 下来会拿到**别人机器**的端口，脚本照着连必然连不上、还很难查。
  // 已 `git rm --cached` 取消追踪，并把 cdp*.txt 加进忽略，这条守卫防止它复活。
  assert.match(gi, /^\s*cdp\*\.txt\s*$/m, "cdp*.txt 必须忽略（机器本地端口文件）");
});

// ─────────────── D. 我惯踩的坑（机械守卫） ───────────────

test("D1：没有「使用早于 require」的 TDZ（本轮真抓到 workbench-upload.js 一例）", () => {
  const bad = [];
  for (const f of ALL_JS) {
    const lines = blankAll(read(f)).split(/\r?\n/);
    const reqLine = new Set();
    const firstDecl = new Map();
    lines.forEach((l, i) => {
      // 只看**列 0** 的顶层解构 require；函数体内 `const {x} = require(...)` 作用域不同，不适用
      const m = l.match(/^const\s*\{([^}]+)\}\s*=\s*require\s*\(/);
      if (!m) return;
      reqLine.add(i + 1);
      for (const raw of m[1].split(",")) {
        const nm = raw.split(":").pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(nm) && !firstDecl.has(nm)) firstDecl.set(nm, i + 1);
      }
    });
    for (const [nm, ln] of firstDecl) {
      const re = new RegExp(`(^|[^\\w$.])${nm}([^\\w$]|$)`);
      for (let i = 0; i < ln - 1; i++) {
        if (reqLine.has(i + 1)) continue; // 别的 require 行里出现同名字符串不算使用
        if (re.test(lines[i])) { bad.push(`${f}:${i + 1} 用了 ${nm}，但 require 在第 ${ln} 行`); break; }
      }
    }
  }
  // 为什么这条不能靠 node --check：TDZ 是**运行时**错误，语法完全合法。
  assert.deepEqual(bad, [], "const 暂时性死区，脚本一跑就 ReferenceError：\n" + bad.join("\n"));
});

test("D2：全仓 .js 都能编译（用 vm.Script，不起子进程）", () => {
  const bad = [];
  for (const f of ALL_JS) {
    try { new vm.Script(read(f), { filename: f }); } catch (e) { bad.push(`${f}: ${e.message}`); }
  }
  assert.deepEqual(bad, [], "语法错误：\n" + bad.join("\n"));
});

test("D3：全仓没有 `? \"\" : \"\"`（两个分支同值的空串分支 = 静默吞数据）", () => {
  const bad = [];
  for (const f of ALL_JS) {
    const code = blankComments(read(f)); // 注释里引用这个反面教材是允许的
    code.split(/\r?\n/).forEach((l, i) => { if (/\?\s*""\s*:\s*""/.test(l)) bad.push(`${f}:${i + 1}`); });
  }
  // 历史：pan-transfer-ui.js 抄 parseLinkCell 时写成 `pwdKey ? "" : ""`，
  // 提取码列永远读不到 → 整表静默跳过、输出「成功 0 失败 0」。
  assert.deepEqual(bad, [], "空串分支：\n" + bad.join("\n"));
});

test("D4：没有函数声明落在 process.exit(0) 之后（永不可达 = 写了等于没写）", () => {
  const bad = [];
  for (const f of PROD_JS) {
    const lines = read(f).split(/\r?\n/);
    const ex = lines.findIndex((l) => /process\.exit\(0\)/.test(l));
    if (ex < 0) continue;
    for (let i = ex + 1; i < lines.length; i++) if (/^\s*(async\s+)?function\s/.test(lines[i])) bad.push(`${f}:${i + 1}`);
  }
  assert.deepEqual(bad, [], "exit(0) 后还有函数声明：\n" + bad.join("\n"));
});

test("D5：测试里不许 spawnSync/execSync 起 node（本机的沙箱会给 EBUSY，随机红）", () => {
  const bad = [];
  for (const f of ALL_JS.filter((x) => x.startsWith("tests/"))) {
    // 先剥注释再判：本文件自己的注释里就引用了这个反面写法（当教材），不该被自己扫到
    const src = blankComments(read(f));
    if (/spawnSync\s*\(\s*process\.execPath/.test(src)) bad.push(`${f}（spawnSync process.execPath）`);
    if (/execSync\s*\(\s*["'`]node\b/.test(src)) bad.push(`${f}（execSync "node ..."）`);
    if (/execFileSync\s*\(\s*process\.execPath/.test(src)) bad.push(`${f}（execFileSync process.execPath）`);
  }
  // 实测：`spawnSync(process.execPath, ["--check", f])` 在本机返回 status=null / EBUSY，
  // 断言会变成随机失败。要查语法请用 `new vm.Script`（见 D2）。
  assert.deepEqual(bad, [], "这些用例在本机会 EBUSY：\n" + bad.join("\n"));
});

test("D6：全仓 .js 无 BOM（BOM 会污染首行、干扰 shebang 与 require 缓存）", () => {
  const bad = ALL_JS.filter((f) => {
    const b = fs.readFileSync(path.join(root, f));
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  });
  assert.deepEqual(bad, []);
});

test("D7：回归——workbench-upload.js 的 require 必须排在使用之前（本轮踩过的原坑）", () => {
  const src = read("scripts/workbench-upload.js");
  const requireLine = src.split(/\r?\n/).findIndex((l) => /require\(["'][^"']*data-dir["']\)/.test(l)) + 1;
  const useLine = src.split(/\r?\n/).findIndex((l) => /resolveDataDir\s*\(/.test(l) && !/require/.test(l)) + 1;
  assert.ok(requireLine > 0 && useLine > 0);
  assert.ok(requireLine < useLine, `require 在第 ${requireLine} 行、使用在第 ${useLine} 行 → 会 ReferenceError`);
});

test("D8：round13 的 A 组自己也得守规矩（不许起子进程去跑 data-dir 的行为）", () => {
  // 同样先剥注释：本文件注释里引用了 spawnSync 当反面教材
  const self = blankComments(read("tests/unit/round13-fresh-machine.test.js"));
  assert.ok(!/require\s*\(\s*["']child_process["']\s*\)/.test(self), "本文件必须纯进程内验证，不许 require child_process");
  assert.ok(!/\b(?:spawn|spawnSync|exec|execSync|execFileSync)\s*\(/.test(self), "不许起子进程");
  assert.ok(/new vm\.Script/.test(self), "语法检查走 vm.Script");
  assert.ok(/fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\)/.test(self), "临时目录必须建在 os.tmpdir()");
});

// ─────────────── E. 新电脑下「打开就崩」的最后一道自检 ───────────────

test("E1：data-dir.js 是唯一有能力把 运行缓存 说清楚的地方，注释里必须留下新电脑这个前提", () => {
  const src = read("electron/src/data-dir.js");
  assert.match(src, /gitignore|clone|新电脑/, "要写清「被 .gitignore 忽略、新电脑没有这个目录」");
  assert.match(src, /ZHIDAO_DATA_DIR/, "要写清覆盖办法");
  // 导出面：三个函数 + 目录名常量（目录名单独导出，免得别处再写一遍字面量）
  assert.match(src, /module\.exports\s*=\s*\{[^}]*\bresolveDataDir\b[^}]*\}/);
  assert.match(src, /module\.exports\s*=\s*\{[^}]*\bcdpFilePath\b[^}]*\}/);
  assert.match(src, /module\.exports\s*=\s*\{[^}]*\breadCdp\b[^}]*\}/);
  assert.match(src, /module\.exports\s*=\s*\{[^}]*\bDATA_DIR_NAME\b[^}]*\}/);
  assert.equal(require("../../electron/src/data-dir").DATA_DIR_NAME, "运行缓存");
});

test("E2：读 data-dir 的脚本数 ≥ 20（接线被回退时立刻发现）", () => {
  const users = ALL_JS.filter((f) => /require\s*\(\s*["'][^"']*data-dir["']\s*\)/.test(read(f)));
  assert.ok(users.length >= 20, `实际只有 ${users.length} 个文件 require data-dir`);
});
