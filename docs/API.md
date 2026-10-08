# API 文档（IPC 接口契约）

> 本项目的"后端接口"是 **Electron 主进程 IPC 通道**，不是 HTTP 服务。
> 渲染端通过 `preload.js` 白名单调用 `window.api.invoke(通道名, payload)`，
> 通道实现集中在 `electron/app-context.js`，白名单在 `electron/preload.js`。
>
> 任何通道增删、payload 字段增删都必须同步更新本文件。
> `tests/unit/contract.test.js` 会强制校验"任务读取的 payload 字段必须由 renderer 传入"。

## 1. 通用约定

| 项 | 说明 |
|----|------|
| 调用方式 | `window.api.invoke(通道名, payload)` → `Promise<响应>` |
| 通道白名单 | `electron/preload.js` 的 `invokeChannels`；未登记的通道直接 reject |
| 错误约定 | 主进程 `throw` → Promise reject，渲染端 `error.message` 为可直接展示的中文描述 |
| 进度推送 | 主进程 → 渲染端单向事件：`task:log`（日志行）/ `task:progress`（进度）/ `task:item`（逐条结果） |
| 任务互斥 | 同一时刻只允许一个任务运行；运行中再起任务抛错"已有任务正在运行" |
| 任务控制 | `task:stop` / `task:pause` / `task:resume` 对当前任务生效 |

### 任务类通道的响应信封（部分任务只返回其中一部分字段）

```json
{
  "stopped": false,      // 是否被用户主动停止
  "count": 12,           // 成功条数
  "failed": 1,           // 失败条数
  "total": 13,           // 本轮计划处理条数
  "results": []          // 逐条结果（含状态、比特环境、时间戳）
}
```

不同任务返回的字段不同，见下表的"响应补充字段"列；未列出的字段以 `electron/app-context.js` 的实际返回为准。

## 2. 任务通道

| 通道 | 说明 | 主要请求字段 | 响应字段 |
|------|------|--------------|----------|
| `task:crawl` | 按分类分页爬题入库 | `bitEnvs`、`category`、`crawlStartPage`、`maxQuestions` | — |
| `questions:random-pick` | 按分类随机抽题导出表格 | `categories`、`count`、`outputPath`、`skipGenerated` | `canceled`、`filePath`、`count`、`total`、`remainingAfter`、`resetRound` |
| `task:generate` | 批量 AI 生成回答并写回表格 | `results` 或 `filePath` | — |
| `task:submit` | 自动提交答案 | 见 §3 | 信封 + 见 §3 |
| `task:passed-count` | 核对各账号当天通过数 | `bitEnvs` | `accounts[]`：`{ bitEnv, status, done, total, format, raw }`，`status` ∈ `completed`/`partial`/`unknown`/`error` |
| `task:batch-transfer` | 网盘批量转存 | `bitEnvs`、`excelPath`、`destDir` | — |
| `task:batch-upload` | 按账号批量上传 | `bitEnvs`、`filePath` | — |
| **`task:upload-by-topic`** | **新增**。按分类规则给每行派生题材，**拆成一个题材一张表**，每张表交给绑定了该题材的账号上传 | `filePath`、`bitEnvs`、`accountTopics`、`topicRules`、`batchRows`、`maxBatches` | `uploaded`、`splitDir`、`topicTables[]`：`{ topic, file }`、`accounts[]`：`{ envLabel, topic, planned, uploaded, table, error? }` |
| `task:crawl-home` | 从答主主页找网盘资源 | `homepages`、`enrichLimit` | `count`、`stats`、`outputPath` |
| **`task:auto-pipeline`** | **新增**。一键全自动：按阶段串行跑「爬题 → 抽题 → 生成 → 提交 → 转存 → 按题材上传」 | `stages[]`（可选值 `crawl`/`pick`/`generate`/`submit`/`transfer`/`upload`）、`pickCount`、`batchRows`、`uploadTablePath`、`transferTablePath`、`transferDestDir`、`transferOutName`、`transferPerEnv`、`transferCc`、`transferDelayMin`、`transferDelayMax` | `ok`、`stopped`、`pickFile`、`stages[]`：`{ stage, label, ok, skipped?, error? }` |

> `task:auto-pipeline` 与其它任务通道不同：它**不是**单个 TaskManager 任务，
> 而是在主进程按阶段串行调用 `startTask`（TaskManager 单任务互斥，包成一个大任务会直接冲突）。
> 因此它没有 `stopped/count/failed/total/results` 信封，返回的是阶段级报告。
> 任一阶段抛错即停；调用 `task:stop` 会置中止旗标，后续阶段不再启动。


## 3. `task:submit` 请求字段（含本轮变更）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `filePath` | string | — | 来源答案表格；为空时自动使用 `settings.lastPickFilePath` |
| `results` | array | `[]` | 直接传行数据（有则优先于 `filePath`）；每行需有 `questionUrl` + `answer` |
| `bitEnvs` | array | — | 参与提交的比特环境名；**必填**，为空抛错 |
| `submitLimit` | number | 0 | 本轮提交总条数上限，0=不限 |
| `accountDailyLimit` | number | 0 | 每账号本轮提交上限（风控语义），0=不限 |
| `dailyAnswerLimit` | number | 0 | 本次总回答上限，0=不限 |
| `forceResubmit` | boolean | false | 是否重交 `status=已提交` 的行 |
| `checkCompletedEnvs` | boolean | true | 提交前调用通过数核对，跳过已达标账号 |
| **`accountTopics`** | object | `{}` | **新增**。`{ "环境A": "情感类" }`，账号 ↔ 题材绑定表 |
| **`linkRouting`** | string | `"strict"` | **新增**。`strict`=带链接答案按账号↔题材严格一对一；`off`=退回普通轮询 |

