"use strict";

/**
 * 网盘资源批量采集器（供给端自动化）—— pansou.app API 直连版：
 *   关键词库驱动 → 重放 pansou 聚合搜索的 21 路请求（plugin + TG 频道）
 *   → 从 JSON 响应取 baidu 数组（url+password+note）→ 跨次去重累积主资源库
 *   → 导出两列表（SOP 1.1 格式），对接 pan-to-qa.js 转问答格式。
 *
 * 设计要点：
 *   - 纯 Node fetch，无浏览器依赖（单关键词 21 请求与官网 UI 行为一致）
 *   - 断点续爬：状态文件记录已完成/空结果关键词，重跑自动跳过已完成
 *   - 防风控：关键词间随机延时 + 请求间小间隔；支持时间预算/关键词上限
 *   - 状态修复：0 结果不标记完成（记入 empty 计数，下次重跑自动重试）
 *   - 质量预过滤：广告词/压缩包/超短名在入库前剔除（与 pan-to-qa 门槛一致）
 *
 * 用法：
 *   node scripts/pan-crawl-batch.js [选项]
 *     --keywords-file=xx.txt   追加关键词文件（每行一个，# 开头为注释）
 *     --max-keywords=50        本次最多跑多少个关键词（默认 50）
 *     --minutes=60             时间预算（分钟，默认 60，到点收尾导出）
 *     --delay-min / --delay-max 关键词间随机延时秒数（默认 4~9）
 *     --out=xx.xlsx            导出路径（默认 运行缓存/pan-resources-master.xlsx）
 */

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const root = path.resolve(__dirname, "..");
const cacheDir = path.join(root, "运行缓存");
const masterJsonl = path.join(cacheDir, "pan-resources-master.jsonl");
const stateFile = path.join(cacheDir, "pan-crawl-state.json");
const PANSOU_API = "https://pansou.app/api/search";

// pansou 前端聚合搜索的 21 路请求模式（2026-09-22 抓包快照；改版后重抓即可）
const PANSOU_QUERY_PATTERNS = [
  "res=merged_by_type&src=plugin&plugins=duoduo,xuexizhinan,nyaa&conc=4",
  "res=merged_by_type&src=plugin&plugins=hunhepan,jikepan,labi,thepiratebay&conc=4",
  "res=merged_by_type&src=plugin&plugins=pansearch,qupansou,panta,hunhepan&conc=4",
  "res=merged_by_type&src=tg&channels=AliyunDrive_Share_Channel,aliyunys,Aliyun_4K_Movies,yunpanpan&conc=4",
  "res=merged_by_type&src=tg&channels=MCPH01,share_aliyun,bdwpzhpd,ysxb48&conc=4",
  "res=merged_by_type&src=tg&channels=NewQuark,ydypzyfx,kuakeyun,ucquark&conc=4",
  "res=merged_by_type&src=tg&channels=Q66Share,NewAliPan,ypquark,Oscar_4Kmovies&conc=4",
  "res=merged_by_type&src=tg&channels=Quark_Share_Channel,quarkshare,baiduyun,iAliyun&conc=4",
  "res=merged_by_type&src=tg&channels=alyp_1,dianyingshare,Quark_Movies,XiangxiuNBB&conc=4",
  "res=merged_by_type&src=tg&channels=jdjdn1111,yggpan,MCPH086,zaihuayun&conc=4",
  "res=merged_by_type&src=tg&channels=oneonefivewpfx,Maidanglaocom,qixingzhenren,taoxgzy&conc=4",
  "res=merged_by_type&src=tg&channels=quanziyuanshe&conc=4",
  "res=merged_by_type&src=tg&channels=tgsearchers115,Channel_Shares_115,tyysypzypd,vip115hot&conc=4",
  "res=merged_by_type&src=tg&channels=tgsearchers3,yunpanxunlei,tianyifc,BaiduCloudDisk&conc=4",
  "res=merged_by_type&src=tg&channels=tianyirigeng,cloudtianyi,hdhhd21,Lsp115&conc=4",
  "res=merged_by_type&src=tg&channels=txtyzy,peccxinpd,gotopan,xingqiump4&conc=4",
  "res=merged_by_type&src=tg&channels=ucwpzy,alyp_TV,alyp_4K_Movies,shareAliyun&conc=4",
  "res=merged_by_type&src=tg&channels=wp123zy,yunpan139,yunpan189,yunpanuc&conc=4",
  "res=merged_by_type&src=tg&channels=xx123pan,yingshifenxiang123,zyfb123,tyypzhpd&conc=4",
  "res=merged_by_type&src=tg&channels=yunpanqk,PanjClub,kkxlzy,baicaoZY&conc=4",
  "res=merged_by_type&src=tg&channels=yydf_hzl,alyp_Animation,alyp_JLP,leoziyuan&conc=4",
];
const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Referer": "https://pansou.app/",
  "Accept": "application/json, text/plain, */*",
};

