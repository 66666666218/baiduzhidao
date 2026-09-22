"use strict";

/**
 * 大批量问答生成器（另一套答题 · 按用户模板）：
 *   资源表（文件名/链接/提取码）→ 逐条套用答题模板 → 三列问答表（qid/问题标题/回答内容）
 *
 * 模板（来源：B202608100524375b57(1).xlsx · 百度知道问答）：
 *   <p><strong>点击链接获取网盘资源：</strong><br/></p>
 *   <p>{链接}<br/></p>
 *   <p>简介：{简介}</p>
 *   <img src="" />
 *
 * 质量控制：
 *   - 命名解析：标准四段/[名][年][类型]/点分体/英文名 混合格式 → 抽取 名称/年份/类型/国家
 *   - 剔除：压缩包(.rar/.zip)、脏行（链接列为"链接"）、重复链接、超长名
 *   - 标题：多模板轮换 + 5~49 字硬校验 + 全局查重
 *   - 简介：按 元数据规则化生成（年份/国家/类型），200 字内
 *
 * 用法：node scripts/mass-qa-template.js <资源表.xlsx> [输出目录] [每文件行数=5000] [--no-img]
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

// ---------- 参数 ----------
const srcFile = process.argv[2] && !process.argv[2].startsWith("--")
  ? path.resolve(process.argv[2]) : null;
const outDir = process.argv[3] && !process.argv[3].startsWith("--")
  ? path.resolve(process.argv[3]) : path.join(__dirname, "..", "运行缓存", "答题模板QA");
const chunkRows = Math.max(100, Number(process.argv[4]) || 5000);
const keepImg = !process.argv.includes("--no-img");

if (!srcFile || !fs.existsSync(srcFile)) {
  console.error("用法: node scripts/mass-qa-template.js <资源表.xlsx> [输出目录] [每文件行数=5000] [--no-img]");
  process.exit(1);
}

// ---------- 命名解析 ----------
const GENRE_DESC = {
  "剧情": "叙事扎实，人物刻画细腻",
  "喜剧": "笑点密集，轻松解压",
  "动作": "打斗场面凌厉，节奏紧凑",
  "爱情": "情感细腻动人",
  "科幻": "设定宏大，视效出众",
  "悬疑": "反转不断，全程高能",
  "惊悚": "氛围紧张，扣人心弦",
  "恐怖": "气氛压迫，胆大者入",
  "战争": "场面宏大，历史厚重",
  "犯罪": "黑色题材，张力十足",
  "动画": "画面精美，老少皆宜",
  "奇幻": "想象力丰富",
  "古装": "服化道考究",
  "武侠": "江湖恩怨，快意恩仇",
  "家庭": "温情治愈",
  "传记": "还原真实人物命运",
  "历史": "史诗质感",
  "音乐": "声画俱佳",
  "运动": "热血励志",
  "冒险": "一路高燃",
};
const KNOWN_GENRES = Object.keys(GENRE_DESC).concat(["灾难", "西部", "同性", "歌舞", "情色", "黑色电影"]);
const REGIONS = ["中国大陆", "内地", "国产", "香港", "台湾", "美国", "英国", "日本", "韩国", "法国", "德国", "泰国", "印度", "俄罗斯", "意大利", "西班牙", "加拿大", "澳大利亚", "新西兰", "斯洛伐克", "捷克", "比利时", "丹麦", "瑞典", "挪威", "芬兰", "波兰", "荷兰", "葡萄牙", "希腊", "土耳其", "伊朗", "阿根廷", "巴西", "墨西哥", "欧盟"];

/** 判断剧集类型：先剔除"剧情"这个类型词再找"剧"，避免电影被误判 */
function detectKind(name, genres) {
  const text = (name + genres.join("")).replace(/剧情/g, "");
  if (/动漫|动画|番/.test(text)) return "动漫";
  if (/纪录/.test(text)) return "纪录片";
  if (/日剧|韩剧|美剧|泰剧|港剧|国产剧|台剧|电视剧|连续剧|网剧/.test(text)) return "剧集";
  return "电影";
}

/**
 * 从混合命名格式抽取 { title, year, genres, country, kind }
 * 支持：[浪潮][2024][剧情惊悚][斯洛伐克捷克] / 火影.ほかげ.2023.1080p中日字幕 /
 *       午后乐事 Afternoon Delight (2013) / [爱情真善美][2011][国产剧]
 */
