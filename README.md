# dsh-qq-bot

DeepSeek Harness（dsh）× QQ 适配插件：以 **OneBot 11** 协议接入 QQ，把私聊与群聊变成 dsh agent 的对话入口。

设计原则：**复用 dsh 原生的 agent loop、工具系统与会话持久化，本插件只做 QQ 适配与聊天体验层。**

```
OneBot 11 对接端 ⇄ Transport（正向/反向 WS）⇄ OneBot 协议层 ⇄ Pipeline ⇄ ChatBridge ⇄ dsh agent
```

运行环境：Node ≥ 22.19.0，dsh ≥ **0.2.1-rc.2**（长期记忆使用 `node:sqlite` + FTS5；向量检索通过 `sqlite-vec` 运行时按需安装）。

## 快速开始

### 1. 安装插件

```bash
# 从 npm 安装
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add dsh-qq-bot
```

本地开发（改完重新 build 即生效）：

```bash
npm install --legacy-peer-deps   # dsh 包互为 peer 依赖，插件环境需显式放宽；ws 等运行时依赖也装在这里
npm run build && npm test

# 挂进 profile：本地路径务必用 link:，不要用 file:
npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add link:/path/to/dsh-qq-bot
```

> **本地路径必须用 `link:`。** profile 使用 hoisted 链接器，`file:` 依赖会被复制/硬链接成一份快照，
> 只有安装那一刻已存在的文件才会同步：新增模块、文件改名、新产物（`.js` / `.d.ts` / `.map`）都不会出现，
> 下次启动 dsh 会因 `ERR_MODULE_NOT_FOUND` 直接失败。`link:` 是符号链接，构建产物始终最新。

### 2. 配置 OneBot 11 对接端

二选一（两侧 token 需一致，对应插件配置 `accessToken`）：

**正向 WS（默认）**：对接端开 WebSocket 服务端，监听 `0.0.0.0:3001`（或仅本机）；
插件配置 `url: ws://127.0.0.1:3001`。

**反向 WS**：对接端开 WebSocket 客户端，URL 填 `ws://127.0.0.1:6199/ws`；
插件配置 `transport: reverse`（插件监听 6199 端口）。

### 3. 最小配置

```yaml
# <profile>/cordis.patch.yml 按 id 覆盖（整行 config 替换）
- insert:
    - id: dsh-qq-bot
      name: 'dsh-qq-bot'
      config:
        url: ws://127.0.0.1:3001
        accessToken: 'your-token'
        privateMode: allowlist
        allowedUsers: ['你的QQ号']        # allowlist 为空 = 全拒，必须显式配置
        groupMode: allowlist
        allowedGroups: ['目标群号']
        adminUsers: ['你的QQ号']
        # 其余项建议在 dsh WebUI「设置 → dsh-qq-bot」里改（见下）
```

常用环境变量（完整列表见 `cordis.patch.yml`）：`DSHQQ_WS_URL` / `DSHQQ_TRANSPORT` / `DSHQQ_REVERSE_PORT` /
`DSHQQ_ACCESS_TOKEN` / `DSHQQ_ADMIN_USERS` / `DSHQQ_DATA_DIR` / `DSHQQ_EXA_API_KEY` / `DSHQQ_TAVILY_API_KEY`
（旧名 `DSHQQ_WORKSPACE_ROOT`、`DSHQQ_GROUP_ROOT` 仍兼容，仅在未设 `DSHQQ_DATA_DIR` 时兜底）。

## 功能概览

配置页按 **一张卡 = 一个功能域** 组织，共 19 张，分三段（长期记忆拆成「长期记忆」配置卡与「记忆库」管理卡）。

### 接入与安全

| 卡片 | 能力 |
|---|---|
| 连接 | 正向/反向 WS、地址与端口、access token、重连退避、HTTP 超时；折叠头部有实时连接状态角标 |
| 访问控制 | 准入三态（`allowlist` / `open` / `disabled`）×私聊/群聊、白名单、用户与群黑名单、动态管理员、好友与群请求自动同意 |
| 工具权限 | 三层安全的工具层：`restrictTools` + `userTools` / `blockedTools`；主动消息工具注册；定时任务开关与单会话上限 |
| 网页搜索 | `qq_web_search`：Exa / Tavily / dsh 内置排成**可排序列表**，依次尝试，失败或没有结果自动顺延；密钥、端点、条数与超时 |