// ---------- 参数解析 ----------
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([a-z-]+)=(.*)$/i);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const maxKeywords = Math.max(1, Number(args["max-keywords"]) || 50);
const budgetMs = Math.max(5, Number(args.minutes) || 60) * 60 * 1000;
const delayMinS = Math.max(2, Number(args["delay-min"]) || 4);
const delayMaxS = Math.max(delayMinS, Number(args["delay-max"]) || 9);
const outFile = args.out ? path.resolve(args.out) : path.join(cacheDir, "pan-resources-master.xlsx");

// ---------- 关键词库（类目 × 限定词组合，可持续补充） ----------
const BASE_KEYWORDS = [
  // 教育资料（高频刚需，量大）
  "课件", "电子课本", "期末试卷", "单元测试卷", "期中试卷", "真题汇编", "知识点汇总",
  "思维导图", "名师网课", "同步练习", "教案", "假期作业", "专项训练", "中考真题", "高考真题",
  // 学段学科组合
  "小学语文课件", "小学数学课件", "小学英语课件", "初中物理课件", "初中化学课件",
  "初中数学课件", "高中数学课件", "高中物理课件", "高中英语课件", "高中生物课件",
  // 考试/职业技能
  "考研资料", "公务员考试资料", "教师资格证资料", "注册会计师资料", "法考资料",
  "一级建造师资料", "软考资料", "雅思资料", "托福资料", "普通话考试资料",
  // 书籍/文档
  "电子书", "pdf书籍", "四大名著", "茅盾文学奖作品", "武侠小说全集", "科幻小说",
  "育儿书籍", "心理学书籍", "历史书籍", "人物传记",
  // 影视/纪录片
  "纪录片", "高分电影", "经典电视剧", "动画片全集", "教育资源纪录片", "央视纪录片",
  // 素材/模板
  "PPT模板", "简历模板", "手抄报模板", "海报素材", "壁纸合集", "音效素材",
  "字体合集", "PS教程", "视频剪辑教程", "摄影教程",
];
const QUALIFIERS = ["完整版", "合集", "全套", "2026", "最新版", "高清", "精讲", "汇总", "全集"];

// 长尾词表：命名实体级关键词（百度网盘资源覆盖密度远高于泛词）
const TEXTBOOK_VERSIONS = ["人教版", "部编版", "北师大版", "苏教版", "外研版", "译林版", "冀教版"];
const PRIMARY_SUBJECTS = ["语文", "数学", "英语"];
const MIDDLE_SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"];
const PRIMARY_GRADES = ["一年级上册", "一年级下册", "二年级上册", "二年级下册", "三年级上册", "三年级下册",
  "四年级上册", "四年级下册", "五年级上册", "五年级下册", "六年级上册", "六年级下册"];