### 变更点（v2.2 · 2026-10-08）

- 新增 `accountTopics` / `linkRouting` 两个字段，实现"带链接答案按题材一对一投递"。
- 未传 `accountTopics` 时行为不变（所有行按普通轮询分配），**向后兼容**。
- 逐行结果新增按形态分流：带链接的行只投给绑定了该题材的账号；
  纯文本行不受绑定表限制，仍摊到全部账号（前期积累额度阶段）。

### 分配规则

```
带链接的行（回答含网盘链接/任意外链/提取码）
    └─ 按 题库分类 分桶 → 只投给 topicOf(账号) == 该题材 的账号
    └─ 该题材无绑定账号 → 整批本轮不提交，日志提示去「比特环境」页绑定

纯文本行
    └─ 轮询摊到全部账号（含已绑定题材的账号）

每账号容量 = min(accountDailyLimit, submitLimit)，均为 0 表示不限
链接行先占额度，纯文本行吃剩余容量
```

### 响应示例

```json
{
  "stopped": false,
  "count": 8,
  "failed": 1,
  "total": 9,
  "results": [
    {
      "questionUrl": "https://zhidao.baidu.com/question/123.html",
      "category": "情感类",
      "answer": "……",
      "bitEnv": "环境A",
      "status": "已提交",
      "confirmed": true,
      "submittedAt": "2026/10/8 14:32:10"
    }
  ]
}
```

失败行的 `status` 形如 `提交失败：【网络/连接】……`（分类标签由 `src/errors.js` 生成）。

## 4. 更新通道

| 通道 | 说明 | 请求 | 响应 |
|------|------|------|------|
| `update:info` | 当前版本与更新能力 | — | `{ version, supported, ready, available, releasesUrl }` |
| `update:check` | 检查更新**并自动下载**（打包版才可用） | — | `{ currentVersion }` |
| `update:install` | 重启并安装已下载的新版 | — | `{ ok: true }`；新版未下载完则抛错 |
| `update:ready` | **推送通道**。新版本下载完成时发出 | — | `{ version }` |
| `update:available` | **推送通道**。启动静默检查发现有新版时发出 | — | `{ version, current }` |

**变更点（v2.2 · 2026-10-08）**

- `update:info` 新增 `ready` 与 `available`：
  - `ready` 来自主进程 `updateReady`，界面据此启用「重启并安装新版」——
    **此前是匹配运行日志里的 `"下载完成。重启软件即自动安装"` 文本来判断的**，
    日志措辞一改按钮就永远不亮且不报错。
  - `available` 是有新版但尚未下载时的版本号，界面据此显示顶部提示条。
- 新增推送通道 `update:ready` / `update:available`。
- **启动静默检查**：`registerIpc` 后 20 秒自动 `checkForUpdates({ download: false })`，
  只查不下载，发现新版推 `update:available` → 界面顶部出现可点提示条。
  注意 `autoDownload` 是全局开关，必须按调用设置——一直开着的话启动检查会在用户
  毫不知情时吃掉约 85MB 流量。开发模式（`app.isPackaged=false`）直接抛错跳过，不发请求。
- 推送通道清单在 `src/ipc-channels.js` 与 `preload.js` 各有一份（preload 在 sandbox 下
  拿不到本地模块），一致性由 `tests/unit/contract.test.js` 契约①-b 强制。

**更新流程是两步**，不是一步：

```
启动 20s 后静默检查（只查）→ 顶部提示条「发现新版本」→ 点它 = 检查并下载
                                                    → 「重启并安装新版」亮起 → 重启安装
                                              或直接退出软件，退出时自动装
```

最后一步保持人工是有意的：自动重启会打断正在跑的答题/上传任务。

## 5. 设置通道

| 通道 | 说明 |
|------|------|
| `settings:get` | 返回归一化后的完整设置对象 |
| `settings:save` | 传入 patch，返回保存后的完整设置；后端 `normalizeSettings` 负责夹取与回退 |

本轮新增设置项：

| 设置键 | 类型 | 默认 | 说明 |
|--------|------|------|------|
| `accountTopics` | object | `{}` | 账号 ↔ 题材绑定。接受对象 / `[{account,topic}]` / 文本 `"账号=题材"`，后端统一归一化 |
| `linkRouting` | `"strict"` \| `"off"` | `"strict"` | 非法值一律回退 `strict` |
| `topicRules` | string | 内置 8 条规则 | 上传侧的关键词分类规则，每行 `分类名=关键词1\|关键词2`；为空回退默认规则 |

**题材命名空间有两套**，绑定表用的是原始字符串，不做白名单校验：

- **答题路径**（`task:submit` 的 `accountTopics`）：题材是 `情感类 / 教育类 / 综合类 / 人物类`，
  与题库的 `题库分类` 列对应。用户写"情感"会自动补全为"情感类"。
- **上传路径**（`topicRules` 派生）：题材是规则里的分类名，如 `游戏 / 影视 / 小说 / 漫画 / 音乐 / 课程 / 软件 / 资料`。

两套命名空间共用同一张绑定表。绑定了一个路径用不到的题材不会报错，
只会让该路径匹配不到账号——匹配结果会在日志里明确报出来（见 `submit.js` 的题材孤岛告警）。