### 对话体验

| 卡片 | 能力 |
|---|---|
| 唤醒 | 群聊 @ 触发、唤醒前缀（单行逗号分隔）、私聊免唤醒；信息过滤前缀（命中即整条忽略） |
| 会话与限速 | 群聊共享/独立会话、按会话滑动窗口限速、排队上限、无进展中断、空闲回收、写句柄占用策略 |
| 回复形态 | 按单条上限切块、超长折叠为合并转发、引用原消息（被 @ 时默认引用）、引用反查上限、回复 @ 触发者 |
| 群成员识别 | 成员名单（TTL + 落盘 + 单飞刷新，含角色与最近发言人）注入 system prompt；引用还原与 @ 语义化 |
| 聊天记录 | `qq_read_history`：本地内存缓冲 + 对接端历史接口合并，只能读当前会话 |
| 提问与回答 | agent 的 `ask_user_question`（含计划确认）转发到 QQ，接受 QQ 回复作为答案；与 dsh 界面两边谁先答用谁 |
| 长期记忆（RAG） | 默认关闭。聊天写入本地 `<数据目录>/memory.db`，按 4 条/400 字切 chunk；FTS5 中文分词 + 可选 `sqlite-vec` 向量召回，开启重排时用本地 bge-reranker-base；相关片段注入 user 尾部（不进 system prompt）。WebUI「记忆库与技能」可查看检索结果、最近片段、运行时状态，本地模型未下载时可直接在卡片里点「下载」（下载中显示进度条，完成后显示「已安装」）。embedding 模型固定为 `Xenova/bge-small-zh-v1.5`（512 维）：模型 id 与向量表维度（`float[512]`）绑死，换模型要改代码并把历史重新向量化，所以卡片里只做**只读展示**、不给编辑框；重排模型、下载源与精度只在配置文件里可改（`memoryRerankModel` / `memoryHfEndpoint` / `memoryHfMirror` / `memoryEmbeddingDtype`，默认直连失败自动切 hf-mirror.com、精度 int8）。**没有用户画像/群成员画像/蒸馏** |
| 媒体与互动 | 收图落盘到会话媒体目录并把绝对路径交给 agent；戳一戳自动回复 |
| 定时任务 | 任务总览与手动管理（启停/改期/删除/立即执行/新建）；任务绑定创建会话；每个任务可选「直接推送」（不调模型）或「agent 执行」 |
| 人格 | 一张卡两个子分节：〔会话人格〕每个会话目录一份 `SOUL.md`，是人格的唯一生效源，可查看/编辑/恢复默认模板/套用模板，保存后重建当前会话；〔人格模板〕模板增删改（`personas.json`），只用于「还没有 SOUL.md 的会话」播种或手动套用 |
| 会话模型设置 | 首行「默认会话」，下方按会话逐行指定**模型 + 思考强度**。会话从下拉里选（群名 / 好友备注来自 QQ 的 `get_group_list` / `get_friend_list`，未连接时列已有会话目录，清单里没有可切「手动输入」），不用手抄号码；模型选项来自 dsh 的模型元数据。人格不在这里，去「人格」卡改 SOUL.md |

### 运行与维护

| 卡片 | 能力 |
|---|---|
| 消息日志与诊断 | 对接端收发、发往 QQ 的 action、dsh 的 prompt 与回复原文、管线丢弃原因、搜索与问答记录；卡内嵌 SSE 实时日志视图（断线自动重连/降级轮询，可过滤与清空） |
| Agent 与工作目录 | Agent 预设、工作目录模式（会话目录 / 主目录）、数据目录；真实时间感知由 dsh 内置 `time-context` 提供 |

**几个值得知道的点**：

