"use strict";

/**
 * 答题模板问答生成器（共享库 · 全量重写版）：
 *   名称解析 / 乱码检测 / 规范化去重键 / 质量门槛 / 标题轮换 / 规则化简介 / 模板 HTML。
 *   供 转存任务、批量上传、各脚本共用。
 */

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

/** 判断剧集类型：先剔除"剧情"再找"剧"；集数特征（1-47完整版/全X集）判为剧集 */
function detectKind(name, genres) {
  const text = (name + genres.join("")).replace(/剧情/g, "");
  if (/\d+\s*[-~]\s*\d+\s*完整版|1-\d+完整版|全\d+集|\d+集完整|第\s*\d+\s*集|更新至\s*\d+\s*集/.test(name)) return "剧集";
  if (/动漫|动画|番/.test(text)) return "动漫";
  if (/纪录/.test(text)) return "纪录片";
  if (/日剧|韩剧|美剧|泰剧|港剧|国产剧|台剧|电视剧|连续剧|网剧/.test(text)) return "剧集";
  // 非影视资源（软件/课程/小说/素材…）不该落到「电影」兜底上——套电影模板会产出
  // 「哪里有XX电影的百度云资源分享」这种文不对题的标题（实测踩过）。
  // 关键词与「分类规则」里的保持一致，避免两处对同一批资源判断不同。
  if (/软件|应用|安卓|apk|绿色版|破解版|激活版|课程|教程|网课|讲义|考研|考证|小说|电子书|有声书|漫画|条漫|素材|模板|字体|插件|源码|资料包|题库|技术|合集|资料/.test(text)) return "资源";
  return "电影";
}

/**
 * 从混合命名格式抽取 { title, year, genres, country, kind }
 */
function parseName(raw) {
  const name = String(raw || "").trim();
  const yearMatch = name.match(/(19\d{2}|20\d{2})/);
  const year = yearMatch ? yearMatch[1] : "";

  const segs = [...name.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  let title = "";
  const genres = [];
  let country = "";
  if (segs.length >= 2) {
    // 优先：括号外剩余文本（真实片名常写在括号外）
    const outside = name.replace(/\[[^\]]*\]/g, " ").replace(/\s{2,}/g, " ").trim();
    const outsideCjk = (outside.match(/[一-龥]/g) || []).length;
    if (outsideCjk >= 2) {
      title = outside;
    } else {
      // 次选：括号内排除 年份/类型/国家 的段
      const usable = segs.filter((x) => !/^(19\d{2}|20\d{2})$/.test(x.trim())
        && !KNOWN_GENRES.some((g) => x.includes(g))
        && !REGIONS.some((r) => x.includes(r))
        && !/剧$|季$/.test(x.trim()));
      title = usable[0] || segs.find((x) => !/^(19\d{2}|20\d{2})$/.test(x.trim())) || segs[0];
    }
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
    const parts = name.split(/[.·]/).map((s) => s.trim()).filter(Boolean);
    const tech = /(1080|720|2160|4k|hdr|WEB-?DL|BluRay|HDTV|x26[45]|高清|字幕|官方中字|中字|熟肉|完整版|全集|更新)/i;
    title = (parts.find((p) => !tech.test(p) && !/^(19\d{2}|20\d{2})$/.test(p)) || parts[0] || name).replace(/\((19\d{2}|20\d{2})\)\s*/g, "").trim();
  }
  const genreWords = Object.keys(GENRE_DESC).filter((g) => name.includes(g));
  if (!genres.length && genreWords.length) genres.push(...genreWords);
  const kind = detectKind(name, genres);

  title = title
    .replace(/\.(rar|zip|7z|mp4|mkv|avi|ts|txt|pdf|jpg)$/i, "")
    .replace(/\[|\]/g, "")
    .replace(/\b(1080p|720p|2160p|4K|HDR|WEB-?DL|BluRay|HDTV|x26[45])\b/gi, "")
    .replace(/(高清|官方中字|中日字幕|中英双字|中字|熟肉|国语中字|更新至.*?集|全\d+集|全\d+\+\d*集?)/g, "")
    .replace(/[（(]\s*[）)]/g, "")        // 清洗技术词后产生的空括号
    .replace(/【|】/g, "")                  // 装饰括号清除
    .replace(/^(电影|电视剧|动漫|纪录片|影视)(?![一-龥])|^(电影|电视剧|动漫|纪录片|影视)(?=[一-龥])/, "")   // 首部类型词（【电影】前缀类，兼容无分隔）
    .replace(/[.·]{2,}/g, ".")
    // 书名号里的年份是元数据，标题不需要它（模板会自己拼年份，留着就会重复）
    .replace(/[《【]\s*(19\d{2}|20\d{2})\s*[》】]/g, "")
    // 集数残渣：资源名常带「1-47完整版」「1-12」这类集数区间，留在标题里就是乱码
    .replace(/\d+\s*[-~—]\s*\d+\s*(?:完整版|全)/g, "")
    .replace(/\s*[（(]?\s*(19\d{2}|20\d{2})\s*[）)]?\s*$/, "")  // 末尾裸年份（防止标题拼年份出现"20212021"）
    .replace(/\s{2,}/g, " ")
    .trim();
  if (title.length > 40) title = title.slice(0, 40).replace(/[\s.·]+$/, "");
  return { title, year, genres, country, kind };
}

