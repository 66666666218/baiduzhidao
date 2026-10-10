"use strict";

/**
 * 一键全自动：把「爬题 → 抽题 → 生成 → 提交 → 转存 → 上传」串成一条无人值守的链。
 *
 * 为什么从 app-context.js 搬出来：原来那是一个 245 行的 ipcMain handler。
 * 搬的理由不只是"太长"，而是它有一个**会撒谎**的结构：
 * 每个阶段都写成 `if (勾选了 && !failure && 某个前置条件)`，前置条件不满足时
 * 直接不进分支 —— 既不记日志也不进 report。于是 report 少了几项、failure 又是 null，
 * 最后的结论仍然是「全部阶段成功」。用户看到的是成功，实际那几步根本没跑。
 *
 * 现在：**所有"选了却没能跑"的跳过都必须经过 skipStage() 留下一条 skipped 记录**，
 * 结论文案据此如实生成（几个成功 / 几个跳过 / 卡在哪个阶段）。
 * 真正"没勾选"的阶段不算跳过 —— 那是用户的意思，不该污染结论。
 */

/** 阶段 id 全集；payload.stages 为空时按全部跑 */
const ALL_STAGES = ["crawl", "pick", "generate", "submit", "transfer", "upload"];

/** 环境名统一成字符串数组（兼容 ["A"] 与 [{label:"A"}] 两种写法） */
function normEnvs(list) {
  return (Array.isArray(list) ? list : [])
    .map((env) => (env && typeof env === "object" ? env.label ?? env.name : env))
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

/** 取一个"数字"（缺字段/非数字一律 0，别让摘要里出现 NaN） */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 阶段结果 → 一行摘要。
 *
 * 为什么值得单独写：整链是无人值守跑的，用户第二天回来看的就是结果表那几行。
 * 只写「✅ 爬题」「✅ 提交」等于没说 —— 爬了 0 题也叫成功。所以每个阶段都要报出
 * **做出了多少**（生成几条、提交成功几条、被拒几条），异常数字才有机会被一眼看见。
 *
 * 字段名是从各任务真实的返回值上抄的（不是猜的）；对不上时宁可不显示，也不显示 0 之外的假数据。
 */
function summarizeStage(name, result) {
  const r = result && typeof result === "object" ? result : {};
  const tail = (value) => (String(value || "").trim() ? ` → ${String(value).trim()}` : "");
  switch (name) {
    case "crawl":
      return `新增 ${num(r.added)} 题`;
    case "pick":
      return `抽到 ${num(r.count)} 条${tail(r.filePath)}`;
    case "generate":
      return `生成 ${num(r.count)} 条${num(r.failed) ? `，失败 ${num(r.failed)} 条` : ""}`;
    case "submit":
      return `提交成功 ${num(r.count)} 条${num(r.failed) ? `，失败 ${num(r.failed)} 条` : ""}`;
    case "checkPermission": {
      const accounts = Array.isArray(r.accounts) ? r.accounts : [];
      if (!accounts.length) return "";
      // 与权益门同一口径：无权益、或**额度为 0**的都不算可用（额度 0 上去必然失败）
      const usable = accounts.filter((a) => a && a.hasPermission !== false && a.remainingQuota !== 0).length;
      const noQuota = accounts.filter((a) => a && a.remainingQuota === 0).length;
      return `可用上传账号 ${usable}/${accounts.length} 个${noQuota ? `（其中 ${noQuota} 个剩余额度为 0）` : ""}`;
    }
    case "search":
      return `搜到 ${num(r.count)} 条资源`;
    case "transfer":
      return `转存 ${num(r.count)} 条${tail(r.outputPath)}`;
    case "upload":
      return `上传 ${num(r.uploaded)} 行`;
    case "checkPublished": {
      // 注意 checked 是"成功核对到的账号数"，不是收录条数 —— 条数在每账号的 summary 里
      const all = Array.isArray(r.accounts) ? r.accounts : [];
      const ok = all.filter((a) => a && a.summary);
      // 查了但一个账号都没核对成功（全未登录 / 全查询失败）时，**不能只留一个光秃秃的 ✅**。
      // 那种行和"确实核对了、结果为零"看起来一模一样，而这正是"界面在撒谎"的典型形态。
      if (!ok.length) return all.length ? `未核对到任何账号（${all.length} 个账号全部失败，详见日志）` : "";
      const good = ok.reduce((sum, a) => sum + num(a.summary.successRows), 0);
      const bad = num(r.failedRows);
      return `已收录 ${good} 条${bad ? `，被拒 ${bad} 条` : ""}`;
    }
    default:
      return "";
  }
}

/**
 * @param {object} deps 全部显式注入 —— 这样这个模块不 import electron，
 *   可以脱离 Electron 用假依赖整条跑一遍（见 tests/unit/auto-pipeline.test.js）。
 */
function createAutoPipeline(deps) {
  const {
    config, startTask, taskDeps, pickQuestions, emit, pulse, dataDir,
    taskRunners, CATEGORIES, excel, fs, path, resolveNetdiskRoles,
    // 可选：预检用。不给就不做"纯协议却一个凭据都没有"的拦截（测试与脚本可以不传）。
    credentialOf: credentialOfFor, credentialHint: credentialHintFor,
  } = deps;

  // 「停止」旗标：TaskManager.stop 只能停当前那个任务，而编排在阶段之间还要决定
  // "下一阶段要不要开始"。没有它，用户点了停止，编排仍会把后续阶段依次拉起来。
  let aborted = false;
  // 重入保护：连点两次「开始」时，第二次会把 aborted 复位掉，于是**第一次**的停止请求失效。
  // TaskManager 的单任务互斥能挡住第二次执行，但挡不住这个副作用，所以在入口直接拒绝。
  let running = false;

  return {
    abort() { aborted = true; },
    isAborted() { return aborted; },
    run,
  };

  async function run(payload) {
    if (running) throw new Error("一键全自动正在运行中，请先等它结束或点「停止」。");
    running = true;
    aborted = false;
    try {
      return await runInner(payload);
    } finally {
      running = false;
    }
  }

  async function runInner(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const enabled = new Set(Array.isArray(p.stages) && p.stages.length ? p.stages : ALL_STAGES);
    const settings = config.load();
    // 本次参与的账号：调用方显式指定优先（一键全自动页可以只挑几个号跑），默认用设置页的全部
    const requestedEnvs = normEnvs(p.bitEnvs);
    const bitEnvs = requestedEnvs.length ? requestedEnvs : normEnvs(settings.bitEnvs);

    const report = [];
    let failure = null;
    let pickFile = "";
    // 上传专用表：优先用转存阶段的产出，其次用调用方指定的现成表
    let uploadTable = String(p.uploadTablePath || "").trim();
    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

    // 本轮产出的文件清单。无人值守跑完之后，用户最想要的就是"东西在哪"——
    // 这些路径本来只散落在日志里，翻起来很费劲，而日志会被后续输出顶上翻走。
    const artifacts = [];
    const addArtifact = (label, file) => {
      const path = String(file || "").trim();
      if (path) artifacts.push({ label, path });
    };

    const runStage = async (name, label, fn) => {
      if (aborted) {
        report.push({ stage: name, label, ok: false, skipped: true, error: "已停止" });
        return null;
      }
      emit("task:log", `══════ 一键全自动 · ${label} ══════`);
      pulse();
      try {
        const result = await fn();
        // 带上"这一步到底做出了什么"。结果表里只写「✅ 爬题」等于没说 ——
        // 用户跑的是无人值守的整链，第二天回来看的就是这几行。
        const summary = summarizeStage(name, result);
        report.push({ stage: name, label, ok: true, ...(summary ? { summary } : {}) });
        emit("task:log", `──── ${label} 完成${summary ? `：${summary}` : ""} ────`);
        return result;
      } catch (error) {
        report.push({ stage: name, label, ok: false, error: error.message });
        emit("task:log", `⚠️ ${label} 失败，后续阶段不再执行：${error.message}`);
        // 必须补一条**终止**进度：pulse 把界面切成"运行中"（禁用按钮）之后就靠任务自己
        // 收尾发 done/failed，而这里失败在任务启动**之前**（比如抽题时"题库为空"、
        // 读表读不出行）—— 不发这一下，界面就永久停在运行中，按钮一直点不动。
        pulse("failed");
        failure = error;
        return null;
      }
    };

    /**
     * 记一条"勾选了但没跑成"的跳过。必须在 report 里留痕：
     * 不留痕的话它就不会出现在结果表里，而结论又只看 failure —— 于是变成"成功"。
     */
    const skipStage = (name, label, reason) => {
      // 已经在停止途中：这一阶段不是"没跑成"，而是"用户不让跑了"。
      // 不加这一层的话，停止后每个阶段都会挂上一条误导性的原因（比如"没有抽题产物"）。
      const why = aborted ? "已停止" : reason;
      report.push({ stage: name, label, ok: false, skipped: true, error: why });
      if (!aborted) emit("task:log", `⏭️ 跳过「${label}」：${reason}`);
    };

    // 配置类错误**不进 report**，直接抛给调用方 —— 界面上"请先去设置页填账号"
    // 比"有阶段失败（详见上方结果）"有用得多。
    if (!bitEnvs.length) throw new Error("请先在设置页「比特环境名称」填写账号。");

    // **纯协议模式 + 一个账号都没有可用凭据 = 必然逐个回落到开比特窗口。**
    // 用户明确选了纯协议（很多人正是因为内存不够才选它），结果却开出一串窗口，
    // 而日志只会说"回落到窗口"——他完全不知道是名字对不上。
    // 这里在**开工之前**就拦住，并直接把两边名字摆出来。只在"一个都没有"时拦，
    // 部分账号有凭据时仍然逐个回落（那种情况是有意义的：先跑能跑的）。
    const _mode = String((config.load && config.load().browserMode) || "protocol");
    if (_mode === "protocol" && typeof credentialOfFor === "function") {
      const withCred = bitEnvs.filter((env) => {
        try { const c = credentialOfFor(env); return c && c.bduss; } catch { return false; }
      });
      if (!withCred.length) {
        throw new Error("当前是「纯协议」模式，但这些账号在「账号凭证」里一个可用的 Cookie 都没有 —— "
          + "继续跑只会逐个回落到开比特窗口（你选纯协议正是为了不开窗口）。"
          + credentialHintFor(bitEnvs[0]) + "（若确实想用比特窗口，请到设置页把运行模式改成「比特窗口」。）");
      }
      if (withCred.length < bitEnvs.length) {
        const missing = bitEnvs.filter((e) => !withCred.includes(e));
        emit("task:log", `⚠️ 这些账号在「账号凭证」里没有 Cookie，到它们时会回落到开比特窗口：${missing.join("、")}`);
      }
    }

    try {

      // 1) 爬题：逐分类各跑一次（爬题是只读的，用一个账号即可）
      if (enabled.has("crawl")) {
        const categories = Array.isArray(p.categories) && p.categories.length ? p.categories : CATEGORIES;
        await runStage("crawl", `爬题（${categories.join("、")}）`, async () => {
          let added = 0;
          for (const category of categories) {
            if (aborted || failure) break;
            const result = await startTask(
              "crawl",
              {
                bitEnvs,
                category,
                crawlStartPage: settings.crawlStartPage,
                maxQuestions: settings.maxQuestions,
                // 续爬：暂停/停止后重跑时从上次那页接着走，而不是从头再扫一遍。
                // 已入库的题本来就会自动跳过，所以从头扫不会重复入库、但会白白多花几十分钟。
                resume: true,
              },
              (ctx) => taskRunners.crawl(ctx, taskDeps())
            );
            added += Number(result && result.count) || 0;
          }
          return { added };
        });
      }

      // 2) 抽题：输出路径必须显式给（不能弹保存对话框，否则无人值守会卡死）
      if (enabled.has("pick")) {
        if (failure) {
          // 前面的阶段已经失败：不加跳过记录，失败本身就是结论
        } else {
          await runStage("pick", "抽题", async () => {
            const outDir = path.join(dataDir, "一键跑批");
            const result = await pickQuestions({
              categories: p.categories,
              count: Number(p.pickCount) || settings.randomCount,
              outputPath: path.join(outDir, `抽题_${stamp()}.xlsx`),
              skipGenerated: true,
            });
            if (result.canceled) throw new Error("抽题被取消");
            pickFile = result.filePath;
            addArtifact("抽题表", result.filePath);
            return result;
          });
        }
      }

      // 3) 生成答案
      if (enabled.has("generate") && !failure) {
        if (!pickFile) {
          // 以前这里是**静默跳过**：没抽到表就不进分支，report 里没有这一项，
          // 结论仍然是"全部阶段成功"。用户以为生成跑过了，实际一条都没生成。
          skipStage("generate", "生成答案", "没有抽题产物（抽题阶段未勾选、被跳过或失败）");
        } else {
          await runStage("generate", "生成答案", async () => {
            const rows = excel.readTableRows(pickFile).map(excel.importRowToAnswer);
            return startTask("generate", {
              // filePath 必须传：生成任务**只在给了 filePath 时才把答案写回表格**
              //（见 generate.js 的 if (!filePath) return）。少传这一个字段的表现是——
              // 生成阶段"成功"、答案只存在内存里，紧接着的提交阶段重读表格发现没有回答，
              // 报「表格里有题目链接但没有回答内容」，看起来像是生成没干活。
              filePath: pickFile,
              results: rows,
              aiApiKey: settings.aiApiKey,
              aiBaseUrl: settings.aiBaseUrl,
              aiModel: settings.aiModel,
              aiConcurrency: settings.aiConcurrency,
              aiDailyTokenBudget: settings.aiDailyTokenBudget || 0,
              titleTemplate: settings.titleTemplate,
              introTemplate: settings.introTemplate,
            }, (ctx) => taskRunners.generate(ctx, taskDeps()));
          });
        }
      }

      // 4) 提交（纯文本答案 → 全账号宽松轮询，用于积累通过数/额度）
      if (enabled.has("submit") && !failure) {
        if (!pickFile) {
          skipStage("submit", "自动提交", "没有抽题产物（提交阶段读的就是那张表）");
        } else {
          await runStage("submit", "自动提交", async () => {
            const rows = excel.readTableRows(pickFile).map(excel.importRowToAnswer);
            return startTask("submit", {
              filePath: pickFile,
              results: rows,
              bitEnvs,
              submitLimit: settings.submitLimit,
              accountDailyLimit: settings.accountDailyLimit,
              dailyAnswerLimit: settings.dailyAnswerLimit,
              forceResubmit: false,
              checkCompletedEnvs: true,
              accountTopics: settings.accountTopics,
              linkRouting: settings.linkRouting,
            }, (ctx) => taskRunners.submit(ctx, taskDeps()));
          });
        }
      }

      // 网盘链的**账号分工**：转存归转存、上传归上传，两者可以不是同一批号。
      // 现实里常见「A 的网盘还有空间但没有批量发布权益，B 有权益但网盘已经满了」，
      // 分开之后 A 把资源转进自己盘并建好永久分享，B 只管把问答表传上工作台
      //（分享链接是公开的，谁上传都行）。两边都留空就回落到「本次参与的账号」。
      const roles = resolveNetdiskRoles(bitEnvs, p);
      const transferEnvs = roles.transferEnvs;
      const uploadEnvsConfigured = roles.uploadEnvs;
      // 上传账号在权益门之后会被收窄，但**搜资源**要按用户配的那批来（题材绑定挂在它们身上），
      // 所以配置值单独留一份。
      let uploadEnvs = uploadEnvsConfigured;

      // 权益门只针对**上传账号**：批量发布权益管的是"能不能把表传上工作台"，
      // 跟"资源能不能转进网盘"无关（后者看的是网盘空间）。也只在真要跑上传阶段时才查，
      // 免得白开一轮浏览器。
      if (enabled.has("upload") && !failure && !aborted) {
        const checked = await runStage("checkPermission", "确认批量发布权益", () =>
          startTask("check-published", { bitEnvs: uploadEnvsConfigured, withReasons: false }, (c) => taskRunners.checkPublished(c, taskDeps()))
        );
        if (checked && Array.isArray(checked.accounts) && checked.accounts.length) {
          // hasPermission 为 null 表示"没查到"，按不拦处理——不能因为查不到就误封账号。
          // 只看 hasPermission，**不看 ok**：ok=false 有三种成因（未登录 / 没取到上传记录 /
          // 查询抛错），它们在"有没有批量发布权益"这件事上都是**未知**，不是"没有"。
          // 以前写成 `a.ok && a.hasPermission !== false`，等于把"未知"一律当成"没有"，
          // 从没上传过的新账号和查询报错的账号全被判「没有权益」，网盘链整段跳过。
          //
          // 但**额度为 0 必须拦**：上传要扣额度，额度 0 的号上去必然失败。
          // 2026-10-10 真机实测：测试组2 剩余额度就是 0，而权益门只看 hasPermission（它是 null，
          // 从没上传过）→ 照样放行。那一次是我人工先看了额度、手动把它排除才没出事。
          // 注意只拦"明确查到是 0"，`null`（没查到）仍然放行 —— 与上面同一条原则。
          const noQuota = checked.accounts
            .filter((a) => a && a.remainingQuota === 0)
            .map((a) => a.envLabel);
          if (noQuota.length) {
            emit("task:log", `⚠️ 这些上传账号**剩余额度为 0**，上传会直接失败，已从上传账号里去掉：${noQuota.join("、")}`
              + `（额度来自答主工作台；若刚上传过、额度是扣完的状态，明天再来或换号）`);
          }
          const allowed = checked.accounts
            .filter((a) => a.hasPermission !== false && a.remainingQuota !== 0)
            .map((a) => a.envLabel);
          const denied = uploadEnvsConfigured.filter((e) => !allowed.includes(e) && !noQuota.includes(e));
          if (denied.length) emit("task:log", `⚠️ 这些上传账号没有「批量发布权益」或未登录，上传阶段会跳过：${denied.join("、")}`);
          uploadEnvs = allowed;
        }
      }

      // 5) 网盘转存：脚本套模板生成问答行（qa-template-lib），产出即上传专用表
      if (enabled.has("transfer") && !failure) {
        if (!transferEnvs.length) {
          skipStage("transfer", "网盘转存", "没有可用的转存账号");
        } else {
          let transferTable = String(p.transferTablePath || "").trim();
          // 没给资源表 → 按账号绑定的题材自动搜一批（纯协议搜百度知道，不需要浏览器）
          if (!transferTable || !fs.existsSync(transferTable)) {
            emit("task:log", "没有指定资源表，改为按账号绑定的题材自动搜资源…");
            const searched = await runStage("search", "搜资源（按账号题材）", () =>
              startTask("search-resources", {
                bitEnvs: uploadEnvsConfigured,
                pages: Number(p.searchPages) || 0,
                limit: Number(p.searchRowLimit) || 0,
              }, (c) => taskRunners.searchResources(c, taskDeps()))
            );
            if (searched && searched.outputPath && fs.existsSync(searched.outputPath)) {
              transferTable = searched.outputPath;
              addArtifact("自动搜到的资源表", searched.outputPath);
            }
          }
          if (!transferTable || !fs.existsSync(transferTable)) {
            skipStage("transfer", "网盘转存", "没有可用的资源表，自动搜索也没产出");
          } else {
            await runStage("transfer", "网盘转存（套模板生成问答）", async () => {
              const result = await startTask("batch-transfer", {
                filePath: transferTable,
                bitEnvs: transferEnvs,
                destDir: String(p.transferDestDir || "").trim() || "/来自资源批量转存",
                outName: String(p.transferOutName || "").trim(),
                perEnv: Number(p.transferPerEnv) || 50,
                // 默认并发 1（不是 4）：真机对照实验里 cc=1 零失败、cc=2 全失败、
                // cc=4 四成失败 —— 分享页的降级窗口是**同一 IP 的短时并发**触发的。
                // 详见 batch-transfer.js 里那段注释。
                cc: Number(p.transferCc) || 1,
                delayMin: Number(p.transferDelayMin) || 1,
                delayMax: Number(p.transferDelayMax) || 2,
                makeShare: true,
              }, (ctx) => taskRunners.batchTransfer(ctx, taskDeps()));
              // 转存产出的上传专用表直接喂给下一阶段，不用人工再选一次文件
              if (result && result.outputPath) {
                uploadTable = result.outputPath;
                addArtifact("上传专用表", result.outputPath);
                emit("task:log", `转存产出上传专用表：${uploadTable}（${result.count} 条）`);
              }
              return result;
            });
          }
        }
      }

      // 6) 按题材分账号上传（用转存产出，或调用方指定的现成表）
      if (enabled.has("upload") && !failure) {
        if (!uploadEnvs.length) {
          // 以前这里是静默跳过：所有上传账号都被权益门拦掉时，整段不执行也不进 report，
          // 结论依旧是"全部阶段成功" —— 而用户等的恰恰是上传。
          skipStage("upload", "按题材上传", "没有可用上传账号（都不具备「批量发布权益」或未登录）");
        } else if (!uploadTable || !fs.existsSync(uploadTable)) {
          skipStage("upload", "按题材上传", "没有可用的上传专用表（请先跑转存，或指定一张现成的表）");
        } else {
          const uploaded = await runStage("upload", "按题材上传", () =>
            startTask("upload-by-topic", {
              filePath: uploadTable,
              bitEnvs: uploadEnvs,
              accountTopics: settings.accountTopics,
              topicRules: settings.topicRules,
              batchRows: Number(p.batchRows) || 500,
              maxBatches: Number(p.maxBatches) || 999,
            }, (ctx) => taskRunners.topicUpload(ctx, taskDeps()))
          );
          // 上传完顺手核对收录。上传接口返回 200 只代表**平台收下了**，
          // 平台还要异步审核，收录结果要单独查——不查的话"上传成功"是句空话。
          if (uploaded && !failure && !aborted) {
            // 只查**真正上传过的那批账号**（uploadEnvs 已被权益门收窄）。用全部账号查的话，
            // 比特模式下会为没上传的号白开一圈窗口，而它们的工作台里本来就没有本轮的上传记录。
            const publishedCheck = await runStage("checkPublished", "查收录（核对是否被收录）", () =>
              startTask("check-published", { bitEnvs: uploadEnvs }, (c) => taskRunners.checkPublished(c, taskDeps()))
            );
            // 查收录产出的两张表是"下一步该干什么"的直接依据（被拒明细里连原因都有），
            // 所以必须进产物清单，不能只躺在日志里。
            if (publishedCheck) {
              addArtifact("收录核对", publishedCheck.outputPath);
              addArtifact("被拒明细", publishedCheck.failedPath);
            }
          }
        }
      }
    } catch (error) {
      // 兜底：阶段本身已经各自 try/catch 了，能走到这里的是编排自身的问题
      //（比如 config.load 抛错）。当作"某阶段失败"处理，别让异常裸奔到 IPC 层。
      failure = failure || error;
      emit("task:log", `⚠️ 一键全自动异常终止：${error.message}`);
    }

    // ⚠️ 这里**不能**再把 aborted 复位（原来是在 finally 里复位的，于是紧接着读它的
    // `tail` 和 `stopped` 永远是 false —— "已手动停止"这句话从来没显示过，
    // 界面上把手动停止显示成"全部阶段成功"）。复位放在 run() 开头。
    const okCount = report.filter((r) => r.ok).length;
    // "已停止"也是 skipped，但它不是"没跑成"，不该混进跳过清单里重复说一遍
    const skipped = report.filter((r) => r.skipped && r.error !== "已停止");
    const failedStage = report.find((r) => !r.ok && !r.skipped);
    const tail = aborted ? "（已手动停止）" : failure ? `（在「${failedStage ? failedStage.label : "未知阶段"}」中断）` : "";
    const skipTail = skipped.length ? `，${skipped.length} 个阶段被跳过：${skipped.map((s) => s.label).join("、")}` : "";
    emit("task:log", `══════ 一键全自动结束：${okCount}/${report.length} 个阶段成功${skipTail}${tail} ══════`);
    return {
      ok: !failure && !aborted,
      stopped: aborted,
      stages: report,
      pickFile,
      // 给界面用：ok 为 true 但这里有内容时，文案不能说"全部阶段成功"
      skipped: skipped.map((s) => ({ stage: s.stage, label: s.label, reason: s.error })),
      // 本轮产出的文件（抽题表 / 上传专用表 / 收录核对 / 被拒明细 …），界面直接给"打开/定位"
      artifacts,
    };
  }
}

module.exports = { createAutoPipeline, ALL_STAGES, normEnvs, summarizeStage };