- **时间感知复用 dsh 内置能力**：`standard`、`cordis`、`ptc` 预设自带的 `time-context` 会在模型步骤前追加真实时间、时区与距上条消息的经过时长，并持久记录到会话中；本插件不再自行拼接时间或注册重复的 system prompt section。`minimal` 或自定义预设没有挂载时，QQ 桥会直接补挂同一个内置插件。
- **长任务不设总时长超时，只有"无进展"兜底**：一轮跑多久由 agent 自己决定，跑几小时的长任务不会被按时间腰斩。兜底是「无进展中断」`turnIdleTimeoutMs`（默认 15 分钟，0 = 关）：连续这么久**没有任何会话事件**（模型输出、工具调用）才判定卡死并中断，等用户回答期间不计时。真卡住时发 `/stop` 可手动打断当前这一轮（不清历史、不换会话）。
- **切块与折叠**：回复一律按单条上限切块；超过阈值可折叠成合并转发消息（QQ 的"聊天记录"）。
- **定时任务分两种投递方式**：`direct`（直接推送）到点只渲染模板并发送，**不创建/不唤醒 agent、不消耗 token，也不占会话队列**——固定提醒、每日播报、"开服第 N 天"都用它。模板占位符：`{date}`、`{time}`、`{weekday}`、`{daysSince:YYYY-MM-DD}`（起始日算第 1 天），例如 `今天是原神开服第{daysSince:2020-09-15}天`。`agent` 模式才在到期时唤醒模型执行（需要查天气、查资料、调工具时）。旧任务没有 `delivery` 字段，按 `agent` 兼容；WebUI 任务卡片和 `task_schedule` 的 `delivery` 参数都能选。
- **群聊里不提 QQ 号**：所有给模型看的文本（发言人标签、@ 提及、成员列表、聊天记录、引用块、记忆检索）只给昵称；号码仅用于插件内部。代价是重名成员无法靠号码区分。
- **写句柄先占 + fork 兜底**：dsh 会话是单写者模型，在 dsh WebUI 里打开一个 QQ 会话就会占住写句柄。插件默认 `sessionIdleTimeoutMs: 0`（建立的会话永不回收），并在启动与重建后立刻占住，让界面只能复用同一个 agent；真被界面抢先时默认 `busyStrategy: fork`——从原会话的完整事件前缀分叉出新会话继续（`forkMaxEvents`，默认 4000 条，超出才回退），旧会话原样留给界面。`wait` 保留给"等界面关掉后继续原会话"的场景（`busyWaitMs`，默认 5 分钟，超时再 fork），`rotate` 只作最后兜底。`/status` 的「写句柄」行与 `/reclaim` 是配套入口。
- **数据与工作目录同源**：每个聊天对象一个目录，它同时是 agent 默认工作目录、WebUI 左栏工作区与媒体落盘根；上下文隔离由 chatKey → 独立 sessionId 保证，不靠目录。
- **网页搜索、长期记忆/技能工具默认只给管理员**（`qq_web_search`、`qq_recall_memory`、`qq_use_skill`、`qq_list_skills` 不在聊天工具白名单里）；要让普通用户用，把它们加进 `userTools`。
- **人格是每会话一份 `SOUL.md`**：首次建 agent 时从当前人格模板播种一次，之后文件是唯一生效源；`personas.json` 只做模板库，`chat-overrides.json` 只保留模型（旧 persona 字段仅用于首次播种）。改完文件后发 `/persona reload`，或在 WebUI「人格」卡的〔会话人格〕子分节里保存，会重建当前会话；`/persona <模板>` 用模板覆盖、`/persona reset` 恢复默认。不做旧数据迁移。**注意**：agent 有文件工具、cwd 就是会话目录，所以它能看到/改写 `SOUL.md`；别把 `write` / `edit` 随便放进普通用户的 `userTools`。
- **RAG 只按当前会话检索**：每个 chatKey 独立库表，模型无法指定别的群/QQ 号；检索结果只给昵称与内容，QQ 号不进模型可见文本。没有成员画像、没有按人的聚合档案；「记住」只靠普通聊天进 RAG，需要时由 `qq_recall_memory` 检索。
- **热应用**：绝大多数配置改完即生效、无需重启。需要重启 dsh 的只有 `dataDir` 与「工具是否注册」类开关（`registerSendTools`、`tasksEnabled`、`historyEnabled`、`searchEnabled`）；长期记忆的总开关连工具一起即时注册/注销，模型/运行时配置变化会重启 RAG worker。

## ⚠️ 安全须知（务必阅读）

QQ 群/私聊是**无认证入口**：任何能给机器人发消息的人都可能驱动 dsh 的能力——包括 **Shell、文件写入、联网**。本插件用三层权限控制这个面：

