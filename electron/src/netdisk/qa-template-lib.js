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
  if (/\d+\s*[-~]\s*\d+\s*完整版|1-\d+完整版|全\d+集|\d+集完整/.test(name)) return "剧集";
  if (/动漫|动画|番/.test(text)) return "动漫";
  if (/纪录/.test(text)) return "纪录片";
  if (/日剧|韩剧|美剧|泰剧|港剧|国产剧|台剧|电视剧|连续剧|网剧/.test(text)) return "剧集";
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
    .replace(/[（(]\s*[）)]/g, "")        // 清洗技术词后产生的空括号（必须放最后）
    .replace(/[.·]{2,}/g, ".")
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
const TECH_WORDS = /(1080p|720p|2160p|4k|hdr|web[-_.]?dl|blu-?ray|bd|hdtv|hd|dvdrip|remux|x26[45]|hevc|aac|ac3|dts|中字|中英双字|国语|粤语|双语|无删减|未删减|高清|超清|蓝光|完整版|全集|全\d+集|\d+集)/gi;
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
  const cjk = (n.match(/[一-龥]/g) || []).join("");
  const core = cjk.replace(NOISE_RE, "");
  if (core.length >= 2) return core + (year ? "_" + year : "");
  return n.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 40);
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
function buildAnswerHtml(link, intro, keepImg = true) {
  const parts = [
    "<p><strong>点击链接获取网盘资源：</strong><br/></p>",
    `<p>${link}<br/></p>`,
    `<p>简介：${intro}</p>`,
  ];
  if (keepImg) parts.push('<img src="" />');
  return parts.join("\n");
}

module.exports = {
  GENRE_DESC, KNOWN_GENRES, REGIONS,
  detectKind, parseName, isGarbledName, normalizeName, reject,
  buildTitle, buildIntro, buildAnswerHtml, TITLE_PATTERNS,
};