function parseName(raw) {
  let name = String(raw || "").trim();
  const yearMatch = name.match(/(19\d{2}|20\d{2})/);
  const year = yearMatch ? yearMatch[1] : "";

  // 段式：抓所有 [..] 段
  const segs = [...name.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  let title = "";
  let genres = [];
  let country = "";
  if (segs.length >= 2) {
    // 第一个段当名称（跳过纯年份段）
    title = segs.find((s) => !/^(19\d{2}|20\d{2})$/.test(s.trim())) || segs[0];
    for (const s of segs.slice(1)) {
      if (/^(19\d{2}|20\d{2})$/.test(s.trim())) continue;
      const dramaRegion = { "日剧": "日本", "韩剧": "韩国", "美剧": "美国", "泰剧": "泰国", "港剧": "香港", "台剧": "台湾" };
      const dr = Object.keys(dramaRegion).find((k) => s.includes(k));
      const hitRegions = REGIONS.filter((r) => s.includes(r));
      const hitGenres = KNOWN_GENRES.filter((g) => s.includes(g));
      if (dr) country = dramaRegion[dr];
      else if (hitRegions.length && !hitGenres.length) country = hitRegions.join("");
      else if (hitGenres.length) genres.push(...hitGenres);
    }
  } else {
    // 点分体/自由体：去掉技术标签段后取首段
    const parts = name.split(/[.·]/).map((s) => s.trim()).filter(Boolean);
    const tech = /(1080|720|2160|4k|hdr|WEB-?DL|BluRay|HDTV|x26[45]|高清|字幕|官方中字|中字|熟肉|完整版|全集|更新)/i;
    title = (parts.find((p) => !tech.test(p) && !/^(19\d{2}|20\d{2})$/.test(p)) || parts[0] || name).replace(/\((19\d{2}|20\d{2})\)\s*/g, "").trim();
    // 英文名 "午后乐事 Afternoon Delight" 保留全部（中英混排是资源名的一部分）
    for (const p of parts) {
      const y = p.match(/(19\d{2}|20\d{2})/);
      if (y && !country) { /* 年份段跳过 */ }
    }
  }
  // 兜底：无段式时从原名抽类型词
  const genreWords = Object.keys(GENRE_DESC).filter((g) => name.includes(g));
  if (!genres.length && genreWords.length) genres = genreWords;
  const kind = detectKind(name, genres);

  // 清理标题：去括号残留/扩展名/技术词
  title = title
    .replace(/\.(rar|zip|7z|mp4|mkv|avi|ts|txt|pdf|jpg)$/i, "")
    .replace(/\[|\]/g, "")
    .replace(/\b(1080p|720p|2160p|4K|HDR|WEB-?DL|BluRay|HDTV|x26[45])\b/gi, "")
    .replace(/(高清|官方中字|中日字幕|中英双字|中字|熟肉|国语中字|更新至.*?集|全\d+集|全\d+\+\d*集?)/g, "")
    .replace(/[.·]{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (title.length > 40) title = title.slice(0, 40).replace(/[\s.·]+$/, "");
  return { title, year, genres, country, kind };
}

// ---------- 质量门槛 ----------
const AD_PATTERNS = /微信号|加微信|VX[:：]?|公众号|二维码|代下|有偿|收费|付费获取|联系QQ|加群|引流|广告|www\./i;
const BAD_EXT = /\.(rar|zip|7z|tar|gz)$/i;
function reject(rawName, link) {
  const n = String(rawName || "").trim();
  if (!n) return "空名称";
  if (BAD_EXT.test(n)) return "压缩包（SOP禁止）";
  if (AD_PATTERNS.test(n)) return "含广告词";
  if (!/^https:\/\/pan\.baidu\.com\/s\/[\w-]+\?pwd=[a-z0-9]{4}$/i.test(String(link || "").trim())) return "链接格式无效或缺提取码";
  if (n.length > 60) return "名称过长";
  return "";
}

// ---------- 标题生成（多模板轮换，5~49 字） ----------
const TITLE_PATTERNS = [
  (t, y, k) => `哪里有${t}${y}${k === "剧集" ? "电视剧" : "电影"}的百度云资源分享`,
  (t, y) => `求${t}${y}完整版网盘资源下载`,
  (t, y, k) => `${t}${y}${k === "剧集" ? "全集中文" : "高清完整版"}网盘链接哪里找`,
  (t) => `谁有${t}的网盘资源啊 求分享`,
  (t, y) => `${t}${y}在线看和网盘下载地址`,
  (t, y, k) => `求${t}${y}${k === "动漫" ? "动漫全集" : k === "剧集" ? "电视剧全集" : "电影高清"}百度网盘`,
  (t) => `${t}网盘资源获取 完整版`,
  (t, y) => `哪里能下到${t}${y}的完整资源`,
];
function buildTitle(meta, idx) {
  const { title, year, kind } = meta;
  const fn = TITLE_PATTERNS[idx % TITLE_PATTERNS.length];
  let t = fn(title, year, kind);
  if (t.length > 49) t = t.slice(0, 49);
  if (t.length < 5) t = `求${title}网盘资源`.slice(0, 49);
  return t;
}

// ---------- 简介生成（200 字内，按元数据规则化） ----------
function buildIntro(meta) {
  const { title, year, genres, country, kind } = meta;
  const uniqGenres = [...new Set(genres)].slice(0, 2);
  const genreText = uniqGenres.join("");
  const desc = uniqGenres.map((g) => GENRE_DESC[g]).filter(Boolean).slice(0, 2).join("，");
  const regionText = country || (REGIONS.find((r) => title.includes(r)) || "");
  const yearText = year ? `${year}年` : "";
  const kindText = kind === "剧集" ? "剧集" : kind === "动漫" ? "动漫作品" : kind === "纪录片" ? "纪录片" : "电影";
  const lines = [
    `《${title}》是${yearText}${regionText ? regionText + "出品的" : ""}${genreText ? genreText + "题材的" : ""}${kindText}。`,
    desc ? `整体${desc}。` : "",
    `这部${kindText}${year ? "自" + year + "年推出以来" : ""}关注度不错，适合喜欢${uniqGenres.length ? uniqGenres.join("、") + "题材" : "好故事"}的观众。`,
    `本次整理的是${title}的完整版资源，链接含提取码，打开即可保存观看。`,
  ];
  return lines.filter(Boolean).join("").slice(0, 200);
}

// ---------- 组装 ----------
function buildAnswerHtml(link, intro, keepImg) {
  const parts = [
    "<p><strong>点击链接获取网盘资源：</strong><br/></p>",
    `<p>${link}<br/></p>`,
    `<p>简介：${intro}</p>`,
  ];
  if (keepImg) parts.push('<img src="" />');
  return parts.join("\n");
}

// ---------- 主流程 ----------
(async () => {
  const wb = XLSX.readFile(srcFile);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  console.log(`读取 ${raw.length} 行（工作表: ${wb.SheetNames[0]}）`);

  const seenLinks = new Set();
  const seenTitles = new Set();
  const qaRows = [];
  const rejected = [];
  let titleIdx = 0;

  for (const row of raw) {
    const keys = Object.keys(row);
    const name = String(row[keys[0]] || "").trim();
    const link = String(row[keys[1]] || "").trim();
    const bad = reject(name, link);
    if (bad) { rejected.push({ name: name.slice(0, 30), reason: bad }); continue; }
    if (seenLinks.has(link)) { rejected.push({ name: name.slice(0, 30), reason: "重复链接" }); continue; }

    const meta = parseName(name);
    if (!meta.title || meta.title.length < 2) { rejected.push({ name: name.slice(0, 30), reason: "名称解析失败" }); continue; }

    let title = buildTitle(meta, titleIdx);
    let tries = 0;
    while (seenTitles.has(title) && tries < TITLE_PATTERNS.length) {
      titleIdx += 1;
      title = buildTitle(meta, titleIdx);
      tries += 1;
    }
    if (seenTitles.has(title)) { title = `${title} ${link.slice(-4)}`.slice(0, 49); }
    seenLinks.add(link);
    seenTitles.add(title);
    titleIdx += 1;

    qaRows.push({
      "qid": "",
      "问题标题": title,
      "回答内容": buildAnswerHtml(link, buildIntro(meta), keepImg),
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const chunks = Math.ceil(qaRows.length / chunkRows);
  for (let c = 0; c < chunks; c += 1) {
    const part = qaRows.slice(c * chunkRows, (c + 1) * chunkRows);
    const ws = XLSX.utils.json_to_sheet(part, { header: ["qid", "问题标题", "回答内容"] });
    const wbout = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbout, ws, "百度知道问答");
    const file = path.join(outDir, `问答-第${c + 1}批-${part.length}条.xlsx`);
    XLSX.writeFile(wbout, file);
    console.log(`  已写出 ${path.basename(file)}`);
  }

  console.log("=== 生成完成 ===");
  console.log(`合格: ${qaRows.length} | 剔除: ${rejected.length}`);
  const reasonCount = {};
  for (const r of rejected) reasonCount[r.reason] = (reasonCount[r.reason] || 0) + 1;
  console.log("剔除分布:", JSON.stringify(reasonCount));
  console.log(`输出目录: ${outDir}`);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 160)); process.exit(1); });