// ---------- 乱码检测 ----------
const GARBLE_PATTERNS = /锟斤拷|烫烫烫|屯屯屯|锘匡拷|�|ï¿½/;
// 乱码典型字符区：Latin-1 补充(U+00A0-FF)、Latin扩展A(U+0100-017F)、常用标点(U+2000-206F)、注音符号
const SUSPECT = /[ -ÿĀ-ſ -⁯㄀-ㄯ]/g;
function isGarbledName(name) {
  const n = String(name || "");
  if (!n) return false;
  if (GARBLE_PATTERNS.test(n)) return true;
  const repl = (n.match(/[�□■]/g) || []).length;
  if (repl / n.length > 0.15) return true;
  const suspect = (n.match(SUSPECT) || []).length;
  if (n.length >= 6 && suspect / n.length > 0.25) return true;
  return false;
}

// ---------- 规范化去重键 ----------
const TECH_WORDS = /(1080p|720p|2160p|4k|hdr|web[-_.]?dl|blu-?ray|bd|hdtv|hd|dvdrip|remux|x26[45]|hevc|aac|ac3|dts|中字|中英双字|国语|粤语|双语|无删减|未删减|高清|超清|蓝光|完整版|全集)/gi;
const NOISE_WORDS = ["电影", "电视剧", "动漫", "纪录片", "资源", "下载", "在线观看", "百度云", "网盘"]
  .concat(GENRE_DESC ? Object.keys(GENRE_DESC) : [])
  .concat(REGIONS);
const NOISE_RE = new RegExp(NOISE_WORDS.join("|"), "g");
function normalizeName(name) {
  let n = String(name || "");
  n = n.replace(TECH_WORDS, " ");
  const year = (n.match(/(19\d{2}|20\d{2})/) || [])[1] || "";
  n = n.replace(/[（(][^）)]*[）)]/g, " ");   // 圆括号内容=站点/版本，去掉
  n = n.replace(/[[\]]/g, " ");              // 方括号只去符号，保留内容（中文名常在括号里）
  // 核心字符：中文 + 韩文 + 假名（三者互相独立，避免韩/日名坍缩）
  let core = (n.match(/[一-龥가-힯぀-ヿ0-9]/g) || []).join("").replace(NOISE_RE, "");
  if (year) core = core.replace(year, "");
  if (core.length >= 2) return core + (year ? "_" + year : "");
  // 拉丁回退：保留字母数字，剔除纯年份后仍太短则放弃去重（返回空键）
  const compact = n.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const noYear = compact.replace(/(19\d{2}|20\d{2})/, "");
  if (noYear.length >= 3 && !/^\d+$/.test(noYear)) return noYear.slice(0, 60) + (year ? "_" + year : "");
  return "";
}