| 层 | 管什么 | 配置 |
|---|---|---|
| 入口权限 | 谁能触发对话 | `privateMode`/`groupMode` + 白/黑名单（**allowlist 空 = 全拒**） |
| 命令权限 | 谁能用管理命令 | `adminUsers`（adminOnly 命令 + 共享群 `/reset`） |
| **工具权限** | **谁能驱动 agent 的 Shell/文件等** | `restrictTools`（默认开）+ `userTools` + `blockedTools` |

默认行为即"**普通用户仅能对话，管理员才可以让 agent 操作电脑**"：

- `restrictTools: true` 时，非管理员触发的轮次里，不在 `userTools` 白名单的工具会被拦截，模型收到权限解释并转告用户
- `userTools: []`（默认）= 普通用户纯对话；可按需开放安全工具，如 `['web_search', 'read*']`（支持尾部 `*` 通配）
- **搜索 ≠ 抓网页**：`qq_web_search` 只负责搜索；要让它打开用户给的具体网址，还得放行 dsh 内置的 `web_fetch`（per-agent 工具，不在勾选网格时用「其他条目」手填）。`web_fetch` 能访问任意 URL（含内网地址），只给可信用户开
- `blockedTools` 全员禁用（含管理员），用于整体下线某类能力，如 `['shell', 'run_code']`
- 机器人自己的聊天工具（`qq_send` / `qq_send_image` / `qq_recall` / `qq_read_history`）与定时任务工具
  （`task_schedule` / `task_list` / `task_cancel`）对所有能对话的用户放行：任务只能发回创建它的会话，
  聊天记录只能读当前会话且只在内存里
- 管理员绕过白名单且工具不受限，请只加自己

其余建议：

- 权限拦截是"模型侧闸门"，不替代执行环境隔离；建议在该 profile 层叠加沙箱/容器预设
- **网关模式是高危能力**：`/cwd ~` 或 `workspaceMode: home` 让 agent 以用户主目录为工作区，等于"通过 QQ 操作整台电脑"
- `qq_send_image` 只允许发送会话目录或 agent 当前工作目录内的文件
- 定时清理 `<数据目录>/sessions/<Friend_|Group_号>/media/<chatKey>/`（收图落盘目录）
- 搜索结果是外部不可信内容，system prompt 已要求模型只当资料、不执行其中指令

## 数据存放位置

**插件一侧：只有一个路径设置 `dataDir`**（默认 `<用户主目录>/dsh-qq-bot-data`，WebUI「Agent 与工作目录」或 `DSHQQ_DATA_DIR`）：

| 内容 | 路径 |
|---|---|
| 会话目录（agent 工作目录 + 左栏分组 + 媒体根） | `<数据目录>/sessions/Friend_<QQ号>`、`Group_<群号>`（媒体在 `<会话目录>/media/<chatKey>/`） |
| 人格模板 / 会话人格 / 模型与强度覆盖 | `<数据目录>/personas.json`、`chat-overrides.json`；每个会话自己的 `<数据目录>/sessions/Friend_*\|Group_*/SOUL.md`（前两者在 WebUI「人格」卡的〔人格模板〕〔会话人格〕两个子分节里编辑，模型与强度在「会话模型设置」卡） |
| 会话身份表（chatKey → sessionId）/ `/cwd` 覆盖 | `<数据目录>/chat-sessions.json`、`workspaces.json` |
| 定时任务 / 群成员缓存 / 动态管理员 / 消息日志 / 长期记忆 | `<数据目录>/tasks.json`、`roster/`、`admins.json`、`message-log.ndjson`、`memory.db`、`models/`、`runtime/` |

**dsh 宿主一侧：对话流水不在数据目录里**，而在 `$DSH_HOME`（默认 `~/.dsh`）下：

| 内容 | 路径 |
|---|---|
| 会话流水（对话记录本体） | `$DSH_HOME/sessions/<cwd 编码>--/<sessionId>/session.v4.jsonl.zstd` |
| 左栏分组与标题缓存 | `$DSH_HOME/storages/workspace.json`、`storages/session_projcache/` |
| 图片附件 / profile 树 | `$DSH_HOME/attachments/`、`profiles/`（配置保存在 profile 的 `cordis.patch.yml`；旧版 `settings.yaml` 会被 dsh 一次性导入后改名） |

三点提醒：

