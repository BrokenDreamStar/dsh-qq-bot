# dsh-qq-bot

DeepSeek Harness（dsh）× QQ 适配插件：以 **OneBot 11** 协议接入 [napcat](https://github.com/NapNeko/NapCatQQ)，在 dsh 上复刻 AstrBot 的日常聊天体验。

设计目标：**复用 dsh 原生的 agent loop、工具系统与会话持久化，本插件只做 QQ 适配与聊天体验层。**

```
napcat ⇄ Transport（正向/反向 WS）⇄ OneBot 协议层 ⇄ Pipeline ⇄ ChatBridge ⇄ dsh agent
```

## 功能

**连接与协议**
- OneBot 11 正向 WS（插件连 napcat）与反向 WS（napcat 连插件，AstrBot 同款拓扑），配置切换
- 断线指数退避重连、30s 心跳探活（带 ACK 超时判定）、access token 鉴权（Bearer / query）
- 消息段模型 + CQ 码兜底解析；`get_msg` / `get_image` / 合并转发 / 撤回等 action 封装

**消息流水线（对齐 AstrBot 语义）**
- 唤醒规则：群聊 @ 触发、唤醒前缀（如 `小助手`）、`/` 指令始终可用、私聊默认免唤醒
- 信息过滤：消息以配置的前缀开头（如 `#`）时整条忽略——不触发回复、不回提示，`/` 指令、
  @机器人、私聊与群聊一视同仁（WebUI「唤醒」卡片的「信息过滤」分节，多项逗号分隔）
- 访问控制：`allowlist / open / disabled` 三态 × 私聊/群聊独立配置 + 用户/群黑白名单；
  **群聊被拒绝时静默丢弃**——群不在白名单时这个群的每条消息都会被拒，逐条回提示或记
  「访问控制拒绝」只会刷屏（收到的消息仍照常进消息日志，见下）；
- **安全默认：allowlist 列表为空 = 全部拒绝**（与 AstrBot 相反，见下方安全章节）
- 按会话限速（滑动窗口）、message_id 去重、机器人自消息防环

**消息日志（可观测）**
- 记录 OneBot 对接端事件（消息/戳一戳/好友群请求）、发往 QQ 的消息（send/撤回/请求处理，含 action 失败）、dsh 收到的最终 prompt 与回复原文（分块/折叠前），以及管线丢弃原因（防环/去重/信息过滤/访问拒绝/限速/空 @/队列满）。**访问控制拒绝按渠道分级**：群聊被拒绝一律静默丢弃、不写「访问控制拒绝」（收到的消息本身仍照常记录，in 方向一条不少），需要排查"为什么不回复"时开 `debug`；私聊被拒绝仍记一条（陌生人私聊值得留痕）
- 查看渠道：WebUI 设置页「消息日志与诊断」卡片内嵌的日志视图（**实时推送**，断线自动重连/降级轮询；内容过滤/一键清空）+ 管理员 QQ 命令 `/logs [条数]`
- 内存环形缓冲（条数可配，默认 500）；可选 NDJSON 落盘到 `<数据目录>/message-log.ndjson`（超 5MB 轮转为 `.old`），跨重启保留

**会话管理**
- 每个私聊 / 每个群 / 群内每人（`perUser` 模式）一个持久 dsh Agent，历史跨重启保留
- `resume` 优先 + 错误分类门控回退 `create` + 并发单飞锁
- **写句柄先占**：启动时按身份表预热全部已知会话、人格/模型保存重建后立刻重新占住（默认不回收，见「QQ 与 dsh WebUI 同时用同一个会话」）；空闲回收可配（`sessionIdleTimeoutMs > 0`，保留会话 id，下条消息无缝恢复）
- `/reset` 换新会话 id（会话身份表 `<数据目录>/chat-sessions.json` 保证重启后不再恢复旧上下文）
- **路径只有一个设置**：`dataDir`（WebUI 设置页「Agent 与工作目录」卡片的
  「工作目录与数据」分节，或 `DSHQQ_DATA_DIR` 环境变量），默认
  `<用户主目录>/dsh-qq-bot-data`。每个 QQ 会话（准确说每个聊天对象）落到
  `<数据目录>/sessions/` 下的固定子目录——私聊 `Friend_<QQ号>`、群聊 `Group_<群号>`，
  该目录同时是 agent 的默认工作目录，WebUI 左栏按目录自动归入同名分组，不再堆在
  "未分组"里。`/cwd` 切换过的会话与网关模式按实际工作目录归组（不强制拉回会话目录）。
  人格库、会话身份表、定时任务、动态管理员、群成员缓存与消息日志也都在同一个数据目录里
- dsh 会话的工作目录创建后不可修改（`resume` 忽略传入的 cwd），所以**改过数据目录之后**
  已存在的会话需 `/reset` 一次才落到新目录（新会话，历史清空）——不一致时插件会在 QQ 里
  发一条提示，不再静默失败
- **旧路径自动迁移**：v0.3 之前的「会话数据根」`workspaceRoot`（`DSHQQ_WORKSPACE_ROOT`）
  与更旧的 `sessionGroupRoot`（`DSHQQ_GROUP_ROOT`）已并入 `dataDir`。升级后首次启动会把
  旧根**写进** `dataDir`（只 set 不 unset 旧键，回退旧版本仍可用），数据目录因此不变；
  旧版本遗留目录（旧数据目录 / 旧默认目录）里的人格库、会话身份表、任务、管理员、群成员
  缓存等**按需复制**到新数据目录（只补缺、不覆盖，旧目录保留可回退，搬过一次后在数据目录
  留 `.legacy-data-migrated` 标记、不再回补）。会话目录改到了 `sessions/` 子目录下，所以
  老会话仍需 `/reset` 一次——插件会在日志与 QQ 里提示旧目录位置。**自己改数据目录时**请把
  旧目录内容一并搬过去（自动搬迁只针对上述旧版本遗留目录，不追踪你手填的历史值）
- **会话被 dsh 界面占用时自动恢复**：dsh 会话是单写者模型，同一会话在进程内
  只允许一个活动写句柄。若你在 dsh WebUI 里打开过某个 QQ 会话（或在其中继续
  对话），宿主会持有该会话的写句柄，此时 QQ 侧发消息会撞上
  `already owned by an active write handle`。插件会先退避重试（旧句柄可能正在
  销毁），仍然冲突就自动开启新会话并回一句提示；旧会话历史保留，仍可在 WebUI
  中查看

**工作目录（hermes 式项目 / 网关双形态）**
- 路径只有 `dataDir`（默认 `<用户主目录>/dsh-qq-bot-data`）一个设置，每个聊天对象一个
  目录 `<数据目录>/sessions/Friend_<QQ号>|Group_<群号>`，它同时是 agent 的默认工作目录、
  WebUI 左栏的工作区与媒体落盘根（`<会话目录>/media/<chatKey>/`）；优先级：
  `/cwd` 覆盖 > 网关模式 > 会话目录
- **会话隔离不靠目录**：上下文隔离由 chatKey → 独立 sessionId 保证（`perUser` 群里
  每人一个会话），媒体按 `<chatKey>` 分子目录；因此同群各用户共享一个 agent 工作目录
  是有意取舍——彼此的 agent 能看到对方写在工作目录里的文件，需要文件级隔离请用
  `perUser` 之外的部署形态或给不同机器人实例配不同 dataDir
- 会话身份存 `<数据目录>/chat-sessions.json`，所以清理会话目录不会让机器人用回旧会话
- `/cwd <目录>`（管理员）把会话切到任意项目目录，`/cwd ~` 进入**网关模式**（以用户主目录
  为 agent 工作目录，可操作整台电脑），`/cwd reset` 还原；覆盖持久化到
  `<数据目录>/workspaces.json`，重启后保持
- `workspaceMode: home` 可把所有会话的默认工作目录直接设为主目录（bot 天生就是网关）
- 切换目录会开启新会话（dsh 会话的 meta.cwd 创建后不可变，历史上下文清空）；安全不放宽：
  非管理员轮次仍被 `restrictTools` 拦在聊天工具之外

**聊天体验**
- 回复：按单条上限自动切块；超长文本可折叠为合并转发消息（QQ 的"聊天记录"，开关 + 字数阈值可配）
- 回复形态：**群聊里被 @ 触发时用 QQ 的引用回复引用那条 @ 消息**（`replyQuoteOnMention`，默认开，
  群里一眼看清在回哪句；此时不再重复 @ 一次）；`replyWithQuote` 打开则任何触发都引用，
  `replyWithMention` 控制是否需要额外 @ 触发者
- 收图：下载图片到该会话的媒体目录（`<会话目录>/media/<chatKey>/`）并落进 agent 工作目录，以绝对路径交给 agent（agent 用自己的视觉/文件工具读取）
- 戳一戳自动回复、好友请求/加群邀请处理（可自动同意）
- 群聊消息带发言人上下文（`来自 昵称：…`，**只给昵称、不给 QQ 号**）

**聊天记录（agent 主动读取）**
- 群聊里机器人只在被 @ / 命中唤醒前缀时才进 agent，普通发言本来不进上下文；agent 可用
  `qq_read_history` 工具**主动**回看本会话最近的聊天记录（含没有 @ 它的发言，机器人自己
  发过的消息标记为【你】），"这个怎么样""刚才说的那个"这类话因此接得上
- 两路数据源合并：插件运行期间的**本地缓冲**（每会话最近 `historyBufferPerChat` 条，
  只在内存、不落盘，信息过滤前缀命中的消息连记录都不留）+ OneBot 历史接口
  （`get_group_msg_history` / `get_friend_msg_history`，可回溯到机器人启动之前；
  对接端不支持时自动降级为只用本地缓冲）
- 边界：只能读**当前会话**的记录（会话按正在执行工具的 agent 反查，模型无法指定
  别的群/人），读取条数受 `historyMaxMessages` 约束，正文超长从最旧的开始省略
- WebUI「聊天记录」卡片可整体关闭（关闭后不记录、模型也读不到）；记录与开关即时生效，
  工具注册需重启 dsh

**提问与回答（agent 的提问转发到 QQ）**
- agent 需要你拍板时会调用 `ask_user_question`，**整轮会停在那里等答案**（计划确认等
  也走同一条 dsh user-questions 缝）。插件把问题连选项一起发到 QQ（群聊里 @ 提问
  触发者），把你的回复解析成答案回填，模型于是接着往下做——不再出现"问题只出现在
  dsh 界面里、QQ 这边只看到机器人卡住"
- 怎么回答：回复选项序号（多选题用逗号分隔多个）、选项内容原文，或者直接打字
  （当自由文本答案）；回复「跳过」跳过本题。多题按顺序逐个问，长问题按单条上限切块
- 群聊只认三种来源的回复——**引用那条提问消息、@ 机器人、提问触发者本人**；群友的
  普通闲聊不算答案（也不会被吞掉，照常走唤醒判定）
- 与 dsh 界面共存：请求同时送给 QQ 与 WebUI 两边的应答器，**谁先答就用谁**；界面里
  先答了 QQ 侧立刻停止等待（反之亦然，界面里的卡片随本轮结束收起）
- 等待上限 `askUserWaitMs`（默认 5 分钟，且不超过「单轮最大等待」的一半）：超时后
  不再等 QQ，请求让回 dsh 界面；两边都没人答时模型收到一条超时错误并继续（比如换
  个说法或按默认值往下做）
- 传输断开时提问发不出去，插件不会假装"用户没答"，而是如实让模型知道（并保留 dsh
  界面应答这条路径）；本轮被取消（超时 / `/reset` / 会话回收）时等待立刻作废
- 提问与回答都进消息日志（`ask` / `ask-answer` / `ask-timeout`），`/status` 会多一行
  「agent 正在等本会话的回答」；WebUI「提问与回答」卡片可整体关闭（关闭后提问只在
  dsh 界面里回答）

**网页搜索（Tavily / Exa / dsh 内置，按优先级顺延）**
- agent 有 `qq_web_search` 工具：需要联网查资料时按配置的**搜索顺序**依次尝试
  （WebUI 里是一个可排序列表，默认 Exa → Tavily → dsh 内置）——某个后端没配 Key、
  失败（超时/401/429/断网/响应格式不对）**或没有结果**就自动顺延到下一个，
  最后可兜底 `dsh`（宿主 `ctx.web`，也就是内置 `web_search` 用的同一个后端）。
  顺序在「网页搜索」卡片里用**行右侧的 ↑ ↓ 箭头**调整，× 把后端移出列表（= 不参与搜索）；
  一次调用最多打三个后端，日志里能看到实际用了哪个
- 数据来源：Exa Search API（`POST {base}/search`，`x-api-key`）与 Tavily Search API
  （`POST {base}/search`，`Authorization: Bearer`），两家都取标题/URL/正文摘要/发布时间；
  Tavily 另带回答摘要；两个基址都可改（自建网关或中转）
- 开关、搜索顺序、API Key、结果条数/查询条数/超时都在 WebUI「网页搜索」卡片里配；
  **只有工具注册需重启 dsh**，其余即时生效；密钥是只写字段（留空保存 = 保持不变）
- 每次搜索在「消息日志与诊断」卡片里留一条 `搜索` 记录：用了哪个后端、几条来源、
  哪一档被跳过或失败（排查 Key/额度就查这里）
- **权限默认收紧**：`qq_web_search` 不在聊天工具白名单里，`restrictTools: true` 时
  **只有管理员能用**（联网搜索按次计费，也是外部内容入口）；要让普通用户也能搜，
  把 `qq_web_search` 加进「工具权限」卡片的 `userTools`
- 内置的 `web_search` 不走这条链（它只用宿主当前配置的那一个后端），所以 system prompt
  会引导模型优先用 `qq_web_search`；若要彻底禁用内置那个，把它加进 `blockedTools`

**长期记忆（跨会话记住这个群 / 这个人）**
- 默认**关闭**；开启后每个会话有一张**长期记忆卡片**（人物身份、群规与偏好、长期事项与
  决定、明确禁忌），随系统提示注入，跨 `/reset`、跨写句柄轮换、跨重启都保留
- 两层结构，各自有硬预算：
  - **卡片（L0）**：按 `memoryCardMaxChars`（默认 600 字）硬限，满了不是静默截断而是让
    agent 自己合并/删除后重试；卡片内容在**会话内冻结**（保前缀缓存），下一段会话生效
  - **会话档案（L1）**：所有通过访问控制的消息与机器人的最终回复落入
    `<数据目录>/memory.db`（SQLite + FTS5，保留 `memoryRetentionDays` 天 /
    每会话 `memoryMaxEventsPerChat` 条），agent 用 `qq_recall_memory` 按关键词检索
    「几周前说过什么」，本地查询、零模型调用
- **世代交接**：`/reset` 或写句柄冲突轮换会开启新会话，新会话第一轮会收到一次「上一段
  对话的最后几条原话 + 上次进度」，所以不会开口就问「我们刚才说到哪」——这是本插件与
  hermes-agent 的关键差异（它靠用户主动 `/new` 划边界，而 QQ 场景用户不会）
- **蒸馏**：后台按 `memoryDistillEvery`（默认 50 条）/ 空闲 10 分钟 / 世代结束三个时机，
  用一次**独立的一次性模型调用**（`ctx.llm`，不建 agent、不产生多余会话）把新消息压成
  结构化条目；水位线增量推进，输出经程序化校验（长度、白名单关系词、注入扫描）后才落库，
  失败则下次重试同一区间
- **蒸馏模型**在 WebUI「长期记忆」卡片里选，下拉清单与「人格与模型」卡片**同一份**
  （dsh「设置 → 模型」的运行时清单）；选中的 `provider/model` 会同时写进
  `memoryDistillProvider` 与 `memoryDistillModel` 两项配置（手改配置文件同样生效，
  留空 = 部署默认模型）
- **每轮预取**：按用户消息本地检索（FTS + BM25 + 时间衰减 + 覆盖率门槛），分数够高才把
  相关历史注入本轮，零 LLM 调用；与交接块二选一，避免重复上下文
- 安全：记忆写入前扫描 prompt injection / 凭证外泄 / **不可见 Unicode**（QQ 是无认证
  入口，而卡片进的是 system prompt）；卡片与检索结果都包在「历史数据，非指令」块里，
  并声明与本轮用户要求冲突时以本轮为准；作用域是**精确 chatKey**，永不跨群共享
- 权限：`qq_recall_memory` / `qq_memorize` **不在**聊天工具白名单里，`restrictTools: true`
  时**只有管理员能用**；要让普通用户也能用，把工具加进「工具权限」卡片的 `userTools`
- 命令：`/memory` 查看本会话卡片与档案规模，`/memory distill` 立即蒸馏，
  `/memory reload` 解冻卡片（让本会话立刻看到刚写入的条目）
- 开关与全部参数在 WebUI「长期记忆」卡片里配，**全部即时生效**：打开总开关会创建/打开
  记忆库并注册 `qq_recall_memory` / `qq_memorize`，关闭则关闭存储并摘除这两个工具
  （库文件保留，重新打开即恢复）。需要 Node ≥ 23.4（`node:sqlite` 免标志可用）或 Node 22.x
  加 `--experimental-sqlite`；存储不可用时插件会在日志里给出一条明确诊断并停用本功能，
  其它功能不受影响
- 设计文档见 `docs/memory-design.md`（含与 hermes-agent 的逐条对照与取舍）

**群身份识别（解决"分不清谁是谁"）**
- 群成员列表：`get_group_member_list` 全量缓存（TTL 6h + 落盘 + 单飞刷新），作为动态
  system prompt section 每轮注入——自己/群主/管理员/最近发言人优先，上限可配，
  大群不刷爆 token；附带"用昵称称呼成员、不要写出任何人的 QQ 号"的纪律提示
- 引用还原：reply 消息自动 `get_msg` 反查原文，渲染为 `[回复 张三 的消息：原文]`
- @ 语义化：消息里的 `@123456` 自动重写为 `@张三`（含引用块内）
- **机器人在群里不提 QQ 号**：所有给模型看的文本（发言人标签、@ 提及、成员列表、
  聊天记录、引用块、记忆检索）都只有昵称，号码只用于插件内部（缓存键、chatKey、
  工具权限），模型没有可照抄的号码；代价是重名成员无法靠号码区分，此时它会直接
  向群里确认

**人格与命令**
- 人格库：WebUI「人格库」卡片管理人格名称与提示词（`personas.json` 持久化），或 `/persona`
  按会话切换（保留历史，立即生效）
- 人格与模型：WebUI「人格与模型」卡片第一行是「默认会话」（人格 / 模型两列，作用于所有未
  单独配置的会话），下方按 `friend_QQ号` / `group_群号` 逐行指定各会话的人格与模型（左输入
  号码、中间选人格、右侧从 dsh「设置 → 模型」已配置的模型里选）；也可用
  `/model provider/model` 在会话内临时切换。生效优先级：会话内 `/persona`、`/model` 命令 >
  号码行 > 「默认会话」行 > 人格库默认 / dsh 部署默认；`/model`、`/status` 会显示生效模型与来源，
  改动后下一条消息自动按新人格/模型重建会话（历史保留）
- 工作目录：`/cwd [路径|~|reset]` 按会话切换 agent 工作目录（新会话生效）
- 定时任务：`/tasks` 查看本会话任务，`/tasks del|on|off|run <id前缀>` 管理，`/tasks clear` 清空
  （共享群会话的管理仅管理员可用）
- 内置命令：`/help /status /reset /new /stop /sid /model /persona /cwd /op /deop /logs /tasks /ping /reclaim`
- 管理员：配置 + `/op` 动态追加（持久化到 `admins.json`）；`/logs [条数]` 查看最近消息日志

**Agent 工具**
- `qq_send`：主动向当前 QQ 会话发消息（进度汇报/主动提问）
- `qq_send_image`：发送 agent 工作目录或会话目录内的图片、http(s) 图片（带路径校验）
- `qq_recall`：撤回机器人发出的消息
- `qq_read_history`：读取当前 QQ 会话最近的聊天记录（含没有 @ 机器人的发言），
  用于补全"刚才大家在聊什么"的上下文（见上方「聊天记录」一节）
- `task_schedule` / `task_list` / `task_cancel`：定时任务（未来任务）登记/查询/取消（见下节）
- `ask_user_question`（dsh 内置）：需要用户拍板时提问，问题由插件转发到 QQ、答案也来自
  QQ（见上方「提问与回答」一节）；它属于聊天体验工具，普通用户可用，要整体下线用 `blockedTools`
- `qq_web_search`：按配置的搜索顺序联网搜索（默认 Exa → Tavily → dsh 内置，没配 Key/失败/无结果自动顺延），
  返回回答摘要与来源（标题/URL/摘要/时间）；**默认仅管理员可用**（见上方「网页搜索」一节）

**定时任务（未来任务，对齐 AstrBot FutureTask）与时间感知**
- 会话里说"每天9点叫我起床""20分钟后提醒我开会""工作日早上7点报天气"，agent 会用
  `task_schedule` 把它落成任务；到期后插件重新唤醒该会话的 agent 执行任务，并把回复
  主动发回创建它的会话（复用切块/折叠等常规出站管线）
- 三种周期：一次性（`YYYY-MM-DD HH:mm`）/ 每天（`HH:mm`）/ 每周（`HH:mm` + 星期集合），
  全部按**宿主机本地时间**触发
- 任务绑定创建会话（chatKey），不能指定任意发送目标——主动消息只能落在发起会话里；
  单会话任务数有上限（`taskMaxPerChat`，默认 20），防止刷任务
- 持久化到 `<数据目录>/tasks.json`：重启后任务继续生效；停机错过的触发点在 30 分钟内
  补发一次，超过则跳过（不补发过期的"叫我起床"）；一次性任务触发后自动停用
- 管理入口：WebUI「定时任务」卡片（总览/启停/编辑/删除/立即执行/手动新建）、
  会话内 `/tasks` 命令（`del|on|off|run <id前缀>`、`clear`）、agent 自己的 `task_list` /
  `task_cancel`
- **时间感知**：宿主机当前时间（日期/星期/时刻/时区）注入 system prompt，每轮动态求值
  （`timeAware` 可关）；"现在/今天/明天"的判断与定时任务的时间换算都以此为准
- 到期轮次的工具权限继承任务创建者（管理员建的任务到期仍可用全套工具，普通用户的任务
  仍受 `restrictTools` 约束）

**WebUI 配置界面（dsh ≥ 0.1.2-rc.1）**
- dsh WebUI 的 **设置** 左列出现独立的「qq-bot 配置」入口（与 通用设置/模型/插件 同级，
  QQ 企鹅图标）。页面的组织原则是 **一张卡 = 一个功能域**，卡片按三段分区，共 16 张：
  - **接入与安全**：连接 / 访问控制 / 工具权限 / 网页搜索
  - **对话体验**：唤醒 / 会话与限速 / 回复形态 / 群成员识别 / 聊天记录 / 提问与回答 / 媒体与互动 / 定时任务 / 人格库 / 人格与模型
  - **运行与维护**：消息日志与诊断 / Agent 与工作目录
- 私聊与群聊的差异**不再是两张独立的卡**，而是同一张卡里的「私聊」「群聊」分节：
  - **访问控制**：〔私聊〕访问模式 + 白名单 →〔群聊〕访问模式 + 白名单 →
    〔黑名单与管理员〕用户/群黑名单 + 管理员 →〔好友与群请求〕自动同意
  - **唤醒**：〔私聊〕是否需要唤醒 →〔群聊〕仅 @ 触发 + 唤醒前缀 →〔信息过滤〕忽略哪些前缀开头的消息
    （唤醒前缀与信息过滤都是**单行输入**，多项逗号分隔；其余名单类字段仍是每行一项的多行框）
  - **会话与限速**：〔会话隔离〕群聊共享/独立 →〔限速〕窗口与次数 →〔运行时〕排队上限、单轮超时、空闲回收
  - **回复形态**：〔切块与折叠〕单条上限与转发阈值 →〔引用〕引用原消息 + 引用反查上限 →〔@ 提及〕回复 @ 触发者
- 判定依据是"一个功能域只占一张卡"：准入模式与黑白名单/管理员同属"谁能和机器人说话"这一个
  功能域，所以合在「访问控制」一张卡里（黑名单与管理员只是卡内分节，不再另占一张卡）；
  此前用户黑名单在「管理员与黑名单」而群黑名单在「群聊配置」、
  `replyWithMention` 在群聊卡而 `replyWithQuote` 在回复卡、引用反查上限塞进工具卡，这类分裂已消除；
  「媒体与其他」这种"其他"兜底卡片也不再存在（戳一戳归「媒体与互动」，自动同意请求归「访问控制」，
  调试日志归「消息日志与诊断」）
- **人格库** 卡片：增删人格（名称 + 提示词）；**人格与模型** 卡片：第一行「默认会话」
  （默认人格 + 默认模型，作用于未单独配置的会话），其余每行左输入 `friend_QQ号` / `group_群号`、
  中间选人格、右侧选模型（模型清单来自 dsh「设置 → 模型」里已配置的 provider/model）。
  这两张卡片的数据走插件自己的宿主 RPC（`personas.json` / `chat-overrides.json`），整表保存、
  保存后所有会话下一条消息即按新配置重建（历史保留）
- **定时任务** 卡片：全量任务列表（会话 / 周期 / 内容 / 下次与上次触发时间），支持启停、
  编辑、删除、立即执行与手动新建（数据走宿主 RPC 单任务操作到 `tasks.json`，不做整表
  替换——agent 会在会话里并发建任务）；工具开关与单会话上限在「工具权限」卡片的
  「定时任务」分节，时间感知开关在「Agent 与工作目录」卡片的「时间感知」分节
- **聊天记录** 卡片：〔读取〕开关与单次上限 →〔记录来源〕每会话本地保留条数与是否读取
  远端历史；关掉开关后既不记录模型也读不到，工具注册需重启 dsh（记录与开关本身即时生效）
- **网页搜索** 卡片：〔搜索优先级〕工具开关 + **可排序列表**（每行 = 序号 + 后端名 +
    行右侧的 ↑ ↓ 与 ×，列表下方是「加入」按钮；列表从上到下就是尝试顺序，移出 = 不参与）
  →〔API 密钥〕Exa / Tavily 的 Key（只写字段，留空保存 = 保持不变）→〔API 端点〕两个可选基址
  →〔参数〕来源条数、查询条数、单后端超时；除工具开关需重启 dsh 外都即时生效
- 「消息日志与诊断」卡片 = 三个日志开关 + 调试日志开关 + 内嵌的只读日志视图（同一张卡片，不再另起一张）：
  展开后订阅宿主 SSE 实时流（`/api/dsh-qq-bot/logs/stream`，`connection.fetch` 注册的
  精确路由，与 `/api` 同级鉴权），新条目零延迟到达；断线由 EventSource 自动重连、
  重连前/旧宿主自动降级为 4s 轮询 `logs/recent`，队列积压时服务端丢帧并由 `resync`
  帧触发整表重拉；可暂停实时更新、按内容/号码/昵称过滤、一键清空
- 宿主无 connection 服务（旧宿主 / TUI profile）时只隐藏该日志视图（开关照常可改）
- 「连接」卡片折叠头部有实时状态角标：确实连上 OneBot 对接端时显示绿点 +「已连接」
  （客户端每 4s 轮询宿主 `status/connection`，未连接 / 旧宿主不显示；改完连接参数保存后
  几秒内即可看到新连接的成败）
- UI 与内置插件卡片同构：折叠卡片、暂存式编辑（保存才写盘）、单字段恢复默认（不再显示"已覆盖"
  角标，避免改过配置后每行都是角标）、只读部署自动禁用、中英双语跟随 WebUI 语言；每个折叠菜单
  （卡片）独立暂存与保存，互不影响
- **点保存卡片不收起**：保存成功只在卡片底部显示一行「已保存并即时生效。」，卡片保持展开，
  可以接着改下一项；展开态记在 sessionStorage（`dshqq-open-cards`），设置面板重渲染甚至刷新
  页面后仍保持展开，不用重新点开
- 保存写入 settings.yaml 的 user 层（revision fence 防并发覆盖），bundle/patch 默认值继续生效
- **热应用**：改完即生效，无需重启——访问控制/唤醒/回复形态等即时生效；连接参数
  （transport/url/token/端口）自动重建传输层；网页搜索的搜索顺序、API Key 与参数也即时生效；
  `dataDir`（唯一的路径设置）、`registerSendTools`、`tasksEnabled`/`historyEnabled`/`searchEnabled`
  的**工具注册**需重启 dsh 后生效（卡片文案已标注）；长期记忆是例外——总开关连工具一起
  即时注册/注销（见「长期记忆」一节）
- accessToken、Exa/Tavily 的 API Key 为只写字段（宿主对 secret 脱敏，永不回显；留空保存 = 保持不变）

## 数据存放位置（插件一侧 vs dsh 宿主一侧）

**插件一侧：只有一个路径设置 `dataDir`**（默认 `<用户主目录>/dsh-qq-bot-data`；WebUI「Agent 与工作目录 → 工作目录与数据」或 `DSHQQ_DATA_DIR`）：

| 内容 | 路径 |
|---|---|
| 会话目录（agent 默认工作目录 + 左栏分组 + 媒体根） | `<数据目录>/sessions/Friend_<QQ号>`、`Group_<群号>`（媒体在 `<会话目录>/media/<chatKey>/`） |
| 人格库 / 会话人格与模型覆盖 | `<数据目录>/personas.json`、`chat-overrides.json` |
| 会话身份表（chatKey → sessionId）/ `/cwd` 覆盖 | `<数据目录>/chat-sessions.json`、`workspaces.json` |
| 定时任务 / 群成员缓存 / 动态管理员 / 消息日志 | `<数据目录>/tasks.json`、`roster/`、`admins.json`、`message-log.ndjson` |

**dsh 宿主一侧：真正的对话流水不在数据目录里**，而在 `$DSH_HOME`（默认 `~/.dsh`，可用环境变量覆盖）下，属 dsh 自己的配置而非插件设置：

| 内容 | 路径 | 说明 |
|---|---|---|
| **会话流水（对话记录本体）** | `$DSH_HOME/sessions/<会话 cwd 编码>--/<sessionId>/session.v3.jsonl.zstd`（+ `session.lock`） | bundle 条目 `session-persistence-jsonl` 的 `root`（默认 `dshHomePath('sessions')`）。编码规则：cwd 里的 `/ \ :` → `-`、其它非法字符 → `~XXXX`、两端包 `--` |
| 左栏工作区分组 / 会话标题与统计缓存 | `$DSH_HOME/storages/workspace.json`、`storages/session_projcache/` | 分组由「工作区注册表 + 会话 header 的 cwd」决定，与会话文件放在哪无关 |
| 会话里的图片附件 / WebUI 设置文档 / profile 树 | `$DSH_HOME/attachments/v1/objects/…`、`settings.yaml`、`profiles/` | 附件根跟随 `DSH_HOME`，没有独立开关 |

QQ 会话的 cwd 就是它的会话目录，所以记录**天然按聊天对象分文件夹**，例如：

```
<数据目录>/sessions/Friend_2043598920   →   ~/.dsh/sessions/--Users-…-dsh_data-sessions-Friend_2043598920--/qq-private-…-reset-…/session.v3.jsonl.zstd
```

### 想把会话库也搬进数据目录（可选，宿主级操作）

会话库只有**一个** root，没有"某个会话存哪"的设置：只能**整体搬**（GUI / TUI / QQ 所有来源的会话一起走），且必须把 `$DSH_HOME/sessions/*` 整包移过去（只搬一部分，没搬的会话会在左栏"消失"——文件没删，只是新 root 里找不到）。

```yaml
# 全局（所有 profile 一起，推荐）：新建 $DSH_HOME/cordis.patch.yml
# home 级补丁优先级高于 profile 自己的补丁；只影响 web 就写进 $DSH_HOME/profiles/web/cordis.patch.yml，
# 此时 cc-tui/dsh-tui 仍用 ~/.dsh/sessions —— 两个库并存且互不可见。
- id: session-persistence-jsonl
  config:
    root: <数据目录>/dsh-sessions
    compression: zstd        # patch 层整行替换 config，这里显式写回默认值
- id: storage-json
  config:
    root: <数据目录>/dsh-storages   # 左栏分组与列表缓存；不搬也不影响分组
```

一步到位（会话 + 附件 + `settings.yaml` + profile 树全搬）：启动 dsh 时带 `DSH_HOME=<目标目录>`，建议写进 shell 配置或启动脚本——漏带会在 `~/.dsh` 重新长出一棵空树。

步骤与注意事项：

1. 停掉**所有** dsh 进程（会话文件有 `session.lock` 与活动写句柄，运行中移动会损坏）；`mv` 整个 `sessions/`（要搬 storages 就一起）→ 写补丁 → 启动 → 确认左栏分组与会话都在 → 再删旧目录。回退 = 目录移回 + 撤补丁。
2. **别把 root 设成聊天目录或 `<数据目录>/sessions`**：store 会把 root 下的每个目录当"项目目录"扫描，聊天目录里的 `media/`、agent 写进去的 `*.jsonl` 会被判成不支持的旧扁平布局（`session artifact … uses the unsupported flat-file layout`），会话列表整个读不出来。用独立子目录 `dsh-sessions/`。
3. **单个会话文件不可能塞进 `Friend_<QQ号>/` 里**：store 用「root + 会话 header 的 cwd + session id」推出的物理路径做身份校验（`assertStoredIdentity` → realpath 比较），软链或挪到别处会被判 `corrupt session log`。
4. 搬的是"库"不是"会话"：会话 id、`resume`、上下文、侧栏分组与标题都不变。

### QQ 与 dsh WebUI 同时用同一个会话（可信前提，必读）

dsh 的会话是**单写者模型**：一个 session id 在进程内只允许一个活动写句柄
（`SessionAlreadyOwnedError`）。插件与 WebUI 都要用它，所以两边**不可能同时驱动**，
只能"谁先占谁持有"。关键事实：**在 WebUI 里打开一个 QQ 会话就会占住写句柄**
（读取历史后宿主会 promote 出一个活 agent），关标签页不等于立刻释放。

| 时序 | 结果 |
|---|---|
| 插件已持有句柄 → 你在 WebUI 打开该会话 | 宿主复用插件那个 agent，**互不干扰**（这是我们要的常态） |
| 插件空闲回收/进程重启后先被 WebUI 占住 → QQ 来消息 | 插件撞上占用：默认**发一条提示并等待**（`busyStrategy=wait`），你关掉那边的会话后消息原地继续；等够 `busyWaitMs` 仍占着才换新会话（同 `/reset`，上下文清零，旧历史保留） |

插件侧为此做了两件事，把第一种变成默认行为（`bridge/chat.ts`）：

- **启动预热**：`apply()` 时按身份表逐条 `resume`（best-effort：不等待、不轮换、不抛错），
  重启 / 热重载后抢在浏览器之前占住，把空窗压到启动瞬间；
- **重建后立刻重占**：人格库与「人格与模型」保存会丢弃全部 handle（新配置要重新走 setup），
  丢弃后立刻在后台重新 `resume`，不再等下一条消息。

默认配置就是"插件先占"（WebUI：设置 → dsh-qq-bot →「会话与限速」卡内的「占用与接管」分节）：

| 配置 | 默认 | 作用 |
|---|---|---|
| `sessionIdleTimeoutMs` | `0` | **插件建立的会话永不回收**：写句柄一直留在插件手里，dsh 界面只能复用同一个 agent。代价是每个聊过天的对象常驻一个 agent（内存换确定行为）；设成 `>0` 会主动把句柄交出去，界面接住后就不再还，只在你想省内存时才开 |
| `busyStrategy` | `wait` | 真的被界面抢先占用时等待而不是立刻换号，**不丢上下文** |
| `busyWaitMs` | `300000` | 等待上限；实际还会被 `maxTurnMs/2` 截断，避免撞上单轮超时 |

> 界面**已经**占住之后就抢不回来了：dsh 宿主没有 release/demote 入口，关标签页也不释放，
> 插件也拿不到那个 handle 的处置权（`AgentHandle.dispose()` 只发给创建者）。所以只剩
> 等它释放（`wait`）或换新会话（超时后自动 rotate，上下文清零）两条路。

配套命令：

- `/status`：新增「写句柄」一行（本插件持有 / 被其它界面持有 / 未打开），不再因为占用而卡住不回复；
- `/reclaim`（管理员）：会话被界面占用时，立刻让正在等待的那一轮重试一次接管——**前提是那边已经释放**；插件不会去强拆宿主的句柄（它拿不到那个能力，硬拆会破坏单写者约束）。

> 只想看聊天记录时，用 WebUI 的「消息日志与诊断」卡片或 QQ 里的 `/logs`，
> **不要**点开那个会话本身——点开就等于占住写句柄。

## 安装

```bash
# 从 npm 安装
npx @deepseek-ai/dsh plugin --profile web add dsh-qq-bot
```

本地开发（改完代码重新 build 即生效）：

```bash
npm install --legacy-peer-deps   # dsh 包的互为 peer 依赖在插件环境不解析；ws 等运行时依赖也装在这里
npm run build && npm test

# 挂进 profile：本地路径务必用 link: 而不是 file:
npx @deepseek-ai/dsh plugin --profile web add link:/path/to/dsh-qq-bot
```

> **本地路径必须用 `link:`。** profile 的 `pnpm-workspace.yaml` 里是 `nodeLinker: hoisted`，
> 该模式下 `file:` 依赖会被**硬链接复制**进 `profile/node_modules/`：构建产物里**新增**的文件
> （新增模块、文件改名）不会同步过去，dsh 启动时会直接失败——
> `Cannot find module '.../dsh-qq-bot/dist/xxx.js'`（`ERR_MODULE_NOT_FOUND`），
> 且要重新 install 才恢复。`link:` 建的是符号链接，`npm run build` 的产物始终是最新的。
> 已经用 `file:` 装过的，把 profile 的 `package.json` 依赖改成 `link:<绝对路径>` 再
> `dsh plugin --profile web install` 即可（本插件自己的依赖仍从源码目录的 `node_modules` 解析）。

## napcat 配置

二选一：

**正向 WS（默认）**：napcat → 网络监听 → 新增 → WebSocket 服务器，监听 `0.0.0.0:3001`（或仅本机）；
插件配置 `url: ws://127.0.0.1:3001`。

**反向 WS**：napcat → 网络监听 → 新增 → WebSocket 客户端，URL 填 `ws://127.0.0.1:6199/ws`；
插件配置 `transport: reverse`（插件监听 6199 端口）。与你原 AstrBot 的 napcat 配置兼容，napcat 侧几乎不用改。

两侧 token 保持一致（napcat 的 token 字段 ↔ 插件 `accessToken`）。

## 最小配置示例

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
        # 网页搜索（qq_web_search）：搜索顺序（数组顺序 = 尝试顺序）+ 密钥
        searchOrder: [exa, tavily, dsh]   # 也可只在 WebUI 卡片里用箭头排序
        exaApiKey: 'exa-…'
        tavilyApiKey: 'tvly-…'
        # 人格与模型在 WebUI「qq-bot 配置 → 人格库 / 人格与模型」里维护，
        # 也可在会话内用 /persona、/model 临时切换。
```

也可用环境变量（见 `cordis.patch.yml`）：`DSHQQ_WS_URL` / `DSHQQ_TRANSPORT` / `DSHQQ_REVERSE_PORT` / `DSHQQ_ACCESS_TOKEN` / `DSHQQ_ADMIN_USERS` / `DSHQQ_DATA_DIR`（数据目录，唯一的路径设置，默认 `<用户主目录>/dsh-qq-bot-data`；旧名 `DSHQQ_WORKSPACE_ROOT`、`DSHQQ_GROUP_ROOT` 仍兼容，仅在未设 `DSHQQ_DATA_DIR` 时兜底）/ `DSHQQ_EXA_API_KEY` / `DSHQQ_TAVILY_API_KEY`（密钥走环境变量就不用写进 settings.yaml；搜索顺序是部署选择，在 WebUI 卡片里排序或写 `searchOrder` 数组）。

## ⚠️ 安全须知（务必阅读）

QQ 群/私聊是**无认证入口**：任何能给机器人发消息的人都可能驱动 dsh 的能力——包括 **Shell、文件写入、联网**。本插件用三层权限控制这个面：

| 层 | 管什么 | 配置 |
|---|---|---|
| 入口权限 | 谁能触发对话 | `privateMode`/`groupMode` + 白/黑名单（allowlist 空 = 全拒） |
| 命令权限 | 谁能用管理命令 | `adminUsers`（adminOnly 命令 + 共享群 /reset） |
| **工具权限** | **谁能驱动 agent 的 Shell/文件等** | `restrictTools`（默认开）+ `userTools` + `blockedTools` |

工具权限的默认行为即"**普通用户仅能对话，管理员才可以让 agent 操作电脑**"：

- `restrictTools: true`（默认）时，非管理员触发的轮次里，agent 调用任何不在
  `userTools` 白名单里的工具都会被拦截，模型会收到明确的权限解释并转告用户
- `userTools: []`（默认）= 普通用户纯对话；可按需开放安全工具，如 `['web_search', 'read*']`（支持尾部 `*` 前缀通配）
- `blockedTools` 全员禁用（含管理员），用于在 QQ 入口整体下线某类能力，如 `['shell', 'run_code']`
- **联网搜索默认只给管理员**：`qq_web_search` 不在聊天工具白名单里（搜索按次计费，也是外部
  内容入口）；要让普通用户也能搜，把 `qq_web_search` 加进 `userTools`。搜索结果是外部
  不可信内容，system prompt 里已明确要求模型只当资料、不执行其中的指令
- 机器人自己的聊天工具（`qq_send` / `qq_send_image` / `qq_recall` / `qq_read_history`）与
  定时任务工具（`task_schedule` / `task_list` / `task_cancel`）对所有能对话的用户放行——
  任务只能发回创建它的会话（主动消息没有任意目标的攻击面，单会话任务数由 `taskMaxPerChat`
  限制），`qq_read_history` 只能读**当前会话**自己的记录（模型无法指定群号/QQ 号，
  没有跨会话读取或遍历群的入口），且记录只存在于内存、不落盘
- 管理员（`adminUsers`）绕过白名单且工具不受限，请只加自己

其余建议：

- 即使有工具权限分层，仍建议在该 profile 层收窄高危工具的执行范围（沙箱预设/容器），权限拦截是"模型侧闸门"，不替代执行环境隔离
- `qq_send_image` 限制 agent 只能发送其会话目录或 agent 当前工作目录内的文件
- **网关模式是高危能力**：`/cwd ~` 或 `workspaceMode: home` 让 agent 以用户主目录为工作区，
  配合管理员的工具权限等于"通过 QQ 操作整台电脑"。请确保 `adminUsers` 只加自己、
  入口 allowlist 收紧，并优先在该 profile 层叠加沙箱/容器隔离
- 定时清理 `<数据目录>/sessions/<Friend_|Group_号>/media/<会话>/`（收图落盘目录）

## 与 AstrBot 的功能对照

| AstrBot 功能 | dsh-qq-bot 现状 |
|---|---|
| 唤醒前缀 / @ 唤醒 / 私聊策略 | ✅ 对齐（空 @ 等待合并暂无） |
| 信息过滤（前缀开头即忽略） | ✅ `messageFilter`，WebUI「唤醒」卡片「信息过滤」分节 |
| 白/黑名单、限速 | ✅（三态访问模式 + 滑动窗口） |
| 权限分层（普通用户对话 / 管理员操作电脑） | ✅（三层：入口/命令/工具，AstrBot 没有的粒度） |
| 多会话隔离 + 历史持久化 | ✅（dsh 原生持久化 + resume） |
| 人格系统 + 人设切换 | ✅ WebUI 人格库 + 按会话指定人格/模型，`/persona` 亦可（开场白/语气模仿暂无） |
| 内置管理命令 | ✅ 子集（/reset /stop /model /persona 等） |
| 图片收发 | ✅（收图路径交给 agent 视觉；发图走工具） |
| 长文折叠转发（聊天记录）、引用回复 | ✅ |
| 群成员身份识别（成员列表/引用还原/@ 语义化） | ✅（AstrBot 没有的能力） |
| 主动读取聊天记录（补全"刚才大家在聊什么"） | ✅ `qq_read_history` 工具，本地缓冲 + OneBot 历史接口（AstrBot 没有的能力） |
| 戳一戳、好友/群请求 | ✅ 基础版 |
| 主动消息 | ✅ qq_send 工具 |
| 未来任务（FutureTask，定时/循环任务主动发消息） | ✅ task_schedule 等工具 + WebUI 任务列表 + /tasks 命令，任务绑定发起会话 |
| 联网搜索（Web 搜索服务商：Tavily / Exa / …） | ✅ `qq_web_search` 工具 + 顺序顺延（Exa/Tavily/dsh 内置任选顺序，没配 Key/失败/无结果自动降级，WebUI 可排序列表配置）+ 默认仅管理员可用 |
| agent 提问（需要用户拍板时暂停等回答） | ✅ 转发到 QQ 并接受 QQ 回复（回复序号/内容/自由文本，回复「跳过」跳过；与 dsh 界面两边谁先答用谁，超时不再等） |
| 语音 STT/TTS | ❌ backlog |
| 知识库/RAG、长期记忆 | ❌ 建议 dsh 生态记忆类插件 |
| WebUI 管理面板 | ➖ 不做完整面板；配置页已接入 dsh WebUI（设置 左列独立入口，一张卡 = 一个功能域，按「接入与安全 / 对话体验 / 运行与维护」三段分区，共 16 张，含私聊/群聊卡内分节与定时任务/人格库/人格与模型/聊天记录/提问与回答/网页搜索） |

## 架构

```
src/
├── index.ts          # 插件入口（name/inject/Config/apply + WebUI settings 注册）
├── config.ts         # schemastery 配置 schema
├── paths.ts          # 统一路径解析（唯一的路径设置 dataDir）+ 旧路径/数据文件迁移
├── configSync.ts     # WebUI 配置热应用（原地合并 + transport 重建判定）
├── webRpc.ts         # 自建 WebUI RPC 通道（prefix 路由 + 报文信封 + connection 鉴权）
├── dsh.ts            # dsh 服务最小类型面（升级时只改这里）
├── client/           # 浏览器半：WebUI 设置页（一张卡 = 一个功能域，构建为 dist/client.js）
├── transport/        # base（echo 通道）/ forward（正向WS）/ reverse（反向WS）
├── onebot/           # segments（CQ 码）/ events（归一化）/ api（action 封装）/ roster（群成员列表）/ history（聊天记录缓冲）
├── pipeline/         # access（白名单限速去重）/ wake（唤醒）/ dispatcher（分发）
├── bridge/           # chat（会话桥 + /cwd 工作目录切换）/ reclaim（写句柄占用的等待策略）/ modelRoutes（模型规格解析与展示）/ workspaces（cwd 覆盖持久化）/ agentRunner（followup→whenIdle→summarize）/ prompt（引用还原）/ ask + asker（agent 提问的 QQ 侧问答）
├── outbound/         # chunk（按单条上限分块）
├── media/            # inbound（收图落盘）
├── logs/             # 消息日志（环形缓冲 + 订阅 + NDJSON 落盘 + SSE 实时流 + 出站 action 包装 + /logs 渲染）
├── persona/          # store（人格库 + 会话覆盖）/ routes（friend_/group_ 选择器）/ rpc（WebUI 人格与模型端点）
├── tasks/            # 定时任务：schedule（时间表纯逻辑）/ store（tasks.json）/ scheduler（触发循环）/ rpc（WebUI 任务端点）
├── search/           # 网页搜索：priority（后端取值 + 排序列表操作，零依赖共用）/ providers（Tavily/Exa/dsh 报文适配）/ chain（顺延与合并）/ service（配置、ctx.web、日志）
├── commands/         # 内置命令
└── tools/            # qq_send / qq_send_image / qq_recall / qq_read_history / qq_web_search + task_schedule / task_list / task_cancel
```

dsh 还在 developer preview，插件 API 可能有破坏性变更。所有 dsh API 调用集中在 `bridge/`、`tools/` 与 `dsh.ts`，升级时优先核对这三处；`engines.dsh` 锁定了已知可用版本（`>=0.1.0-rc.6`）。

## 致谢

架构骨架参考了 [leliln52/dsh-qqbot](https://github.com/leliln52/dsh-qqbot)（OneBot 正向 WS + 会话桥模式）与 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)（官方 QQ 通道插件，空闲回收/流水线组织方式），在此致谢。

## License

MIT