// ---------- 质量门槛 ----------
const AD_PATTERNS = /微信号|加微信|VX[:：]?|公众号|二维码|代下|有偿|收费|付费获取|联系QQ|加群|引流|广告|www\./i;
const BAD_EXT = /\.(rar|zip|7z|tar|gz)$/i;
const JUNK_PATTERNS = /[\r\n]|提取码|复制$|\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}(:\d{2})?|pwd=|[A-Za-z0-9_-]{8,}\?| {2,}/;
function reject(rawName, link) {
  const n = String(rawName || "").trim();
  if (!n) return "空名称";
  if (n.length < 4) return "名称过短";
  if (n.length > 60) return "名称过长";
  if (BAD_EXT.test(n)) return "压缩包（SOP禁止）";
  if (AD_PATTERNS.test(n)) return "含广告词";
  if (JUNK_PATTERNS.test(n)) return "名称含UI杂质";
  if (isGarbledName(n)) return "文件名乱码";
  if (link && !/^https:\/\/pan\.baidu\.com\/s\/[\w-]+\?pwd=[a-z0-9]{4}$/i.test(String(link).trim())) return "链接格式无效或缺提取码";
  return "";
}

// ---------- 标题生成 ----------
/**
 * 是不是影视类资源。只有它们才该出现「电影/电视剧/动漫」字样。
 * 实测事故：资源名「抖音最新注册跳核对技术」被拼成
 * 「哪里有抖音最新注册跳核对技术电影的百度云资源分享」——文不对题。
 */
function isFilmKind(kind) {
  return ["电影", "剧集", "动漫", "纪录片"].includes(String(kind || ""));
}

/** 标题里用的类型词；非影视资源返回空串——宁可不写，也不要写错 */
function kindWord(kind, film, tv) {
  if (!isFilmKind(kind)) return "";
  return kind === "剧集" ? tv : film;
}

const TITLE_PATTERNS = [
  (t, y, k) => `哪里有${t}${y}${kindWord(k, "电影", "电视剧")}的百度云资源分享`,
  (t, y) => `求${t}${y}完整版网盘资源下载`,
  (t, y, k) => `${t}${y}${k === "剧集" ? "全集中文" : kindWord(k, "高清完整版", "全集中文")}网盘链接哪里找`,
  (t) => `谁有${t}的网盘资源啊 求分享`,
  (t, y) => `${t}${y}在线看和网盘下载地址`,
  (t, y, k) => `求${t}${y}${k === "动漫" ? "动漫全集" : k === "剧集" ? "电视剧全集" : kindWord(k, "电影高清", "")}百度网盘`,
  (t) => `${t}网盘资源获取 完整版`,
  (t, y) => `哪里能下到${t}${y}的完整资源`,
];
function buildTitle(meta, idx) {
  const { title, year, kind } = meta;
  const fn = TITLE_PATTERNS[idx % TITLE_PATTERNS.length];
  // 标题里**已经带了这个年份**就不要再拼一次。
  // 实测事故：资源名「兰香如故《2026》1-47完整版2026电影」会产出
  // 「…《2026》…2026电影2026电视剧…」——同一个年份出现三次，标题直接成了垃圾。
  // 原先只有一条「末尾裸年份」的保护，管不到年份在中间或带书名号的情况。
  const safeYear = year && !title.includes(year) ? year : "";
  let t = fn(title, safeYear, kind);
  if (t.length > 49) t = t.slice(0, 49);
  if (t.length < 5) t = `求${title}网盘资源`.slice(0, 49);
  return t;
}

// ---------- 简介 ----------
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

// ---------- 模板 HTML ----------
/**
 * 拼回答正文。
 *
 * 两处都是照平台审核结果改的（实测 108 条软件内上传）：
 *  1. **链接必须是可点开的 `<a href>`，不能是裸 URL**。裸文本那组被拒 12.3%、`<a>` 那组 6.9%。
 *  2. **不再追加空的 `<img src="" />`**。含空 img 的那组被拒 13.8%，不含的那组 0%——
 *     全部 12 条被拒都落在含空 img 的组里。空 src 对审核来说就是无效元素。
 *
 * 第 2 条这里直接**删掉**而不是靠 keepImg 开关：有 8 个脚本会传 true，
 * 留开关等于留一个随时会把坏元素放回去的口子。真要配图得给真实图片地址。
 */
function buildAnswerHtml(link, intro) {
  const url = String(link || "").trim();
  return [
    "<p><strong>点击链接获取网盘资源：</strong><br/></p>",
    `<p><a href="${url}">${url}</a><br/></p>`,
    `<p>简介：${intro}</p>`,
  ].join("\n");
}

module.exports = {
  GENRE_DESC, KNOWN_GENRES, REGIONS,
  detectKind, parseName, isGarbledName, normalizeName, reject,
  buildTitle, buildIntro, buildAnswerHtml, TITLE_PATTERNS,
};