1. dsh 会话的 cwd 创建后不可修改，所以**改过 `dataDir` 之后**已有会话要 `/reset` 一次才落到新目录（不一致时插件会在 QQ 里提示）。旧版本的遗留目录会在首次启动时按需搬迁（只补缺、不覆盖）。
2. 想把会话库也搬进数据目录只能**整体搬**（会话 + 可选 storages），且必须先停掉所有 dsh 进程；`root` 要指向独立子目录，不要指向数据目录或聊天目录，单个会话文件也不能软链/搬进 `Friend_<QQ号>/`（会被判 `corrupt session log`）。
3. 只想看聊天记录时用「消息日志与诊断」卡片或 `/logs`，**不要点开那个会话本身**——点开等于占住写句柄。

## 命令与工具

**内置命令**：`/help` `/status` `/reset` `/new` `/stop` `/sid` `/model` `/persona` `/cwd` `/op` `/deop` `/logs` `/tasks` `/memory` `/ping` `/reclaim`
（`/memory` 支持 `status`、`search <词>`、`recent [n]`、`forget <id>`（管理员）、`reindex`、`prune`、`setup`；`/skill` 支持 `list`、`show <名称>`、`on/off`、`forget`、`promote`、`learn`）

**Agent 工具**：

| 工具 | 用途 |
|---|---|
| `qq_send` / `qq_send_image` / `qq_recall` | 主动发消息 / 发图 / 撤回 |
| `qq_read_history` | 读取当前会话最近的聊天记录 |
| `qq_web_search` | 按配置顺序联网搜索（默认仅管理员） |
| `task_schedule` / `task_list` / `task_cancel` | 定时任务的登记 / 查询 / 取消（`delivery: direct` 为零 token 直接推送，`agent` 为到期唤醒模型） |
| `qq_recall_memory` | 检索当前会话的 RAG 历史（默认仅管理员） |
| `qq_use_skill` / `qq_list_skills` | 加载/列出当前会话 + 全局的自演进技能（默认仅管理员） |
| `ask_user_question`（dsh 内置） | 需要用户拍板时提问，问题与答案经 QQ 往返 |

## WebUI 配置界面

dsh WebUI 的**设置**左列有独立的「qq-bot 配置」入口（需 dsh ≥ 0.2.1-rc.2）。页面与内置卡片同构：

- 每个折叠卡片**独立暂存与保存**，保存后不收起，展开态写入 sessionStorage（刷新后仍保持）
- 保存通过 dsh 的 settings/config-editor 写入当前 profile 的 `cordis.patch.yml`（revision fence 防并发覆盖），bundle/patch 默认值继续生效
- 配置字段在 schema 上标记为 `.volatile()`：dsh 以稳定引用热更新，不重启插件；插件监听 `loader/volatile-update` 原地合并（连接参数变化会自动重建 transport）
- 只读部署自动禁用；界面文案只做中文（不维护英文译文，英文界面同样显示中文）
- `accessToken` 与各 API Key 为**只写字段**（宿主脱敏、永不回显，留空保存 = 保持不变）
- 「人格」「会话模型设置」「定时任务」的数据走插件自建 RPC（编辑 `personas.json` / `SOUL.md` / `chat-overrides.json` / `tasks.json`），保存后所有会话下一条消息即按新配置重建（历史保留）

## 插件间组合（Cordis Service）

本插件提供名为 **`dshQQBot`** 的宿主侧 Service，其他 dsh 插件可以复用同一条 QQ 连接，不必再维护 napcat / WebSocket：

```ts
export const inject = ['dshQQBot'];

export function apply(ctx: Context) {
  await ctx.dshQQBot.sendText({ chatType: 'group', groupId: '群号' }, '你好');
  ctx.effect(() => ctx.dshQQBot.onMessage(async (message) => {
    if (message.text !== '#我的命令') return false; // false = 交还主管线
    await ctx.dshQQBot.sendText(
      message.chatType === 'group'
        ? { chatType: 'group', groupId: message.chatId }
        : { chatType: 'private', userId: message.chatId },
      '收到',
    );
    return true; // true = 已消费，不再进入 agent
  }));
}
```

