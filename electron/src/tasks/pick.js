"use strict";

/**
 * 「随机抽题」任务实现。
 *
 * 原本是 app-context.js 里的一个内联闭包（`const pickQuestions = async (payload) => {...}`），
 * 2026-10-10 搬到任务层。搬的直接原因：**我另写脚本跑整条链时，抽题这块拿不到** ——
 * 只能在脚本里抄一遍去重口径，而"抄第二遍"正是这个仓库出过事故的原因；
 * 更要紧的是，若脚本用的抽题逻辑和界面不一样，那"我跑一遍"就不等于"你点一遍"，
 * 验证也就失去意义。
 *
 * 用工厂而不是直接导出函数：它需要 store/config/excel 这些运行时依赖，
 * 以及一个"选保存路径"的回调 —— 界面弹保存对话框，脚本按调用方给的路径存（或自动生成）。
 */

const path = require("path");

const { randomPickQuestions } = require("./random-pick");
const excel = require("../storage/excel");

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

/**
 * @param {object} deps
 * @param {object} deps.store        题库 / 答案台账 / 去重键
 * @param {object} deps.config       Config 实例（读 randomCount / randomOutputPath，写 lastPickFilePath）
 * @param {Function} deps.emit       (channel, message) 日志
 * @param {Function} [deps.chooseSavePath] 没给 outputPath 时用它问路径：async (defaultPath) => 路径 | null
 *   （返回 null 表示用户取消）。不给就等于"必须显式传 outputPath"，脚本用这种。
 * @param {Function} [deps.defaultSaveDir] 默认保存目录（界面传桌面；不给就用 process.cwd()）
 */
function makePickQuestions({ store, config, emit, chooseSavePath, defaultSaveDir, fs = require("fs") } = {}) {
  const log = (message) => { if (typeof emit === "function") emit("task:log", message); };

  return async function pickQuestions(payload) {
    const bank = store.loadBank();
    if (!bank.length) throw new Error("题库为空，请先爬题或导入题库表格。");
    // 已提交的题以 answers 台账为准永久出池：此前只靠 usedKeys 去重，
    // 重开轮（题库抽满一轮自动清空）或题库重爬导致键失配时，答过的题会被再次抽中。
    // 另外把"已生成过回答"的题一并出池（skipGenerated 默认开）：生成记录比提交记录
    // 更容易留存（换机/手动提交/批量上传等任何答题方式，只要在软件里生成过就有标记），
    // 这是防重复答题的主要防线；"已提交"是强标记，双保险。
    const pickKeyOf = (item) => {
      const url = String(item.questionUrl || "").trim().toLowerCase();
      return url ? `url:${url}` : `title:${String(item.title || "").replace(/\s+/g, "").toLowerCase()}`;
    };
    // 默认开：显式传 false（勾选框取消）才允许重抽已生成过的题
    const skipGenerated = !(payload && payload.skipGenerated === false);
    const submittedKeys = new Set(
      store.loadAnswers()
        .filter((a) => a && (a.status === "已提交" || (skipGenerated && String(a.answer || "").trim())))
        .map(pickKeyOf)
        .filter(Boolean)
    );
    const result = randomPickQuestions(bank, store.loadUsedKeys(), {
      categories: payload && payload.categories,
      count: (payload && payload.count) || config.load().randomCount,
      strategy: payload && payload.strategy,
      excludeKeys: submittedKeys,
    });
    if (!result.picked.length) {
      if (result.excludedSubmitted > 0) throw new Error("当前分类下的题目均已答过（已提交或已生成过回答），没有可抽的新题（可先爬题扩充题库）。");
      throw new Error("当前分类下没有可抽的题目。");
    }
    if (result.excludedSubmitted > 0) log(`去重：已排除 ${result.excludedSubmitted} 条答过的题目（已提交/已生成过回答），不会重复作答`);

    // 先确定输出路径（用户取消则直接返回，不消耗去重额度）
    let outputPath = String((payload && payload.outputPath) || config.load().randomOutputPath || "").trim().replace(/^"|"$/g, "");
    if (outputPath && fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
      outputPath = excel.uniqueFilePath(path.join(outputPath, `随机抽题_${result.picked.length}条_${stamp()}.xlsx`));
    } else if (outputPath && !excel.isTableFile(outputPath)) {
      outputPath = `${outputPath}.xlsx`;
    }
    if (!outputPath) {
      if (typeof chooseSavePath !== "function") {
        throw new Error("没有指定抽题表格的保存路径（脚本模式必须显式给 outputPath）。");
      }
      const picked = await chooseSavePath(path.join(defaultSaveDir || process.cwd(), `随机抽题_${result.picked.length}条_${stamp()}.xlsx`));
      if (!picked) return { canceled: true };
      outputPath = picked;
    }

    // 表格成功落盘后才记去重额度：取消/写失败都不会白白消耗题目
    const savedPath = excel.writeWorkbookSafe(
      outputPath,
      result.picked.map(excel.answerToRow),
      "随机抽题",
      excel.ANSWER_HEADERS,
      (message) => log(message)
    );
    store.addUsedKeys(result.usedKeys);
    // 记住最近一次抽题表格：生成/提交视图默认使用，减少手动选文件
    config.save({ lastPickFilePath: savedPath });
    return {
      canceled: false,
      filePath: savedPath,
      count: result.picked.length,
      total: result.total,
      remainingAfter: result.remainingAfter,
      resetRound: result.resetRound,
      results: result.picked,
    };
  };
}

module.exports = { makePickQuestions, stamp };
