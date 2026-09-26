# dsh-qq-bot

DeepSeek Harness（dsh）× QQ 适配插件：以 **OneBot 11** 协议接入 QQ，把私聊与群聊变成 dsh agent 的对话入口。

设计原则：**复用 dsh 原生的 agent loop、工具系统与会话持久化，本插件只做 QQ 适配与聊天体验层。**

```
OneBot 11 对接端 ⇄ Transport（正向/反向 WS）⇄ OneBot 协议层 ⇄ Pipeline ⇄ ChatBridge ⇄ dsh agent
```

运行环境：Node ≥ 22.19.0，dsh ≥ 0.1.0-rc.6（长期记忆需 Node ≥ 23.4，或 Node 22.x 加 `--experimental-sqlite`）。

## 快速开始

### 1. 安装插件

```bash
# 从 npm 安装
npx @deepseek-ai/dsh plugin --profile web add dsh-qq-bot
```

本地开发（改完重新 build 即生效）：

```bash
npm install --legacy-peer-deps   # dsh 包互为 peer 依赖，插件环境需显式放宽；ws 等运行时依赖也装在这里
npm run build && npm test

# 挂进 profile：本地路径务必用 link:，不要用 file:
npx @deepseek-ai/dsh plugin --profile web add link:/path/to/dsh-qq-bot
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

配置页按 **一张卡 = 一个功能域** 组织，共 17 张，分三段。

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
| 会话与限速 | 群聊共享/独立会话、按会话滑动窗口限速、排队上限、单轮超时、空闲回收、写句柄占用策略 |
| 回复形态 | 按单条上限切块、超长折叠为合并转发、引用原消息（被 @ 时默认引用）、引用反查上限、回复 @ 触发者 |
| 群成员识别 | 成员名单（TTL + 落盘 + 单飞刷新，含角色与最近发言人）注入 system prompt；引用还原与 @ 语义化 |
| 聊天记录 | `qq_read_history`：本地内存缓冲 + 对接端历史接口合并，只能读当前会话 |
| 提问与回答 | agent 的 `ask_user_question`（含计划确认）转发到 QQ，接受 QQ 回复作为答案；与 dsh 界面两边谁先答用谁 |
| 长期记忆 | 默认关闭。L0 卡片（会话内冻结）+ L1 会话档案（SQLite + FTS5）+ 世代交接 + 蒸馏 + 每轮预取 |
| 媒体与互动 | 收图落盘到会话媒体目录并把绝对路径交给 agent；戳一戳自动回复 |
| 定时任务 | 任务总览与手动管理（启停/改期/删除/立即执行/新建）；任务绑定创建会话 |
| 人格库 | 人格名称与提示词的增删改（`personas.json`） |
| 人格与模型 | 首行「默认会话」，下方按 `friend_QQ号` / `group_群号` 逐行指定人格与模型 |

### 运行与维护

| 卡片 | 能力 |
|---|---|
| 消息日志与诊断 | 对接端收发、发往 QQ 的 action、dsh 的 prompt 与回复原文、管线丢弃原因、搜索与问答记录；卡内嵌 SSE 实时日志视图（断线自动重连/降级轮询，可过滤与清空） |
| Agent 与工作目录 | Agent 预设、时间感知、工作目录模式（会话目录 / 主目录）、数据目录 |

**几个值得知道的点**：

- **切块与折叠**：回复一律按单条上限切块；超过阈值可折叠成合并转发消息（QQ 的"聊天记录"）。
- **群聊里不提 QQ 号**：所有给模型看的文本（发言人标签、@ 提及、成员列表、聊天记录、引用块、记忆检索）只给昵称；号码仅用于插件内部。代价是重名成员无法靠号码区分。
- **写句柄先占**：dsh 会话是单写者模型，在 dsh WebUI 里打开一个 QQ 会话就会占住写句柄。插件默认 `sessionIdleTimeoutMs: 0`（建立的会话永不回收），并在启动与重建后立刻占住，让界面只能复用同一个 agent；真被界面抢先时按 `busyStrategy: wait` 等待（`busyWaitMs`，默认 5 分钟，且被单轮超时的一半截断），超时才换新会话。`/status` 的「写句柄」行与 `/reclaim` 是配套入口。
- **数据与工作目录同源**：每个聊天对象一个目录，它同时是 agent 默认工作目录、WebUI 左栏工作区与媒体落盘根；上下文隔离由 chatKey → 独立 sessionId 保证，不靠目录。
- **网页搜索、长期记忆的工具默认只给管理员**（`qq_web_search`、`qq_recall_memory`、`qq_memorize` 不在聊天工具白名单里）；要让普通用户用，把它们加进 `userTools`。
- **热应用**：绝大多数配置改完即生效、无需重启。需要重启 dsh 的只有 `dataDir` 与「工具是否注册」类开关（`registerSendTools`、`tasksEnabled`、`historyEnabled`、`searchEnabled`）；长期记忆例外——它的总开关连工具一起即时注册/注销。

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
| 人格库 / 会话人格与模型覆盖 | `<数据目录>/personas.json`、`chat-overrides.json` |
| 会话身份表（chatKey → sessionId）/ `/cwd` 覆盖 | `<数据目录>/chat-sessions.json`、`workspaces.json` |
| 定时任务 / 群成员缓存 / 动态管理员 / 消息日志 / 长期记忆 | `<数据目录>/tasks.json`、`roster/`、`admins.json`、`message-log.ndjson`、`memory.db` |

**dsh 宿主一侧：对话流水不在数据目录里**，而在 `$DSH_HOME`（默认 `~/.dsh`）下：

| 内容 | 路径 |
|---|---|
| 会话流水（对话记录本体） | `$DSH_HOME/sessions/<cwd 编码>--/<sessionId>/session.v3.jsonl.zstd` |
| 左栏分组与标题缓存 | `$DSH_HOME/storages/workspace.json`、`storages/session_projcache/` |
| 图片附件 / 设置文档 / profile 树 | `$DSH_HOME/attachments/`、`settings.yaml`、`profiles/` |

三点提醒：

1. dsh 会话的 cwd 创建后不可修改，所以**改过 `dataDir` 之后**已有会话要 `/reset` 一次才落到新目录（不一致时插件会在 QQ 里提示）。旧版本的遗留目录会在首次启动时按需搬迁（只补缺、不覆盖）。
2. 想把会话库也搬进数据目录只能**整体搬**（会话 + 可选 storages），且必须先停掉所有 dsh 进程；`root` 要指向独立子目录，不要指向数据目录或聊天目录，单个会话文件也不能软链/搬进 `Friend_<QQ号>/`（会被判 `corrupt session log`）。
3. 只想看聊天记录时用「消息日志与诊断」卡片或 `/logs`，**不要点开那个会话本身**——点开等于占住写句柄。

## 命令与工具

**内置命令**：`/help` `/status` `/reset` `/new` `/stop` `/sid` `/model` `/persona` `/cwd` `/op` `/deop` `/logs` `/tasks` `/memory` `/ping` `/reclaim`
（`/memory` 支持 `distill` 立即蒸馏、`reload` 解冻卡片；管理类命令需管理员）

**Agent 工具**：

| 工具 | 用途 |
|---|---|
| `qq_send` / `qq_send_image` / `qq_recall` | 主动发消息 / 发图 / 撤回 |
| `qq_read_history` | 读取当前会话最近的聊天记录 |
| `qq_web_search` | 按配置顺序联网搜索（默认仅管理员） |
| `task_schedule` / `task_list` / `task_cancel` | 定时任务的登记 / 查询 / 取消 |
| `qq_recall_memory` / `qq_memorize` | 长期记忆的检索与写入（默认仅管理员） |
| `ask_user_question`（dsh 内置） | 需要用户拍板时提问，问题与答案经 QQ 往返 |

## WebUI 配置界面

dsh WebUI 的**设置**左列有独立的「dsh-qq-bot」入口（需 dsh ≥ 0.1.2-rc.1）。页面与内置卡片同构：

- 每个折叠卡片**独立暂存与保存**，保存后不收起，展开态写入 sessionStorage（刷新后仍保持）
- 保存写入 `settings.yaml` 的 user 层（revision fence 防并发覆盖），bundle/patch 默认值继续生效
- 只读部署自动禁用；中英双语跟随 WebUI 语言
- `accessToken` 与各 API Key 为**只写字段**（宿主脱敏、永不回显，留空保存 = 保持不变）
- 「人格库」「人格与模型」「定时任务」三张卡片的数据走插件自建 RPC（编辑 `personas.json` / `chat-overrides.json` / `tasks.json`），保存后所有会话下一条消息即按新配置重建（历史保留）

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
├── persona/          # store（人格库 + 会话覆盖）/ routes（friend_/group_ 选择器）/ rpc
├── tasks/            # 定时任务：schedule（时间表纯逻辑）/ store / scheduler / rpc
├── search/           # 网页搜索：priority（排序列表纯函数）/ providers / chain（顺延）/ service
├── memory/           # 长期记忆：card / store（SQLite + FTS5）/ rank / distill / handoff / guard / service
├── commands/         # 内置命令
└── tools/            # qq_* 与 task_* 工具
```

dsh 还在 developer preview，API 可能有破坏性变更。所有 dsh API 调用集中在 `bridge/`、`tools/` 与 `dsh.ts`，升级时优先核对这三处。

## 相关文档

- `docs/memory-design.md` — 长期记忆的设计与取舍

## License

MIT