- `sendText(target, text)` 返回 `{ messageId: number | null }`；`null` 表示对接端没有确认，调用方应视为失败。主动发送仍受本插件的渠道准入、白名单与黑名单约束。
- `onMessage(handler)` 用于轻量 `#命令` 等扩展；处理器位于防环、去重、信息过滤与访问控制之后，**唤醒与 agent 之前**，所以群聊命令无需 @。只公开归一化文本，不公开内部会话桥或任意 OneBot action。
- 公共类型从包入口导出（`DshQQBotService` / `QQServiceTarget` / `QQServiceMessage` / `QQMessageHandler`）；运行时消费者只需依赖 Cordis 服务名。

实际组合示例：

- [`dsh-deepseek-peak-reminder`](../dsh-deepseek-peak-reminder)：DeepSeek 峰谷时段提醒。
- [`dsh-deepseek-status-monitor`](../dsh-deepseek-status-monitor)：订阅官方状态 RSS，推送 API 事件。

## 开发

```bash
npm install --legacy-peer-deps                # 必须带 --legacy-peer-deps
npm run build                                 # tsc + client 类型检查 + esbuild 打包 dist/client.js
npm run dev                                   # tsc --watch（client bundle 另开 npm run dev:client）
npm test                                      # vitest run
npx vitest run src/pipeline/access.test.ts    # 跑单个测试文件
```

纯 ESM，相对导入必须带 `.ts` 扩展名；`strict` + `noUncheckedIndexedAccess` 开启；
日志走 `ctx` 注入的 Logger；测试与源码同目录（`*.test.ts`）。

## 架构

```
src/
├── index.ts          # 插件入口（name/inject/Config/apply + WebUI settings 注册 + RPC 通道）
├── service.ts        # 插件间组合面（dshQQBot Cordis Service：受准入约束的主动发送 + 轻量消息处理器）
├── config.ts         # schemastery 配置 schema
├── paths.ts          # 统一路径解析（唯一的路径设置 dataDir）+ 旧路径/数据文件迁移
├── configSync.ts     # WebUI 配置热应用（原地合并 + transport 重建判定）
├── webRpc.ts         # 自建 WebUI RPC 通道（prefix 路由 + 报文信封 + connection 鉴权）
├── dsh.ts            # dsh 服务最小类型面（升级时只改这里）
├── client/           # 浏览器半：WebUI 设置页（一张卡 = 一个功能域，构建为 dist/client.js）
├── transport/        # base（echo 通道）/ forward（正向 WS）/ reverse（反向 WS）
├── onebot/           # segments（CQ 码）/ events（归一化）/ api（action 封装）/ roster（群成员）/ history（记录缓冲）
├── pipeline/         # access（白名单限速去重）/ wake（唤醒与信息过滤）/ dispatcher（分发）
├── bridge/           # chat（会话桥 + /cwd 切换）/ reclaim（写句柄占用策略）/ modelRoutes / workspaces / agentRunner / prompt / ask + asker（提问中继）
├── outbound/         # chunk（按单条上限分块）
├── media/            # inbound（收图落盘）
├── logs/             # 消息日志（环形缓冲 + 订阅 + NDJSON + SSE 实时流 + 出站 action 包装 + /logs 渲染）
├── persona/          # store（人格模板 + 会话覆盖）/ soul（每会话 SOUL.md）/ routes（friend_/group_ 选择器）/ rpc
├── tasks/            # 定时任务：schedule（时间表纯逻辑）/ template（direct 模板）/ store / scheduler / rpc
├── search/           # 网页搜索：priority（排序列表纯函数）/ providers / chain（顺延）/ service
├── memory/           # 长期记忆 RAG：rag/（db、chunk、fusion、render、worker、runtime、client）/ skills/（learn）/ guard / text / service / rpc
├── commands/         # 内置命令
└── tools/            # qq_* 与 task_* 工具
```

dsh 还在 developer preview，API 可能有破坏性变更。所有 dsh API 调用集中在 `bridge/`、`tools/` 与 `dsh.ts`，升级时优先核对这三处。

## 相关文档

- `docs/memory-design.md` — 长期记忆 RAG + 自演进技能的设计与取舍
- `docs/memory-market-research.md` — 同类插件/记忆层/产品级实现的市场调研与改造建议
- `docs/auto-deploy.md` — 推送到 Gitea 后由远端定时器自动拉取、构建、测试并重启

## License

MIT
