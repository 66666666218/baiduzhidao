"use strict";

/**
 * 发版收尾的三条硬校验（以前每轮都是手敲一段 node -e，还老被 shell 吃掉反斜杠）。
 *
 *   ① `latest.yml` 里的 `sha512` 必须等于本地 exe 实算的 sha512
 *      —— 不等 = 客户端下载完校验失败 = "发了但更新不了"，而且**不报错**，最难查的一类。
 *   ② 三件套（exe / latest.yml / blockmap）的 sha256 **真的去 GitHub 查** `assets[].digest` 逐项比对
 *      —— 比把 85MB 下载回来再算快得多，而且是"上传过程中有没有损坏"唯一的证据。
 *   ③ `latest.yml` 的 `version` 必须等于 package.json 的版本
 *      —— 不 bump 版本号的话，客户端按版本比较会认为"已是最新"（这是老坑，写进 MEMORY 了）。
 *
 * ⚠️⚠️ 2026-10-14 修一个**假守卫**：② 原来是"把本地 sha256 打出来，再打一句
 *   「比对方式：查 GitHub API 的 releases/latest」，最后照样说「三件套指纹都齐了」" ——
 *   也就是**根本没查，却报通过**。这正是本项目反复吃亏的那一类（声明了但没做），
 *   而且比没有校验更糟：它会让人**放心地不去手工核对**。
 *   现在真去查（`https.get`，凭据走环境变量 `GH_TOKEN`）；**查不到就明确说"未校验"，绝不并入"通过"**。
 *
 * 用法：node scripts/verify-release.js      （需要 GH_TOKEN / GITHUB_TOKEN 才能做第②条）
 * 退出码：0 = 全过；1 = 有硬失败
 *
 * ⚠️ 只读、只打印指纹与版本号，**不打印任何仓库地址**（用户明确要求地址不外泄）。
 *   仓库坐标是**运行时现取**（先看 `dist/win-unpacked/resources/app-update.yml`，再看 `.git/config`），
 *   所以这个文件里没有任何仓库坐标可被扫出来。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

const exe = path.join(ROOT, "dist", `zhidao-answer-studio-${version}.exe`);
const yml = path.join(ROOT, "dist", "latest.yml");
const blockmap = `${exe}.blockmap`;

/** 从 latest.yml 里取一个顶格字段（故意不用正则转义，免得又被 shell 吃掉反斜杠） */
function ymlField(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 只认顶格的（files 下面那些是缩进的，不能混进来）
    if (line === trimmed && trimmed.startsWith(`${key}:`)) {
      return trimmed.slice(key.length + 1).trim();
    }
  }
  return "";
}

/**
 * 纯函数：把「线上 release」与「本地三件套指纹」比一遍。
 *
 * 为什么提成纯函数（本项目的老规矩）：比对规则原先写在异步分支里，
 * 守卫只能扫文本 —— 而**扫文本读不出逻辑**（本轮已经因为这条吃过一次亏：
 * 原来那句"与 GitHub 线上逐项比对"根本**没查**，只是把本地哈希打印出来外加一句说明，
 * 守卫照样全绿）。提出来之后，测试可以喂三组假数据直接看结果：
 * 全一致 / 指纹不符 / 资产缺失 / tag 不对。
 */
const compareRelease = ({ version, localDigests, release } = {}) => {
  const failures = [];
  if (!release || typeof release !== "object") {
    return { tagOk: false, failures: ["拿不到线上 release 数据"], checked: {} };
  }
  const expectedTag = `v${version}`;
  const tagOk = release.tag_name === expectedTag;
  if (!tagOk) {
    failures.push(`线上 latest release 是 ${release.tag_name}，不是 ${expectedTag} —— 客户端查更新会拿到旧版`);
  }
  const byName = new Map(
    (release.assets || []).map((a) => [a.name, String(a.digest || "").replace(/^sha256:/, "")])
  );
  const checked = {};
  for (const name of Object.keys(localDigests || {})) {
    const remote = byName.get(name) || "";
    checked[name] = remote;
    if (!remote) failures.push(`线上缺少资产 ${name}（客户端下不到）`);
    else if (remote !== localDigests[name]) {
      failures.push(`线上 ${name} 的 sha256 与本地不一致 —— 上传过程中损坏，或者传上去的是旧文件`);
    }
  }
  return { tagOk, failures, checked };
};