const MIDDLE_GRADES = ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"];
const HIGH_GRADES = ["高一", "高二", "高三", "必修一", "必修二", "选择性必修一", "选择性必修二", "选择性必修三"];
const EXAM_KEYWORDS = [
  "考研数学", "考研英语", "考研政治", "考研408", "考研西医综合", "考研法硕", "199管理类联考",
  "行测", "申论", "公务员面试", "事业编考试", "教师招聘考试",
  "教资综合素质", "教资教育知识与能力", "教资学科知识", "普通话水平测试",
  "注会会计", "注会审计", "注会财管", "注会经济法", "注会税法", "注会战略",
  "初级会计", "中级会计", "一级建造师", "二级建造师", "消防工程师", "安全工程师",
  "软考中级", "软考高级", "系统集成项目管理", "雅思写作", "雅思口语", "托福词汇", "GRE词汇", "专四专八",
];
const BOOK_KEYWORDS = [
  "三体全集", "活着", "百年孤独", "红楼梦", "白鹿原", "平凡的世界", "围城", "解忧杂货店",
  "白夜行", "嫌疑人X的献身", "龙族全集", "斗罗大陆", "凡人修仙传", "诡秘之主", "庆余年",
  "明朝那些事儿", "人类简史", "未来简史", "原则", "穷查理宝典", "小王子", "窗边的小豆豆",
  "哈利波特全集", "冰与火之歌", "基地系列", "沙丘", "福尔摩斯探案全集", "东野圭吾作品集",
  "金庸作品集", "古龙作品集", "余华作品集", "莫言作品集", "王小波全集", "史铁生作品集",
  "英文原著分级阅读", "牛津树", "RAZ分级阅读", "红火箭", "海尼曼", "吴军作品集",
];
const DOC_KEYWORDS = [
  "舌尖上的中国", "地球脉动", "蓝色星球", "河西走廊", "中国通史", "大国崛起", "美丽中国",
  "航拍中国", "如果国宝会说话", "世界历史", "故宫100", "我在故宫修文物", "大明宫", "玄奘之路",
  "SB1077自然纪录片合集", "BBC纪录片合集", "National Geographic纪录片", "数学纪录片",
];
const MATERIAL_KEYWORDS = [
  "年终总结PPT", "述职报告PPT", "答辩PPT模板", "开题报告PPT", "家长会PPT", "教师节PPT",
  "春节手抄报", "国庆节手抄报", "中秋节手抄报", "读书手抄报", "数学手抄报", "英语手抄报",
  "安全手抄报", "环保手抄报", "垃圾分类手抄报", "简历模板应届生", "财务简历模板", "工程师简历模板",
  "思维导图模板", "甘特图模板", "商业计划书模板", "合同范本", "幼儿园教案", "小学主题班会课件",
];
const FILM_KEYWORDS = [
  "流浪地球2", "哪吒之魔童闹海", "长安三万里", "肖申克的救赎", "霸王别姬", "阿甘正传",
  "千与千寻", "龙猫", "宫崎骏全集", "新海诚全集", "甄嬛传", "琅琊榜", "人民的名义", "狂飙",
  "繁花", "三体电视剧", "老友记", "权力的游戏", "哈利波特全集", "漫威电影合集", "DC电影合集",
  "扎导版正义联盟", "指环王三部曲", "霍比特人", "碟中谍", "速度与激情", "唐人街探案",
];
const TEACHING_AIDS = [
  "五三", "黄冈随堂练", "53天天练", "举一反三", "口算题卡", "学而思秘籍", "一课一练",
  "尖子生题库", "实验班提优训练", "默写能手", "计算能手", "番茄同步作文", "小学生看图写话",
];

function buildKeywordPool() {
  const pool = new Set(BASE_KEYWORDS);
  // 教材长尾：版本 × 科目 × 学段（小学/初中/高中）
  for (const v of TEXTBOOK_VERSIONS) {
    for (const s of PRIMARY_SUBJECTS) for (const g of PRIMARY_GRADES) pool.add(`${v}${s}${g}`);
    for (const s of MIDDLE_SUBJECTS) for (const g of MIDDLE_GRADES) pool.add(`${v}${s}${g}`);
  }
  for (const s of MIDDLE_SUBJECTS) for (const g of HIGH_GRADES) pool.add(`高中${s}${g}`);
  for (const s of PRIMARY_SUBJECTS) for (const g of PRIMARY_GRADES) pool.add(`小学${s}${g}`);
  // 命名实体词表
  for (const kw of [EXAM_KEYWORDS, BOOK_KEYWORDS, DOC_KEYWORDS, MATERIAL_KEYWORDS, FILM_KEYWORDS, TEACHING_AIDS]) {
    for (const kw2 of kw) pool.add(kw2);
  }
  // 基础词保留 2 个限定词变体
  BASE_KEYWORDS.forEach((kw, i) => {
    pool.add(`${kw}${QUALIFIERS[i % QUALIFIERS.length]}`);
    pool.add(`${kw}${QUALIFIERS[(i + 3) % QUALIFIERS.length]}`);
  });
  return [...pool];
}

// ---------- 质量预过滤与主库读写（共享模块） ----------
const lib = require("./pan-library");
const preFilter = lib.preFilter;

// ---------- 状态（断点续爬） ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
const state = Object.assign({ done: {}, empty: {}, fail: {} }, loadJson(stateFile, {}));
state.done = state.done || {};
state.empty = state.empty || {};
state.fail = state.fail || {};

// ---------- 主资源库（JSONL 追加 + 链接索引） ----------
const loadLinkIndex = lib.loadLinkIndex;

// ---------- pansou API 采集 ----------
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 全局退避：连续 429/5xx 时整体暂停，避免触发站点风控
let pauseUntil = 0;

