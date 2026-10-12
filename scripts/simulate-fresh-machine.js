"use strict";

/**
 * 新电脑模拟器：把「新电脑 git clone 下来会看到的样子」复刻到一个临时目录，让测试跑在那儿。
 *
 * 为什么需要它：
 *   本仓库所有脚本的运行时数据都落在 `<仓库>/运行缓存/`，而它被 `.gitignore` 忽略 ——
 *   也就是说 **新电脑 clone 下来根本没有这个目录**。「我在本机跑得好好的」完全不能证明
 *   换台机器还能跑。本脚本把仓库源码树原样复制到临时目录，但**不复制**：
 *     · `运行缓存/`（新电脑上它不存在，这正是要模拟的前提）
 *     · `dist/`（构建产物，不进 git）
 *     · `.git/`（顺带模拟「没有 git 命令可用」的环境）
 *   然后把 `node_modules` 用 junction 链过去，等价于「新机器上已经 `npm install` 过了」。
 *
 * 用法：
 *   node scripts/simulate-fresh-machine.js          # 只搭环境，打印下一步该跑什么
 *   node scripts/simulate-fresh-machine.js --run    # 搭好环境后直接在里面跑单元测试
 *   node scripts/simulate-fresh-machine.js --keep   # 跑完保留临时目录（方便进去手查）
 *
 * 已知限制（实测，别踩）：
 *   · 本机沙箱**只禁止「带管道 stdio」的子进程**（`{encoding:"utf8"}` 或默认的 pipe） ——
 *     `spawnSync(process.execPath, ["-e","0"], {encoding:"utf8"})` → `status=null, code:'EBUSY'`；
 *     换成 `stdio:"inherit"`（或 `["ignore","ignore","ignore"]`）就正常跑。
 *     `execSync` 因为走 cmd.exe + 管道，也一律 EBUSY（连 `git ls-files` 都跑不了）。
 *     本脚本 `--run` 用的是 `stdio:"inherit"`，所以在沙箱里也能跑；
 *     但**测试里不能靠 spawn 抓输出**（抓输出就要管道），要查语法请用 `new vm.Script`。
 *   · `node --test <目录>` 在本机 Node 22.22.2 上会被当成模块去 require（报 MODULE_NOT_FOUND）；
 *     要用 `node --test <文件>` 或 `node --test "<glob>"`（Node 自己展开 glob，不用 shell）。
 *   · 复制的是**工作区**内容（含未提交改动），不是 git HEAD。想测某个提交，
 *     请先 `git stash` 或另做一份 checkout。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
// 运行数据目录的名字从 data-dir.js 拿，不在这再写一遍字面量：
// 一是避免"改目录名要满仓 grep"，二是 B1 守卫会扫出「谁自己拼运行缓存路径」。
const { DATA_DIR_NAME } = require("../electron/src/data-dir");

const root = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const wantRun = argv.includes("--run");
const wantKeep = argv.includes("--keep");

// 这几个目录不进副本：本地数据 / 构建产物 / git 元数据。
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", DATA_DIR_NAME]);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

const dest = fs.mkdtempSync(path.join(os.tmpdir(), "zhidao-fresh-clone-"));
console.log("═══ 新电脑模拟 ═══");
console.log("模拟目录：", dest);

copyTree(root, dest);
console.log("源码树已复制（已排除 node_modules / dist / .git / 运行缓存）");

// node_modules 用 junction 链过去：Windows 上建目录 junction 不需要管理员权限。
const nm = path.join(root, "node_modules");
if (fs.existsSync(nm)) {
  try {
    fs.symlinkSync(nm, path.join(dest, "node_modules"), "junction");
    console.log("node_modules → junction 已挂（等价于新机器上装过依赖了）");
  } catch (e) {
    console.log("node_modules 挂不上（" + e.code + "），请在那个目录里手动 npm install");
  }
} else {
  console.log("本仓库没有 node_modules —— 副本里也一样，请先 npm install");
}

// ── 体检：这几个「应该为假」的东西到底在不在 ──
const checks = [
  [`${DATA_DIR_NAME}/ 不存在（新电脑本来就没有）`, !fs.existsSync(path.join(dest, DATA_DIR_NAME))],
  [".git 不存在（脚本不该依赖 git 命令）", !fs.existsSync(path.join(dest, ".git"))],
  ["src 到了", fs.existsSync(path.join(dest, "electron", "src"))],
  ["tests 到了", fs.existsSync(path.join(dest, "tests", "unit"))],
  ["renderer/index.html 到了（契约测试要读它）", fs.existsSync(path.join(dest, "electron", "renderer", "index.html"))],
  ["tests/fixtures/*.html 到了（爬虫测试要读）", fs.existsSync(path.join(dest, "tests", "fixtures", "search-result-page.html"))],
];
let bad = 0;
for (const [label, ok] of checks) {
  console.log(ok ? "  ✓ " : "  ✗ ", label);
  if (!ok) bad += 1;
}

const TEST_GLOB = "tests/unit/*.test.js";
const runCmd = `node --test "${TEST_GLOB}"`;

if (!wantRun) {
  console.log("\n环境就绪。下一步在里面跑测试：");
  console.log(`  cd "${dest}" && ${runCmd}`);
  console.log("（加 --run 可以让本脚本替你跑；--keep 保留这个目录）");
  process.exit(bad ? 1 : 0);
}

console.log("\n── 在副本里跑单元测试 ──");
// 注意：用 **glob** 而不是目录。`node --test tests/unit` 在本机 Node 上会被当成模块 require。
// 也不用 shell（spawn 直接传 argv），Node 的测试运行器自己会展开 glob。
const r = spawnSync(process.execPath, ["--test", TEST_GLOB], { cwd: dest, stdio: "inherit" });
if (r.error) {
  // 带管道 stdio 的 spawn 在本机会 EBUSY —— 降级成打印命令，让人工去跑
  console.log("\n⚠️ 起不了子进程（" + r.error.code + "）。若换了 stdio 仍是 EBUSY，请手动执行：");
  console.log(`  cd "${dest}" && ${runCmd}`);
  process.exit(2);
}
console.log("\n测试退出码：", r.status);
if (!wantKeep && r.status === 0) {
  try { fs.rmSync(dest, { recursive: true, force: true }); console.log("临时目录已清理（--keep 可保留）"); } catch { /* 占用了就算了 */ }
} else {
  console.log("临时目录保留：", dest);
}
process.exit(r.status === 0 && bad === 0 ? 0 : 1);