/**
 * 剥掉 yml 值两侧可能带的成对引号。
 *
 * ⚠️ 这里踩过一次（2026-10-14）：`app-update.yml` 里 `owner` 的值**带引号**
 *   （`owner: "66666666218"`，长度 13 而名字只有 11），直接拿去做 URL 路径
 *   → 请求 `repos/"666…"/…` → **HTTP 404**。表现是"查线上失败"，
 *   而真正的原因只是一个引号。
 */
const stripQuotes = (s) => String(s || "").trim().replace(/^["']|["']$/g, "");

const hash = (file, algo) => crypto.createHash(algo).update(fs.readFileSync(file)).digest(algo === "sha512" ? "base64" : "hex");

/**
 * 主流程。
 *
 * 为什么整段包成一个函数（2026-10-14，被自己的守卫抓出来的）：
 * 原先想让"被 require 时不跑主流程"，用的是**模块顶层 `return`** —— CommonJS 下确实合法，
 * 但 `vm.Script(src)`（守卫 D2：全仓 .js 都要能被编译）把它当**脚本**编译，顶层 `return`
 * 是 SyntaxError → 守卫当场红。所以改成函数 + 末尾 `if (require.main === module)` 调用：
 * 既能被 require，又保证"全仓 .js 都能当脚本编译"这条不变。
 */
/**
 * 纯函数：**能不能**去查线上（三种查不了的情形都明说，且都"不算通过"）。
 *
 * 为什么也要提成纯函数：最初这条判断写在 main 的 if/else 里，守卫只能扫文本 ——
 * 而扫文本看不出"到底查没查"（突变把 `fetchLatestRelease` 换成抛异常，测试照样全绿：
 * `https.get` 那几个字还在源码里）。现在"要不要查、为什么查不了"是一句可调用的规则。
 */
const planOnlineCheck = ({ repoCoords, token } = {}) => {
  if (!repoCoords) {
    return { can: false, reason: "  ⚠️ 未校验：取不到仓库坐标（先跑 npm run dist 生成 app-update.yml）。**这一条不算通过**" };
  }
  if (!token) {
    return { can: false, reason: "  ⚠️ 未校验：没有 GH_TOKEN / GITHUB_TOKEN，无法查线上 assets[].digest。**这一条不算通过**" };
  }
  return { can: true, reason: "" };
};

/**
 * 纯函数：结尾那句结论 —— **没查过线上就绝不许说"全部核对"**。
 * 这是"别谎报通过"唯一的一句话，所以它必须可被直接喂参数验证。
 */
const verdictLine = (onlineChecked) =>
  onlineChecked
    ? "\n✅ 发版校验通过（latest.yml sha512 / 版本号 / 线上三件套指纹 全部核对）"
    : "\n✅ 本地校验通过（latest.yml sha512 / 版本号）；⚠️ 线上三件套指纹**未校验**，请人工核对后再宣布发版完成";

const main = () => {
const failures = [];

// ---- 文件在不在 ----
for (const file of [exe, yml, blockmap]) {
  if (!fs.existsSync(file)) failures.push(`缺少产物：${path.relative(ROOT, file)}（先跑 npm run dist）`);
}
if (failures.length) {
  console.error(failures.map((f) => `❌ ${f}`).join("\n"));
  process.exit(1);
}

// ---- ① sha512 必须对得上 ----
const ymlText = fs.readFileSync(yml, "utf8");
const declared = ymlField(ymlText, "sha512");
const actual = hash(exe, "sha512");
console.log(`产物：dist/zhidao-answer-studio-${version}.exe`);
if (declared !== actual) {
  failures.push("latest.yml 的 sha512 与安装包对不上 —— 客户端下载后校验会失败，表现是「发了但更新不了」且不报错");
  console.log("  ✗ sha512 不一致");
  console.log(`      实算：${actual}`);
  console.log(`      yml ：${declared}`);
} else {
  console.log("  ✓ sha512 与 latest.yml 一致");
}

// ---- ③ 版本号必须对得上 ----
const ymlVersion = ymlField(ymlText, "version");
const ymlPath = ymlField(ymlText, "path");
if (ymlVersion !== version) {
  failures.push(`latest.yml 的 version（${ymlVersion}）≠ package.json（${version}）—— 客户端会认为「已是最新」`);
  console.log(`  ✗ 版本号不一致：yml=${ymlVersion} package.json=${version}`);
} else {
  console.log(`  ✓ 版本号 ${version} 一致`);
}
if (ymlPath && ymlPath !== path.basename(exe)) {
  failures.push(`latest.yml 的 path（${ymlPath}）指向的不是这个安装包`);
  console.log(`  ✗ path 字段指向 ${ymlPath}`);
}

// ---- ② 打指纹，并且**真的**去 GitHub 逐项比对 ----
console.log("\n三件套 sha256（与 GitHub 线上 assets[].digest 逐项比对）：");
const localDigests = {};
for (const file of [exe, yml, blockmap]) {
  localDigests[path.basename(file)] = hash(file, "sha256");
  console.log(`  ${localDigests[path.basename(file)]}  ${path.basename(file)}`);
}

/**
 * 取仓库坐标（运行时现取，文件里不留任何地址）。
 * 优先 `app-update.yml`（electron-builder 生成，字段是 `owner:` / `repo:`），
 * 退回 `.git/config` 的 `[remote "origin"] url`。
 * 取值一律过 `stripQuotes`（原因见上面 `stripQuotes` 的注释：引号会让请求变 404）。
 */
function resolveRepo() {
  const updateYml = path.join(ROOT, "dist", "win-unpacked", "resources", "app-update.yml");
  if (fs.existsSync(updateYml)) {
    const text = fs.readFileSync(updateYml, "utf8");
    const owner = stripQuotes(ymlField(text, "owner"));
    const repo = stripQuotes(ymlField(text, "repo"));
    if (owner && repo) return { owner, repo };
  }
  const cfg = path.join(ROOT, ".git", "config");
  if (fs.existsSync(cfg)) {
    const m = fs.readFileSync(cfg, "utf8").match(/github\.com[:/]([^/\s]+)\/([^\s/]+?)(?:\.git)?\s*$/m);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}

/** 查 releases/latest（不打印地址；失败只回错误码/原因） */
function fetchLatestRelease({ owner, repo }, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: "api.github.com",
        path: `/repos/${owner}/${repo}/releases/latest`,
        headers: {
          "User-Agent": "zhidao-answer-studio-release-check",
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("返回不是 JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
  });
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const repoCoords = resolveRepo();
let onlineChecked = false;

(async () => {
  // "能不能查线上"是纯函数（三种查不了的情形都明说且不算通过）
  const plan = planOnlineCheck({ repoCoords, token });
  if (!plan.can) {
    console.log(plan.reason);
  } else {
    try {
      const rel = await fetchLatestRelease(repoCoords, token);
      // 比对规则只有一处：纯函数 compareRelease（测试会直接喂假数据调它）
      const verdict = compareRelease({ version, localDigests, release: rel });
      if (verdict.tagOk) console.log(`  ✓ 线上 latest tag = v${version}`);
      else console.log(`  ✗ 线上最新 tag = ${rel.tag_name}，期望 v${version}`);
      for (const name of Object.keys(localDigests)) {
        const remote = verdict.checked[name];
        if (!remote) console.log(`  ✗ 线上没有 ${name}`);
        else if (remote !== localDigests[name]) {
          console.log(`  ✗ ${name} 指纹不一致（线上 ${remote.slice(0, 8)} vs 本地 ${localDigests[name].slice(0, 8)}）`);
        } else console.log(`  ✓ ${name} 指纹一致`);
      }
      failures.push(...verdict.failures);
      // ⚠️ 只有"确实查过且没查出问题"才算校验过；查出错就交给下面的失败分支，不要谎报通过
      onlineChecked = verdict.failures.length === 0;
    } catch (e) {
      console.log(`  ⚠️ 未校验：查线上 release 失败（${e.message}）。**这一条不算通过**`);
    }
  }

  if (failures.length) {
    console.error(`\n❌ 发版校验未通过：\n${failures.map((f) => `  · ${f}`).join("\n")}`);
    process.exit(1);
  }
  // ⚠️ 结尾只许声明**真的做过**的事：没查线上就不能说"三件套指纹都齐了"
  console.log(verdictLine(onlineChecked));
})();
};

// 纯函数对外可用（测试直接调它们），但**被 require 时不跑主流程**。
module.exports = { compareRelease, stripQuotes, ymlField, planOnlineCheck, verdictLine };
if (require.main === module) main();