async function fetchPattern(keyword, queryPattern) {
  const url = `${PANSOU_API}?kw=${encodeURIComponent(keyword)}&${queryPattern}&ext=${encodeURIComponent('{"__plugin_timeout_ms":5000}')}`;
  const resp = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(20000) });
  if (resp.status === 429 || resp.status >= 500) {
    pauseUntil = Date.now() + 60000;
    throw new Error(`HTTP ${resp.status}（全局退避 60s）`);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.json();
  const baidu = body?.data?.merged_by_type?.baidu || [];
  return baidu
    .filter((it) => it && it.url && /pan\.baidu\.com\/s\//.test(it.url))
    .map((it) => ({
      name: String(it.note || "").trim(),
      url: it.url,
      pwd: String(it.password || (it.url.match(/pwd=([a-z0-9]{4})/i) || [])[1] || ""),
    }));
}

/** 单关键词全量采集：并发重放 21 路请求，合并去重。 */
async function collectViaPansou(keyword) {
  const seen = new Set();
  const items = [];
  const tasks = PANSOU_QUERY_PATTERNS.map(async (pattern, i) => {
    await sleep(i * 250); // 请求间小间隔，模拟官网并发节奏
    try {
      for (const item of await fetchPattern(keyword, pattern)) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        items.push(item);
      }
    } catch (e) {
      console.log(`    · 一路请求失败: ${(e.message || "").slice(0, 60)}`);
    }
  });
  await Promise.allSettled(tasks);
  return items;
}

// ---------- 主流程 ----------
(async () => {
  const pool = buildKeywordPool();
  if (args["keywords-file"]) {
    const extra = fs.readFileSync(String(args["keywords-file"]), "utf8").split(/\r?\n/)
      .map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    pool.unshift(...extra); // 用户关键词优先
  }
  const todo = pool.filter((kw) => !state.done[kw]);
  console.log(`关键词池 ${pool.length} 个，待跑 ${todo.length} 个（已完成 ${Object.keys(state.done).length}）`);
  console.log(`本次上限 ${maxKeywords} 个 | 时间预算 ${Math.round(budgetMs / 60000)} 分钟 | API 直连模式（无浏览器）`);

  const linkIndex = loadLinkIndex();
  console.log(`主资源库已有 ${linkIndex.size} 条链接`);

  const startedAt = Date.now();
  let ran = 0, added = 0, junk = 0;

  for (const kw of todo) {
    if (ran >= maxKeywords || Date.now() - startedAt > budgetMs) { console.log("到达本次上限，收尾。"); break; }
    if (pauseUntil > Date.now()) {
      console.log(`  ⏸ 触发退避，暂停至 ${new Date(pauseUntil).toLocaleTimeString()}`);
      await sleep(pauseUntil - Date.now() + 1000);
    }
    ran += 1;

    let items = [];
    try {
      items = await collectViaPansou(kw);
    } catch (e) {
      console.log(`  ✗ [${kw}] 采集异常: ${(e.message || "").slice(0, 80)}`);
      state.fail[kw] = (state.fail[kw] || 0) + 1;
      saveJson(stateFile, state);
      continue;
    }

    if (!items.length) {
      // 0 结果不标记完成，下次运行自动重试（但同一次运行内不重复跑）
      state.empty[kw] = (state.empty[kw] || 0) + 1;
      saveJson(stateFile, state);
      console.log(`  [${ran}/${Math.min(maxKeywords, todo.length)}] ${kw}: 0 条（记入空结果，下轮重试）`);
      await sleep((delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000);
      continue;
    }

    let newCnt = 0;
    for (const item of items) {
      if (linkIndex.has(item.url)) continue;
      const bad = preFilter(item.name);
      if (bad) { junk += 1; continue; }
      lib.appendResource(linkIndex, { name: item.name, url: item.url, pwd: item.pwd, source: "pansou-api", kw });
      newCnt += 1;
    }
    added += newCnt;
    state.done[kw] = { at: Date.now(), found: items.length, added: newCnt };
    delete state.empty[kw];
    delete state.fail[kw];
    saveJson(stateFile, state);
    console.log(`  [${ran}/${Math.min(maxKeywords, todo.length)}] ${kw}: 提取 ${items.length}，新入库 ${newCnt}（本次累计 ${added}）`);

    const delay = (delayMinS + Math.random() * (delayMaxS - delayMinS)) * 1000;
    await sleep(delay);
  }

  // 导出两列表（SOP 1.1 输入格式 → pan-to-qa.js）
  lib.exportXlsx(outFile);

  const mins = Math.round((Date.now() - startedAt) / 60000);
  console.log("=== 本次采集完成 ===");
  console.log(`跑完 ${ran} 个关键词 | 新增 ${added} 条 | 剔除脏数据 ${junk} 条 | 主资源库总量 ${linkIndex.size} 条 | 用时 ${mins} 分钟`);
  console.log(`资源表已导出: ${outFile}`);
  console.log(`下一步转换: node scripts/pan-to-qa.js "${outFile}"`);
  console.log(`继续采集:   node scripts/pan-crawl-batch.js（自动跳过已完成关键词）`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e.message || "").slice(0, 160)); process.exit(1); });
