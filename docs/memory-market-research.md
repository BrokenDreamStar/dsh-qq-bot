# 长期记忆市场调研：同类插件怎么做，以及 dsh-qq-bot 该怎么改

> 调研时间：2026-10-29。范围分三层：
> 1. **QQ / IM 机器人插件**（AstrBot、LangBot、NoneBot、Koishi/ChatLuna）——形态最接近本项目；
> 2. **通用记忆层**（Mem0、Zep/Graphiti、Letta/MemGPT、LangMem、Memobase）——算法与工程取舍；
> 3. **产品级助手**（ChatGPT、Claude/Claude Code、GitHub Copilot、Cursor）——用户控制与可运维性。
>
> 结论先行：**当前实现的问题主要不在"蒸馏提示词写得不够好"，而在读路径、数据模型和可运维性选错了方向。**
> 市场主流做法可以压缩成一句话：**两层记忆（稳定画像 + 情景记忆）+ 每轮动态召回 + 自然语言条目 + 追加/失效而非覆盖 + 用户看得见摸得着。**
>
> 证据说明：官方文档/仓库 README 当事实用；厂商 benchmark 数字单独标注（这个领域的数字争议极大，见 §4.4）；对 ChatGPT 注入格式等逆向观察只当"设计假设"，不当官方承诺。

---

## 0. 一页结论

| 维度 | 市场主流 | dsh-qq-bot 现状 | 建议 |
|---|---|---|---|
| 记忆分层 | 稳定画像/偏好（常驻）+ 情景/事件（检索） | L0 卡片（事实三元组，冻结）+ L1 原始消息档案 | 保留两层，但把 L0 改成"画像 + 每轮相关记忆"，不再整段冻结 |
| 读路径 | **每轮**按当前消息召回 top-K 注入 | 卡片整个会话冻结；预取命中率低；主要靠模型主动调工具 | 每轮动态注入；工具只做"深挖" |
| 记忆单元 | 自然语言事实/事件，带类型、来源、时间 | `subject/predicate/object` 六种谓词、80 字、唯一键 | 改成自由文本条目 + `kind/importance/source/valid_time` |
| 冲突处理 | 追加 + 失效（ADD-only / 双时间轴）；保留历史 | 同 `(subject,predicate)` **原地覆盖** | 停止覆盖；新条目 + 旧条目 `valid_to`，可追溯 |
| 写入触发 | 每 N 轮 / 每 N token / 空闲批量；异步队列 | 50 条或 2000 字；所谓"10 分钟空闲兜底"实际不生效；定时器间隔启动时快照 | 降到 8–12 轮 / 600–800 字；空闲兜底真的 force；定时器实时读配置；补定期 prune |
| 检索 | 向量 + BM25 + 实体/时间 + rerank | 纯 FTS5；`unicode61` 把整句中文当一个 token，单字查询实际匹配不到 | 先做中文分词/trigram + BM25 混合；embedding 作为可选后端 |
| 作用域 | user / group / session / global 分层，读时合并 | 精确 chatKey，不跨群、不跨私聊 | 增加 group + user 两层；跨群用户画像默认关闭、显式开启 |
| 可运维性 | 管理面板：查看/搜索/编辑/删除/测试召回/审计 | 只有配置卡和 `/memory` 文本 | 增加 WebUI「记忆」面板 + RPC |
| 安全 | 记忆当不可信数据；作用域隔离；注入扫描 | 有扫描和标记，但**提示词/工具示例里带 QQ 号** | 立即去掉模型可见文本里的 QQ 号；按条拒绝而非整批丢弃 |
| 评测 | LongMemEval 五能力；厂商数字争议大 | 无评测 | 自建 30–50 条中文 QQ 场景，先量再改 |

---

## 1. 市场地图

### 1.1 QQ / IM 机器人插件：最常见的是"每轮召回 + 向量库 + 管理面板"

这一层和 dsh-qq-bot 的部署形态最接近（单机、常驻、QQ 群聊、多用户），也最能说明"用户实际期待什么"。

#### AstrBot 生态

先厘清一个容易误解的点：**AstrBot 本体的"长期记忆"不是事实记忆**。它的 `provider_ltm_settings.group_icl_enable`（默认 false）做的是"群聊 in-context learning"——把最近群消息原文（`group_message_max_cnt` 默认 1000）渲染成 `[昵称/时间]: 内容` 拼进 system prompt，没有摘要、没有事实、没有向量。官方知识库是文档 RAG，上下文压缩也不等于长期记忆。真正的事实记忆在插件生态里，而且已经形成 25+ 个插件、几条典型路线。

| 插件 | 记忆模型 | 写入 | 召回/注入 | 生命周期 | 可运维性 |
|---|---|---|---|---|---|
| **LivingMemory**（约 369 stars） | 偏好、人物、计划、上下文；文档 + 图谱 | 达到配置轮次后自动整理；重要记录保留原文 | 关键词 + 向量 + 图谱融合；结合会话、人格、生命周期筛选；请求前注入 | 归档、衰减、访问强化 | 官方 Pages：关系图谱、编辑、召回测试、提示词管理 |
| **Mnemosyne**（约 254 stars） | 对话摘要 + 向量 | 按轮数/时间自动总结 | 语义检索；会话隔离；人格过滤 | 记忆集合 | 管理面板：拓扑、检查器、编辑后重建 embedding |
| **persistent-memory**（约 87 stars） | 向量化对话片段 | `on_llm_response` 自动捕获 | `on_llm_request` 自动召回；向量 + BM25 + Jina rerank；recency/importance/time decay | 作用域 global/session/session+global | 工具 `memory_recall/store/forget/list/stats` |
| **Memorix** | 段落向量 + 实体图谱 + 时间线 | 后台总结、人物事实候选队列 | 向量 + BM25 + 图谱 PageRank；时间表达路由 | 衰减 → 冻结 → 剪枝；回收站 | 内嵌 WebUI：图谱、来源追溯、画像覆盖、管理员工具 |
| **simple_long_memory** | 知识库条目 | 每 20 轮自动提取 | embedding 召回 + rerank；注入临时用户内容区 | TTL 30 天；夜间整理：去重合并、矛盾检测、审核 | 知识库界面直接查看/检索/删除 |
| **agentmemory** | 外部 agentmemory 服务 | 回复后按配置写入 | 只提供工具，不自动注入 | 外部服务 | 命令 `/am_status`、`/am_search`、`/am_remember`、`/am_forget` |
| **Bluezeamer/memory** | 每用户 Markdown：Soul、画像、历史索引、备忘、TODO | 关键词"沉淀记忆"触发归档；工具更新 | 每次请求前动态注入 system prompt | 文件级 | 可直接看/改文件 |

**这个生态最近一年的第一矛盾不是"记不记得住"，而是"前缀缓存被破坏导致烧钱"。** 插件命名直接围绕这件事：「长期记忆（缓存命中优化）」「记忆检索（命中缓存率更高更省钱）」「提示词注入优化（针对 KV Cache）」「你们的记忆（注入 contexts 而非 system_prompt）」「记忆日记（75%/90% 写日记，/reset 后先读日记）」。三条独立证据：

- LivingMemory v2.3.0 把默认注入从 `system_prompt` 改为 `extra_user_content`，理由写明"不破坏前缀缓存"（issue #146）；
- AstrBot #8080 记录：群聊上下文每轮 `+=` 到 system 尾部，前缀缓存全废；
- persistent-memory 把召回结果包在 `UNTRUSTED DATA` 里注入，既防提示注入，也避免污染 system 前缀。

这说明市场不是"不关心缓存"，而是**把稳定内容放 system 前缀、把每轮变化的记忆放 user 尾部**。这正是 dsh-qq-bot 应该学的形态：不是"整张卡片冻结"，而是"稳定段冻结 + 可变段尾部注入"。

共同点非常一致：

1. **请求前注入，而不是等模型调工具。** 几乎所有"开箱即用"的插件都在 `on_llm_request` / `PromptPreProcessing` 阶段自动召回并注入；工具只是补充。
2. **向量库是默认配置。** Chroma、LanceDB、Milvus、Qdrant、Weaviate 都有人用；纯 FTS 的方案很少。
3. **每 N 轮自动总结。** 常见默认 10–20 轮；有的再叠加时间触发。
4. **作用域至少分"用户/会话"，群聊再加"群共享"。** ChatLuna 甚至分了 global/preset/guild/user 四层。
5. **管理面板是刚需。** 记忆图谱、来源、编辑、召回测试、删除、回收站——没有这些，用户无法判断"它到底记住了什么"。
6. **生命周期。** 衰减、冻结、剪枝、TTL、访问强化、去重合并、矛盾检测，至少有一两项。

#### LangBot：L1 画像 + L2 情景，和本项目最像

LangBot 的官方 `LongTermMemory` 插件（`langbot-app/langbot-longterm-memory`，已迁移到 `langbot-plugins/KnowledgeEngine/LongTermMemory`）明确采用双层：

- **L1 core profile**：姓名、偏好、身份、长期备注，存插件 JSON，按 `session` 或 `speaker` 作用域；**每次请求前注入 system prompt**。
- **L2 episodic memory**：时间敏感的事件、计划、经历，存向量库；**每次请求前用当前用户消息检索一次**，作为事实上下文注入。
- 工具：`remember`、`recall_memory`、`update_profile`、`forget`；另有 `!memory` 命令和 **Memory Console**（画像、分页 episode、审计日志、导出、隔离健康检查、最近一次注入快照）。
- 生命周期：每条 episode 有 `active / superseded / archived / deleted` 状态；纠正/事实更新/澄清时**自动 supersede 相关旧 episode**；可选候选审核（candidate accept/reject）；`!memory consolidate` 预览后清理。
- 一个很克制的默认：**候选抽取默认关闭**。作者的理由是自动写会污染 L1 画像与 L2 召回；先让用户/管理员审核，再决定是否自动应用。
- `!memory health` 会用两条临时探针记录验证向量库的 metadata 隔离是否可靠——因为 Milvus/pgvector 的固定 schema 会静默丢掉 `user_key` 等 metadata，导致跨用户召回泄漏。

它的设计说明里有一句话很关键：

> 这个插件不是把整段聊天历史塞进上下文，而是把长期记忆拆成两层，分别用不同的存储与检索行为。

这几乎就是 dsh-qq-bot 设计文档里 L0/L1 的翻版；差别在于 **LangBot 的 L1 是每次请求重新注入的，不是会话内冻结的**，L2 也是每轮检索的。

#### ChatLuna（Koishi）：分层 + 多引擎 + 记忆类型

`chatluna-long-memory` 的配置与文档把"记忆"拆得很细：

- **分层**：Global（所有用户/会话共享）、Preset（同一预设内共享）、Guild（同群共享）、User（同一用户跨会话）。检索时按配置的层依次合并。
- **引擎**：Basic（全部记忆直接进上下文）、HippoRAG（知识图谱 + Personalized PageRank）、EMGAS（情景记忆图 + 激活扩散，带时间衰减与强化）。
- **写入**：主动提取（注册工具让 agent 判断）或被动提取（按轮次，推荐 3–5 轮）；提取模型可单独配置；原始对话也会存进 Koishi DB，供重建索引。
- **记忆类型**：factual/preference/personal/skill/interest/relationship（长期）、contextual/task/location（中期）、temporal/event（短期）；每条带 `importance`，并按类型计算 `expirationDate`。
- **管理**：添加/删除/修改/清除命令；WebUI 管理记忆、快照、用户画像；主动侧提供 4 个工具（search/add/update/delete）。

`chatluna-livingmemory` 更进一步：第一人称叙事记忆、异步提取与召回、子模型生成"记忆快照"、用户画像、`Dream` 后台整理（合并/拆分/更新/归档）、七个记忆工具、WebUI。它的召回不是把原始消息丢给主模型，而是**先用子模型结合近期对话检索，再整理成一份记忆快照**。

#### NoneBot

`nonebot-plugin-memory` 是另一种路线：**只做用户画像**。自动保存用户发言，每日生成/更新画像，指令查看"印象"；存储用 Redis。它不追求"事件级检索"，而是把"这个人是谁"压缩成一段画像。对于群聊机器人，这种"轻量画像"往往比"全量档案"更容易被用户感知。

#### Coze：Markdown 文件化记忆

Coze 的长期记忆已经走向**文件化**：`SOUL.md`（人格）、`USER.md`（用户画像）、`MEMORY.md`（长期记忆）、`TOOLS.md`、`CONTACT.md`、`SECRET.md`，配合定期整理与向量检索；渠道之间共享但用户之间隔离。这套形态和 dsh 的 L0 卡片方向一致——**用可读、可编辑的 Markdown 承载稳定记忆**，而不是把一切塞进数据库。对 QQ 机器人的启示：记忆文件可以由管理员直接打开看，这比"只能通过命令查"更可信。

#### Dify / FastGPT：没有真正的长期记忆

Dify 的"记忆"是会话变量 + 记忆窗口（最近 N 轮），FastGPT 是 `chatId` 维度的历史（默认 6 轮、最多 50 轮）；两者都没有跨会话事实抽取与检索。它们常被拿来和"长期记忆"混为一谈，但实际上只是**上下文窗口管理**。这也说明：不要因为某个平台"有记忆开关"就以为它解决了长期记忆。

#### Yunzai：生态较弱，但默认值值得抄

Yunzai 本体只有 Redis + `setContext`；`chatgpt-plugin` 有会话上下文；最好的 `bl-chat-plugin` 有一整套可直接抄的默认值：

- 每用户 100 条 / 每群 50 条；
- `importanceThreshold = 0.5`；
- 衰减 7 天；
- 防抖：私聊 45 秒 / 6 条，群聊 10 分钟 / 12 条；
- 注入 8 条个人 + 6 条群，1200 字符；
- `semanticRecall` 默认关闭（先保证不炸，再谈语义）。

这些数字比"50 条消息才蒸馏"更接近真实群聊节奏，可以作为 P0 的默认值参考。

#### 同平台对标：DSH 的 `qq-memory`

DSH 插件市场已经有一个 `qq-memory`：单 JSON 文件 `~/.dsh/qq-memory/memories.json`，艾宾浩斯衰减 `R = e^(−Δt/(strength×τ))`，`tauDays=7`、`threshold=0.15`、`boost=1.5`、`maxItems=10`、`maxChars=200`，4 个工具，global + session 双 scope，注入 system prompt。

它的存在说明两件事：

1. **轻量路线可行**：不建库、不做批量蒸馏，只靠"重要度 + 衰减 + 工具"也能提供可感知的记忆；
2. **dsh-qq-bot 的差异化在"检索 + 批量蒸馏 + 群档案"**：如果继续把力气花在"更复杂的卡片冻结/预算阶梯"上，反而丢了自己的强项。

#### 这一层的结论

- **"记忆"在产品上首先是一个读路径功能**：用户发一句话，机器人这轮就能表现出"记得"，而不是等 `/reset` 之后。
- **自动注入是默认，工具是补充**；只给工具、不自动注入的插件（如 agentmemory）通常定位为"给高级用户/agent 用"。
- **管理面板不是锦上添花**：它是用户信任的前提，也是调试召回的唯一手段。
- **中文场景对纯 FTS 不友好**：这些插件绝大多数默认向量检索，或至少向量 + BM25 混合。

---

### 1.2 通用记忆层：算法上的四种流派

| 流派 | 代表 | 核心机制 | 强项 | 代价/弱项 |
|---|---|---|---|---|
| **抽取 + 去重/更新** | Mem0（旧版）、LangMem | LLM 从对话抽事实；与相似记忆比较后 ADD/UPDATE/DELETE/NOOP | 实现简单、成本可控 | 覆盖会丢历史；矛盾处理依赖 LLM 判断 |
| **追加 + 多信号检索** | Mem0（2026 新版） | 单次抽取，**只 ADD**；实体链接；语义 + BM25 + 实体融合；时间推理 | 保留状态变化历史；写入快 | 记忆会累积，需要检索/整理 |
| **时序知识图谱** | Zep/Graphiti | episode → 实体/边；双时间轴 `valid_at/invalid_at`；新边使旧边失效 | 时间推理、多跳、矛盾失效 | 摄入 LLM 调用多、图数据库重 |
| **上下文分层 + 自编辑** | Letta/MemGPT | core memory blocks（常驻）+ recall（历史）+ archival（外部）；agent 自己调用记忆工具；sleep-time agent 后台整理 | 可控、可解释；适合长驻 agent | 需要 agent 会"管理记忆"；块容量有限 |

#### Mem0：从"四操作"转向"只追加"

旧版 Mem0 的两阶段 pipeline 很有名：先从对话抽候选事实，再用向量检索 top-s 相似记忆，让 LLM 通过 function call 选择 `ADD / UPDATE / DELETE / NOOP`。这是"记忆去重"的经典做法。

但 2026 年 4 月 Mem0 改了算法：**单次抽取、只 ADD、不覆盖不删除**；新事实与旧事实并存，靠实体链接、语义 + BM25 + 实体多信号检索、时间推理来"找对那一条"。官方给出的理由是：旧版的 reconciliation 步骤慢，而且**覆盖会破坏上下文**——"overwrites sometimes erased key information from the original fact"。

> 这一点对 dsh-qq-bot 非常关键：当前 `(chat_key, subject, predicate)` 唯一键 + 原地改写，正是 Mem0 已经放弃的"覆盖式"做法。

Mem0 官方宣称新算法 LoCoMo 92.5、LongMemEval 94.4，但第三方复现与 Zep/Mem0 互相质疑很多（见 §4.4）。**不要拿厂商数字当设计依据，拿机制当依据。**

#### Zep/Graphiti：双时间轴 + 边失效

Graphiti 把每条消息作为 episode 摄入，抽实体与关系边；每条边带四个时间戳：

- `t_valid / t_invalid`：事实在现实世界里何时为真；
- `t_created / `t_expired`：系统何时记录/失效它。

新边与语义相关的旧边比较，若矛盾，就把旧边的 `t_invalid` 设为新边的 `t_valid`——**旧事实不删除，只是失效**。检索是语义 + 关键词 + 图遍历的混合。

Zep 论文宣称 DMR 94.8%（vs MemGPT 93.4%）、LongMemEval 最高提升 18.5%、延迟降低 90%。但 Graphiti 的摄入是"每条消息一次 LLM 抽取"，成本远高于批量抽取；对单机 QQ 机器人来说太重。

#### Letta/MemGPT：core memory blocks + sleep-time agent

Letta 把上下文当内存管理：

- **Core memory**：常驻 context 的 memory blocks（用户、组织、任务等），agent 可通过工具编辑；有容量上限。
- **Recall memory**：完整对话历史，可按需搜索。
- **Archival memory**：外部向量库，显式存入的知识，按需检索。
- **Sleep-time agent**：把记忆管理从对话 agent 里拆出去，在空闲时异步整理 core memory；主 agent 不再被记忆操作拖慢。

这套思路对 dsh-qq-bot 的启示是"**记忆管理不必和对话在同一轮里做**"：当前实现用 `ctx.llm.stream()` 后台蒸馏，方向是对的；但读路径不应该因此被冻结。

#### LangMem：hot path vs background，命名空间隔离

LangMem 把记忆写入分成两种：

- **Hot path**：agent 用 `manage_memory` 工具主动记；
- **Background**：`create_memory_store_manager` 从对话里"下意识"抽取，可 debounce/延迟处理。

存储抽象是 LangGraph Store 的 namespace（`("memories", "{user_id}")`），检索工具 `search_memory` 支持语义/精确匹配。它不绑定数据库，适合"自己有存储"的场景。

#### Memobase：用户画像 + 事件时间线，成本可控

Memobase 的定位很明确：**给聊天机器人做"用户画像"而不是通用 RAG**。

- **Profile**：结构化槽位（basic_info、education、自定义 topic/sub_topic），LLM 按 schema 更新；
- **Event**：用户事件时间线，支持语义检索与时间过滤；
- **Buffer**：每个用户一个缓冲区，约 1024 token 或空闲 1 小时 flush；官方称单次 run 固定 3 次 LLM 调用，比早期 3–10 次省 40–50% token；
- **Context API**：直接返回可注入的字符串（用户背景 + 最近事件），官方称在线延迟 <100ms；
- 自报 LoCoMo 75.78（LLM judge），并开源了评测脚本。

对 QQ 群聊的启示：**"用户画像"与"群事件"是两种不同的记忆**，不该塞进同一张卡片；画像可以常驻，事件必须检索。

---

### 1.3 产品级助手：用户控制与"记忆摘要"是标配

| 产品 | 记忆类型 | 写入 | 用户控制 | 注入 | 失败模式/备注 |
|---|---|---|---|---|---|
| **ChatGPT** | 五种来源：saved memories、memory summary、reference chat history、project memory、custom instructions/Library/app | 用户说"记住"、模型自行保存、2025-10 起边聊边更新 | Memory summary 可编辑/划选纠正/删除；可分别关闭两种；Temporary Chat 不使用/不更新；saved memories 有搜索/排序/版本历史 | 常驻带时间戳的 `Model Set Context` + 最近约 15 条对话摘要（逆向观察，**没有向量 RAG**） | 删聊天不等于删记忆；project memory 没有清单；摘要不含全部；删除有最多 30 天日志 |
| **Claude / Claude Code** | Projects 的 project memory（`MEMORY.md` 索引 + topic 文件）+ project instructions；Claude Code 的 `CLAUDE.md` + auto memory | 用户让 Claude 记；auto memory 由 Claude 自己写；2026-08 起边聊边写 topic 文件 | Topics 逐条读/编辑/删；敏感主题默认不存；永不存证件号/犯罪记录/金融账号/移民身份；incognito；导入导出 | 每个新 thread 读 `MEMORY.md`，需要时再打开其他文件；Claude Code 每会话加载前 200 行/25KB | 项目记忆默认会外溢到项目外（需关 `Use account memory`）；edits 非强制；"记忆墓地"——旧失败方案堆满索引，让模型先入为主 |
| **GitHub Copilot** | Repository-level facts（团队共享）+ User-level preferences（跨 repo） | Copilot 自动创建；也可提示创建，但**不保证存** | 仓库设置里查看/删除；用户偏好有独立设置；不能手动编辑单条 | 会话开始时召回；用前拿 citation 对当前分支校验 | 90 天过期（7–180 可配），检索不续期、只有 upvote 续期；secret 直接拒绝；记忆不保证每次都用 |
| **Cursor** | Rules（用户/项目/文件级，手写）+ Memories（从对话学，按项目，需批准） | Rules 手写；Memories 自动抽取 | **2026-01 起 2.1.x 有意移除 Memories UI，但旧记忆仍在上下文生效**；只能导出成 `.mdc` 或降级删除 | Rules 每轮/按文件注入；Memories 未公开 | 反例：删除路径必须与写入路径同生命周期；移除 UI 却保留数据 = 用户无法清除 |
| **Gemini** | Memory of past chats（默认开启）+ Saved info / Instructions + Connected apps | 默认自动；显式条目手动 | Memory summary 可看/可编辑/可删/可关；删隐式记忆只能删聊天 | 未找到注入格式；来源标签 "Your saved info"/"Previous chats"（官方承认可能标错） | 默认开启的隐私惊吓；删除有延迟 |
| **Character.AI** | Pins + Story Memory + Facts（自动抓取）+ 400 字符固定记忆 | 自动/手动 | 容量条；pin/Story 受保护不参与淘汰 | 未找到 | pin 经常不生效；官方两处 pin 数不一致 |
| **OpenClaw** | `USER.md`（稳定偏好）+ `MEMORY.md`（长期事实）+ `memory/YYYY-MM-DD.md`（日记）+ `DREAMS.md`（只给人看） | 日记 + dreaming 整理晋升；唯一主写入者是 dreaming | 文件可直接改；`/context detail` 看原始 vs 注入；provenance 分级 | 预算内核心 + 检索；超预算只截断注入副本，磁盘不动 | 日记 30 天半衰期、核心永久；CJK 用 trigram；不可信来源排除 |

共同的产品原则：

1. **两种记忆分开**：显式保存的"事实" vs 从历史推断的"参考"。前者稳定、可编辑；后者可变化、可关闭。
2. **用户必须能看见**：ChatGPT 的 memory summary、Claude 的 Memory 文件、Copilot 的仓库设置、Cursor 的 Memories 列表。
3. **作用域清晰**：全局 / 项目 / 仓库 / 用户；跨作用域污染是头号投诉。
4. **删除要彻底**：ChatGPT 明确说"删聊天不等于删记忆"，并提供单独删除；Cursor 的反例说明"移除 UI 但保留数据"会让用户永远删不掉。
5. **记忆不是规则**：Copilot 明确写"记忆不保证每次都用；要稳定遵守请用 custom instructions"。这对 QQ 机器人同样成立：群规/人格应该进 system prompt 的稳定段，而不是记忆库。
6. **每条记忆带时间戳**：ChatGPT 的 `Model Set Context` 每条带时间戳，Claude Code 的 frontmatter 有 `modified`；模型据此判断"这条是不是过时了"。
7. **过期不等于删除**：Copilot 的 90 天过期、Character.AI 的 pin 保护、Claude Code 的"不过期但超限报错"是三种不同策略；关键是要明确"检索命中不续期，只有再次确认才续期"，否则热门旧记忆永远不过期。

#### OpenClaw：最接近 QQ 群需求的开源实现

OpenClaw（原 Clawdbot/Moltbot）的记忆设计值得单独看，因为它和 QQ 群一样是"多用户、长期在线、混合来源"：

- **四个文件**：`USER.md` 稳定偏好（独立小预算）、`MEMORY.md` 长期事实（启动加载）、`memory/YYYY-MM-DD.md` 日记（检索）、`DREAMS.md` 只给人看（不注入）。
- **五层**：instructions / curated core / episodic / prospective / review；**唯一主写入者是 dreaming 整理**（merge/supersede/dedupe），压缩前有 memory flush。
- **检索**：向量 + BM25 + recency + MMR；日记 30 天半衰期，核心永久。
- **中文**：CJK 用 trigram 分词，而不是 unicode61（后者把整句当一个 token）。
- **超预算**：磁盘不动，**只截断注入副本**；`/context detail` 可以看到原始 vs 注入的差异。
- **provenance**：每个 chunk 带 `owner/agent/untrusted/system`，不可信来源不参与晋升。

这套设计几乎可以直接映射到 dsh-qq-bot：`USER.md` ≈ 用户画像、`MEMORY.md` ≈ 群/用户长期事实、日记 ≈ `memory_events`、dreaming ≈ 后台整理、provenance ≈ 写入侧过滤。

---

## 2. 横向对比表

| 方案 | 记忆单元 | 写入触发 | 检索 | 注入 | 冲突/生命周期 | 作用域 | 可运维性 |
|---|---|---|---|---|---|---|---|
| AstrBot LivingMemory | 偏好/人物/计划/上下文 | 每 N 轮自动整理 | 关键词 + 向量 + 图谱 | 请求前 | 归档/衰减/访问强化 | 会话/人格 | 图谱、编辑、召回测试 |
| AstrBot Mnemosyne | 对话摘要 | 轮数/时间 | 向量 | 请求前 | 集合管理 | 会话/人格 | 管理面板 |
| AstrBot persistent-memory | 对话片段 | 回复后自动 | 向量 + BM25 + rerank | 请求前 | recency/importance/decay | global/session/两者 | 工具 + 配置 |
| LangBot LongTermMemory | L1 画像 + L2 episode | agent 工具 / 自动 | 向量（可选 hybrid） | L1 system prompt；L2 请求前 | supersede、候选审核、consolidate | session/speaker | Memory Console、审计 |
| ChatLuna long-memory | 带类型/重要度的记忆 | 主动/被动，3–5 轮 | 向量/图谱/激活扩散 | 按层合并注入 | 过期时间、遗忘 | global/preset/guild/user | 命令 + WebUI |
| Mem0（旧） | 自然语言事实 | 对话后异步 | 向量 + top-s 比较 | API 返回 | ADD/UPDATE/DELETE/NOOP | user/agent/run | 平台/开源 SDK |
| Mem0（2026） | 自然语言事实 | 单次抽取，只 ADD | 语义 + BM25 + 实体 + 时间 | API 返回 | 追加，不覆盖 | 同上 | 平台/开源 SDK |
| Zep/Graphiti | 实体/关系边 | 每 episode | 语义 + 关键词 + 图 | API 返回 | 双时间轴、边失效 | group/user | 图数据库、API |
| Letta | core blocks + recall + archival | agent 工具 / sleep-time | 语义/历史搜索 | core 常驻；archival 工具 | 块容量、后台整理 | agent/user | ADE、API |
| Memobase | 画像槽位 + 事件 | buffer flush（1024 token/1h） | 画像 + 事件语义 | context() 字符串 | 画像更新、事件时间线 | user | API/自托管 |
| **dsh-qq-bot 现状** | 三元组事实 + 原始消息 | 50 条/2000 字（空闲兜底实际不生效） | 纯 FTS5（`unicode61` 整句一个 token，中文查询基本匹配不到） | 冻结卡片 + 预取 | 唯一键覆盖、软删除、条数上限 | 精确 chatKey | 仅配置 + `/memory` 文本 |

---

## 3. 七条被反复验证的共识

### 3.1 读路径决定体验，写路径决定成本

用户感知到的"记性"几乎全部来自**这一轮回复有没有用上相关信息**。因此：

- 每轮都要有一次**低延迟、零/低成本**的召回（本地 FTS 或向量），把 top-K 拼进上下文；
- 工具调用是"深挖"，不能作为默认路径——模型不知道自己不知道什么，往往不会主动调；
- 召回失败/超时要**静默跳过**，绝不能影响主回复（这一点当前实现是对的）；
- **注入位置要保护前缀缓存**：稳定画像放 system prompt 的稳定段（不常变），每轮变化的记忆放当前 user 消息尾部（`extra_user_content` 一类）。AstrBot 生态的三个独立项目（LivingMemory v2.3.0、AstrBot #8080、persistent-memory）都指向这条；这不是"不要缓存"，而是"只让可变部分付缓存的代价"。

### 3.2 两层：稳定画像 + 情景记忆

- **画像/偏好**：姓名、称呼、角色、长期偏好、群规。变化慢、条目少、值得常驻。预算 300–600 字。
- **情景/事件**：某天说了什么、做了什么决定、项目进展。量大、时效强、必须检索。预算 800–1500 字。
- **原始对话**：作为证据/深挖层保留，不直接全量注入。

LangBot、Memobase、Letta、ChatGPT 都是这个结构；区别只是存储与检索实现。

### 3.3 记忆单元是自然语言，不是固定三元组

固定 `subject/predicate/object` 的好处是去重简单、卡片紧凑；坏处是**表达力被谓词表锁死**：

- "张三最近在折腾 NAS，已经换了三块硬盘"很难塞进"是/偏好/进行中/禁忌/已决定/备注"；
- 同一个人的"偏好"只能有一条，第二条会覆盖第一条；
- 80 字上限会逼模型丢掉限定条件，留下过度概括的"事实"。

市场主流是**自由文本 + 可选结构化元数据**：Mem0 的 fact、Memobase 的 profile slot、Letta 的 block、Claude 的 memory 文件都是自然语言；类型、重要度、来源、时间作为元数据，不参与表达。

### 3.4 不覆盖：追加 + 失效，保留历史

- Mem0 2026 明确改成 **ADD-only**，理由是覆盖会丢上下文；
- Zep 用 `valid_at/invalid_at` 让旧事实失效而不是删除；
- ChatGPT 的 saved memory 也是"更新/合并/删除"由模型决定，但保留 memory summary 的版本历史（部分计划）。

但"失效"不能交给 LLM 自由判。Graphiti 有一个仍未修的 issue：失效候选检索在重构后丢了 endpoint 作用域，退化成全 group 语义搜索，于是"只是提到某实体"的新事实可以退休该实体上无关但真实的事实。某生产图 3,950 条事实中 **1,616 条（41%）带 `invalid_at`**，抽审 4 条有 3 条是误杀。教训：**失效判定的作用域要尽可能小（同主体 + 同谓词 + 近邻），旧记录永远保留，宁可标"可能过时"也不要直接删。**

对 QQ 群来说，"张三上个月说自己在上海，这个月说搬到杭州"——正确的记忆不是"杭州"一条，而是"上海（至 9 月）/ 杭州（9 月起）"两条。覆盖会让机器人无法回答"他之前住哪"。

### 3.5 混合检索：向量不是万能，纯 FTS 更不是

- 向量擅长同义改写、跨语言、模糊语义；
- BM25/关键词擅长人名、项目名、编号、精确短语；
- 实体/图擅长多跳（"张三负责的项目用了谁推荐的方案"）；
- 时间/重要度用于重排。

AstrBot 的主流插件几乎都做"向量 + BM25 + rerank"；LangBot 也把 `retrieval_strategy: auto|vector|hybrid` 作为一等配置。纯 FTS 在中文短文本上尤其吃亏：SQLite 的 `unicode61` 不是中文分词器，**它把一整句连续汉字当成一个 token**；查询侧再按单字切、词间 OR，实际效果是"一个都匹配不到"（见 §5.4 的实测）。

### 3.6 写入要异步、批量、可退避

- 每轮调 LLM 总结 = token 与延迟双输；
- 市场常见做法是每 10–20 轮、或每 1–2k token、或空闲时批量处理；
- 用便宜/非推理模型，单次固定调用次数（Memobase 固定 3 次）；
- 失败要退避，水位线不推进，下次重试同一区间；
- 写入不应阻塞回复（当前实现基本符合）。

### 3.7 可运维性是功能的一部分

用户/管理员需要：

- 看见"它记住了什么"（列表、来源、时间、置信度）；
- 搜索、编辑、删除、置顶；
- 测试召回（输入一句话，看会注入什么）；
- 查看最近一次注入快照；
- 审计（谁在什么时候改了哪条）；
- 一键关闭/清空。

没有这些，任何"记忆不工作"的反馈都只能靠翻日志；这也是当前实现最大的产品缺口之一。

### 3.8 产品级实现补上的六个硬约束

1. **每条记忆带时间戳**：ChatGPT 的 `Model Set Context` 每条带时间戳，Claude Code 的 frontmatter 有 `modified`。模型需要知道"这是什么时候的事"，否则会把三个月前的偏好当现在。
2. **provenance（来源分级）**：OpenClaw 给每个 chunk 标 `owner / agent / untrusted / system`，不可信来源不参与晋升。对 QQ 群：群友原话、网页、工具输出都是 `untrusted`，可以进档案供检索，但**不能自动晋升为 L0 事实**；只有用户显式确认、管理员编辑、或机器人自己的稳定结论才能进 L0。
3. **敏感类别默认不存**：Claude 默认不存健康/种族/宗教/政治/性别认同，永不存证件号/犯罪记录/金融账号/移民身份。QQ 群同样需要一张"永不存"清单（手机号、住址、身份证、银行卡、感情/健康等），并且**默认不自动抽取个人敏感信息**。
4. **删除 = 硬删 + tombstone**：ChatGPT/Claude/Poe 都承认"删了源还在"；Cursor 移除 UI 但保留数据更是反例。正确做法是：删除时同时写一条 tombstone（内容 hash/规范化文本），后续抽取命中 tombstone 就拒绝复活；管理员 purge 立即停止注入并删索引。
5. **过期语义要明确**：Copilot 的 90 天过期、检索不续期、只有 upvote 续期，是一个很好的默认；Character.AI 的 pin/Story 不参与淘汰，是另一种。关键是不要让"被检索到"自动续命，否则热门旧记忆永远不过期。
6. **超限报错而不是静默截断**：Claude Code 超限时写入成功但返回错误，要求重写索引；当前卡片的"挤掉尾部 + 提示还有 N 条"是静默截断，用户/模型都不知道丢了什么。至少要在工具结果和 `/memory` 里明确"哪些条目被挤出"。

---

## 4. 市场已经证明的反模式

### 4.1 会话内冻结记忆

Hermes 的 `MEMORY.md` 冻结是为了前缀缓存，但 Hermes 的会话边界由用户 `/new` 控制，且会话通常短。dsh-qq-bot 的 `sessionIdleTimeoutMs=0` 意味着一个群可能几个月不换会话；此时"冻结"等于"新记忆永远看不见"。

市场没有任何一家把"整个会话不更新记忆"作为默认行为。LangBot 的 L1 每次请求注入，ChatLuna 每轮召回，ChatGPT 的 memory summary 会随对话更新。**但市场确实在意缓存**：AstrBot 生态把可变记忆注入 `extra_user_content`，而不是改 system prompt；稳定画像仍然常驻。正确的对照不是"冻结 vs 不冻结"，而是"稳定段常驻 + 可变段尾部注入"。

### 4.2 固定唯一键 + 原地覆盖

Mem0 已经用 ADD-only 取代了覆盖式更新；Zep 用失效而不是删除。当前实现的 `(chat_key, subject, predicate)` 唯一索引会让"同一个人的第二条偏好"直接改写第一条——记忆越记越少，且无法回溯。

### 4.3 纯 FTS + 错误的中文分词假设

中文 FTS5 的 `unicode61` 不是为中文分词设计的。实测（Node 24 的 `node:sqlite`，FTS5）：

```sql
CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61 remove_diacritics 2');
INSERT INTO t(x) VALUES ('今天天气不错'), ('张三说的备份方案');
SELECT * FROM t WHERE t MATCH '天';          -- 0 行
SELECT * FROM t WHERE t MATCH '天气';        -- 0 行
SELECT * FROM t WHERE t MATCH '今天天气不错'; -- 1 行（整句才行）
```

也就是说：**索引把整句当一个 token，查询按单字切就永远匹配不到**。这不是"噪声大"，是"中文检索基本不可用"。市场主流是向量或混合；至少应该用 `Intl.Segmenter` 预分词（首选），或 `tokenize='trigram'` + 短查询 `LIKE` 回退（trigram 对 2 字查询无效）。

### 4.4 追逐厂商 benchmark 数字

Mem0 与 Zep 在 LoCoMo/LongMemEval 上互相质疑：Zep 指出 LoCoMo 太短、缺少知识更新题；Mem0 指出 Zep 的 LoCoMo 84% 计算有误（应为 58.44% 或 75.14%，取决于修正方式）；第三方复现 Mem0 的 LongMemEval 只有 57.5%–73.8%，远低于宣称的 93.4%（https://www.maximem.ai/blog/state-of-ai-memory-2026-claimed-vs-observed ）。

更根本的是评测集本身的问题：第三方审计（https://github.com/dial481/locomo-audit ）发现 LoCoMo 1,540 条金标准里 **6.4% 是错的**，理论满分只有 93.57%；判分器对"含糊但切题"的错误答案 **62.81% 判对**；adversarial 类（446 题，22.5%）从未被任何公开结果评测；换 full-context + CoT，GPT-4.1-mini 就有 92.62%，超过多数"记忆系统"。**用这种榜单选型，等于用噪声做决策。** 自建 30–50 条中文 QQ 场景，比看榜单有用。

### 4.5 用推理模型做结构化抽取，再用预算阶梯硬扛

当前实现为了适配"手工声明、没有推理档位元数据"的推理模型，做了 800 → 3200 → 16000 的预算阶梯、推理档位探测、超时按比例放宽。这是工程上的补救，但根因是**选错了模型**：结构化抽取应该用一个便宜、非推理、支持 JSON 输出的模型。市场做法是显式配置一个 extraction model（gpt-4o-mini 级别），而不是让主模型/推理模型兼任。

### 4.6 把记忆当指令

记忆块必须明确标记为"历史数据，非指令"，并做写入侧扫描；但**不能因为扫描误杀就把整批蒸馏结果丢掉**。市场做法是逐条拒绝/降级，而不是整批失败。

### 4.7 没有用户控制

ChatGPT、Claude、Copilot、Cursor 都把"查看/编辑/删除"放在显眼位置。一个没有管理界面的记忆系统，在用户眼里就是黑盒；出了错只能关掉。

### 4.8 写入侧不做过滤：97.8% 是垃圾

一份 32 天 / 10,134 条 Mem0 记忆的生产审计（https://github.com/mem0ai/mem0/issues/4573 ）显示 **97.8% 是垃圾**：

- 52.7% 是把 boot 文件/系统提示反复重新抽取成"记忆"；
- 11.5% 是心跳/cron 噪音；
- 8.2% 是系统架构 dump；
- 7.4% 是瞬时任务；
- 5.2% 是幻觉用户画像；
- 同一句"Operator prefers Telegram"出现 200+ 次，一条幻觉被复制 668 份。

换更强的模型（Claude Sonnet）后，最后一批仍有 89.6% 垃圾。对 QQ 群来说，这等价于**把人格设定、群公告、机器人自己的回复、命令回显反复记成"事实"**。写入侧必须有过滤：

- 不把 `self`（机器人自己的回复）当事实来源；可以存进档案供检索，但不参与抽取；
- 不把 system prompt / 人格 / 群公告 / 命令回显当输入；
- 不把"把刚才那条删了""记住我说的"这类**自然语言元指令**蒸馏成事实；
- 对重复内容做 hash/相似度去重，限制同一内容的出现次数。

当前实现只排除了斜杠命令；"把刚才那条删了"这类自然语言元指令仍会被蒸馏，这是一个真实漏洞。

---

## 5. 现状复盘：dsh-qq-bot 的具体问题

以下问题按主题分组，`P0/P1/P2` 标注优先级，均可在代码中定位。

> **如果只修一个问题，先修中文 FTS。** 实测 `unicode61` 把整句中文当一个 token，当前单字查询返回 0 行；`qq_recall_memory` 和每轮预取对中文基本不可用（详见 §5.4）。这比"卡片冻结"更底层：检索坏了，后面所有记忆都查不到。

### 5.1 P0：卡片冻结 + 会话永不结束 = 写了看不见

- `MemoryService.cardSection()` 把渲染结果放进 `frozen` Map，非空即冻结；`unfreeze()` 只在 `/reset`、`/memory reload`、世代交接时调用（`src/memory/service.ts:427-440`）。
- `sessionIdleTimeoutMs` 默认 `0`，插件会话永不回收（AGENTS.md 明确要求保持）。一个活跃群可能几周甚至几个月不 `/reset`。
- 后果：模型用 `qq_memorize` 写入后，工具返回"下一段会话开始生效"（`src/memory/service.ts:561`）；在这之前，它在系统提示里看不到自己刚写的东西。用户说"记住我喜欢简短回复"，机器人答应，但下一轮仍然按旧卡片回答。
- 这是"记忆不工作"最直接的来源，也是与市场做法差距最大的一点。
- **不是说不该保护前缀缓存**：AstrBot #8080 和 LivingMemory v2.3.0 都证明缓存很重要。错的是"整张卡片冻结"；正确做法是**只冻结稳定段（画像/群规），把可变段（本轮相关记忆）放到 user 消息尾部**。这样缓存只被可变段影响，记忆仍然每轮可见。

### 5.2 P0：唯一键覆盖 = 记忆越记越少

- `memory_facts` 上有 `UNIQUE(chat_key, subject, predicate)`（`src/memory/store.ts:152`）。
- `addFact()` 命中同键时原地 `UPDATE object`（`src/memory/store.ts:468-477`）；蒸馏的 `applyOps()` 也用 `ON CONFLICT ... DO UPDATE`（`:566-568`）。
- 后果：同一个人的"偏好"只能有一条；"进行中"只能有一个项目；新事实会静默覆盖旧事实，且旧值只留在被覆盖的行里（没有历史版本）。这正是 Mem0 2026 放弃的做法。

### 5.3 P0：蒸馏触发太粗 + 定时器快照 = 记忆长期不更新

- 批量阈值默认 50 条或 2000 字（`memoryDistillEvery` / `memoryDistillMinChars`，`src/config.ts:406-407`）。一个安静的小群可能几天都凑不够 50 条。
- **所谓"空闲兜底"实际不生效**：`sweepIdle()` 调的是 `shouldDistillNow()`，而后者只按条数/字数阈值判断（`service.ts:686-714`），既没有检查"距上次蒸馏是否超过 `memoryDistillIdleMs`"，也没有把 `force` 传给 `shouldDistill()`。低于阈值时，定时器每 10 分钟醒来一次，然后什么都不做。配置描述里的"距上次蒸馏超过该时间且有新消息就补一次"与实现不符。
- `idleSweepMs` 在 `createMemoryService()` 构造时按当时的 `memoryDistillIdleMs` 传入（`src/memory/index.ts`），`reconfigure()` 只清缓存、开关存储，**不会重启定时器**（`src/memory/service.ts:1093-1101`）。用户在 WebUI 把空闲蒸馏从 10 分钟改成 1 分钟，或从 0 改成 10 分钟，都不会生效，直到重启 dsh。
- 后果：记忆更新严重滞后；用户感觉"它根本没在学"。在安静群里，唯一的自动更新路径实际上是 `/reset`（force）或手动 `/memory distill`。

### 5.4 P0：中文 FTS5 检索基本不可用（不是"噪声大"）

- 表用 `tokenize='unicode61 remove_diacritics 2'`（`src/memory/store.ts:124`）。**实测：`unicode61` 把一整句连续汉字当成一个 token**，不是拆成单字。
- 查询侧按单字切分、词间 OR（`src/memory/rank.ts:38-62`），生成 `"张" OR "三" OR "说" OR …`。索引里根本没有这些单字 token，所以 **MATCH 返回 0 行**。
- 也就是说：`qq_recall_memory` 和每轮预取对中文查询基本永远返回空；只有两种情况下能命中——查询恰好等于整条消息，或查询是 ASCII 词（英文/数字）。
- `coverageOf()` 用 `String.includes` 做逐字覆盖，本来可以兜底，但它只对"已经命中的候选"生效；候选为空时它没有机会工作。
- 现有测试用的是 ASCII 或构造好的精确串，所以没暴露这个问题。`store.test.ts:97` 的用例查询 `"备" OR "份" OR "restic"`，断言 `hits[0].text` 含 `restic`——真正命中的是 ASCII 词 `restic`，两个中文单字一个都没命中。把 `restic` 去掉，查询就是 0 行。
- **这是当前最严重的功能性 bug，优先级高于任何模型/提示词调整。**

验证脚本（Node 24）：

```js
const db = new DatabaseSync(':memory:');
db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61 remove_diacritics 2')");
db.exec("INSERT INTO t(x) VALUES ('今天天气不错'),('张三说的备份方案')");
db.prepare('SELECT * FROM t WHERE t MATCH ?').all('天');   // []
db.prepare('SELECT * FROM t WHERE t MATCH ?').all('今天天气不错'); // 1 行
```

### 5.5 P0：QQ 号进入模型可见文本（违反明确要求）

- 蒸馏提示词示例写的是 `"@张三(12345) 是运维，负责服务器"`（`src/memory/distill.ts:32`）。
- `buildDistillPayload()` 的 `who` 是 `${senderName}(${senderId})`（`src/memory/distill.ts:70`）。
- `qq_memorize` 的工具描述示例也写 `"@张三(12345) 是 运维"`（`src/tools/memory.ts:107`）。
- 后果：模型被明确教成"记忆里要带 QQ 号"，卡片进入 system prompt 后，回复里就可能出现号码；这与 AGENTS.md 里"模型可见文本里不许出现 QQ 号"的硬要求冲突。`no-qq-number.test.ts` 只扫了 `rank.ts` / `handoff.ts` 等渲染器，没扫 `distill.ts` / `tools/memory.ts`，所以测试没拦住。

### 5.6 P1：没有管理界面

- `src/memory/` 下没有 `rpc.ts`；`src/client/` 里没有记忆卡片（只有配置卡）。
- 用户只能通过 `/memory` 看一段文本，无法搜索、编辑、删除、置顶、测试召回、查看来源。
- 对比：AstrBot 的几个主流插件都有管理面板；LangBot 有 Memory Console；ChatGPT/Claude/Copilot 都有设置页。没有可运维性，记忆就是黑盒。

### 5.7 P1：数据模型表达力不足

- 只有 6 个谓词（`src/memory/types.ts:136`），单条 object ≤ 80 字（`:140`）。
- 没有 `kind`（偏好/事实/事件/计划/规则）、没有 `importance`、没有 `valid_from/valid_to`、没有 `last_used_at`（`access_count` 有字段但 `touchFacts()` 从未被调用，属于死代码）。
- `memoryMaxFacts` 默认 40，卡片 600 字；对群聊长期记忆来说偏小，且淘汰策略是"非置顶 → 低置信 → 最久未更新"，会把仍有用的老事实挤掉。

### 5.8 P1：作用域太窄

- 只按精确 chatKey 隔离（`g-888` / `u-12345` / `g-888-u-12345`）；同一个人在群 A 的偏好，群 B 和私聊都看不到。
- 市场主流有 user / group / session / global 分层；ChatLuna 甚至允许每个层用不同引擎。跨群共享有隐私风险，但"同一个人跨群"至少应该是一个可配置选项。

### 5.9 P2：维护与死代码

- `store.prune()` 只在打开数据库和 `reconfigure()` 时调用（`src/memory/store.ts:620`，`src/memory/service.ts:1097`）；长期运行不裁剪，事件表会无限增长（默认每会话 2 万条，但只在重启/保存配置时才执行）。
- `touchFacts()` / `setPinned()` / `rev()` 没有调用点（`src/memory/store.ts:432-553`），说明"访问强化 / 置顶 / 版本"设计没有落地。
- `renderRecall()` 文案写"时间正序"，但 `packRecall()` 按分数排序（`src/memory/rank.ts:137-170`、`:209`），模型会看到"相关度顺序"却被告诉是"时间顺序"。
- `scoreCandidate` 注释写权重 0.6/0.3，实际常量是 0.7/0.3（`rank.ts:23-24`、`:111`）。

### 5.10 P2：成本与复杂度

- 每次消息都会 `scheduleBatchDistill`，50ms 后查一次 `eventsAfter(200)` 并累加字符数（`service.ts:678-705`）；繁忙群里这是每条消息一次额外查询。
- 蒸馏失败诊断非常详细（好事），但也说明失败路径很多：空输出、截断、JSON 非法、威胁扫描、超时、模型缺失……根因往往是模型选择/提示词/预算，而不是需要更多重试档位。

### 5.11 P0：自然语言元指令会被蒸成事实

- 当前只排除了**斜杠命令**（`dispatcher.recordMemory()` 里 `parseCommand()` + `COMMANDS` 判定，`src/pipeline/dispatcher.ts:174-175`）。
- 群友说"把刚才那条删了""记住我说的，别记别的""忘掉这个"——这些是**对机器人说的话**，不是关于世界的事实；它们会进入 `memory_events`，并在下一次蒸馏时被当成"用户偏好/禁忌"写进卡片。
- 市场做法（bl-chat-plugin、LangBot）都有"元指令/控制语句"过滤；这不是可选项，是记忆质量的基本盘。

### 5.12 P0：没有 provenance，群友闲聊可以直接晋升 L0

- `memory.record()` 把群友消息、机器人回复、`[图片]` 占位都写成同一种事件；蒸馏时全部进入 `new_events`（`src/memory/distill.ts:67-73`）。
- 没有来源分级：群友的玩笑、转述、网页内容、工具输出，和"用户明确要求记住"的事实，权重完全一样。
- 后果：一条群友的玩笑可能变成长期"事实"；机器人自己的回复也可能被当成"用户说过的话"再蒸馏回去。Mem0 的生产审计里 97.8% 垃圾，很大一部分就是这类"自产自销"。
- 需要 `provenance`（owner/agent/untrusted/system）和写入侧过滤；`self` 消息可以进档案供检索，但不应参与事实抽取。

### 5.13 P1：没有注入观测

- 当前没有记录"这一轮注入了哪些记忆、分数多少、占了多少字符、有没有被截断"。
- 出问题时只能看 `/memory` 的静态卡片，无法回答"为什么这轮没想起某件事"。
- 市场做法：LivingMemory 的观测台、LangBot 的最近注入快照、OpenClaw 的 `/context detail`。这是排查召回问题的唯一手段。

### 5.14 P1：没有敏感类别过滤 / "忘掉我" / tombstone

- `guard.ts` 只做提示注入与不可见字符扫描，不区分"这是隐私信息"。
- 没有用户自助删除；没有 tombstone，删除后的内容可能在下一次蒸馏被重新抽回来。
- 对 QQ 群来说，这是隐私边界问题，不只是功能问题。

---

## 6. 改造建议

> **落地状态（2026-10-29）**：P0 与 P1 的主体已实现——
> - 中文检索改为 `Intl.Segmenter` 分词（`memory/text.ts`，FTS 索引 `text_seg`/`content_seg`）；
> - 画像段写入即生效（按 `rev` 缓存），情景段每轮注入 user 尾部；
> - `memory_facts` 去掉唯一键，改为追加 + `status/valid_to` 失效；
> - 蒸馏默认 10 条/800 字，空闲 60s 心跳 realtime force，定期 prune；
> - 移除蒸馏/工具示例里的 QQ 号，新增自然语言元指令过滤；
> - 新增 `content/kind/provenance/importance/expires_at`、敏感过滤、tombstone、审计；
> - 新增 WebUI「记忆库」卡片与 `memory/*` RPC；
> - `/memory` 新增 `list/search/forget`。
> - **2026-11-01 新增**：共享群成员画像（`memory_members` + `subject_id` + 匿名 `member_ref`；每轮只注入当前说话人/被引用者；自述 active、转述 pending；WebUI 成员列表与 `/memory member`）。
> - **尚未实现**：跨群 `user` scope 检索（配置 `memoryCrossGroupUserProfile` 仅保留位）、完整审计 UI、自动评测集。
> 具体见 `docs/memory-design.md` 顶部变更说明与 `src/memory/`。


### 6.1 目标与非目标

**目标**

1. 用户说"记住"或群里出现值得记的事，**下一轮就能用上**；
2. 同一个人的多条偏好/多个项目不会互相覆盖；
3. 中文短文本能召回，噪声可控；
4. 管理员能看见、能改、能删、能测试；
5. 单机、SQLite、零外部服务（embedding 可选）；
6. 成本可控：写入异步批量，读路径零/低 LLM。

**非目标**

- 不做通用知识图谱/图数据库；
- 不默认引入外部记忆服务（Mem0/Zep Cloud）；
- 不追求 benchmark SOTA；
- 不把记忆做成"会自己长大的摘要"；
- 不为了前缀缓存牺牲记忆可见性。

### 6.2 三个方案

| 方案 | 内容 | 工作量 | 风险 | 适用 |
|---|---|---|---|---|
| **A. 止血** | 修中文 FTS、解冻卡片、去掉唯一键、降低阈值、修定时器、去 QQ 号、加 `/memory` 列表/搜索/删除 | 2–4 天 | 低 | 只想先让现有功能"能用" |
| **B. 两层重构（推荐）** | 新数据模型（自然语言条目 + 元数据）、画像 + 情景两层、每轮动态召回、中文分词/trigram、生命周期、WebUI 面板 | 2–3 周 | 中 | 想把长期记忆做成真正的功能 |
| **C. 外部记忆层** | 接 Mem0/Zep/Memobase 服务 | 1 周 + 运维 | 高（部署、隐私、成本、网络） | 多租户/大规模，不适合当前单插件定位 |

**推荐 B，先做 A 作为第一步。** C 不适合：dsh-qq-bot 的价值是"单插件、零外部依赖、数据在本地"；引入外部服务会破坏这个定位，而且 QQ 群聊的隐私边界更难控制。

### 6.3 推荐架构（B）

#### 6.3.1 数据模型

保留 `memory_events` 作为原始消息档案（证据层），新增 `memory_items` 作为"记忆条目"：

```sql
CREATE TABLE memory_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT NOT NULL,        -- 'group:<id>' | 'user:<qq>' | 'session:<chatKey>'
  kind          TEXT NOT NULL,        -- 'profile' | 'preference' | 'fact' | 'event' | 'plan' | 'rule'
  content       TEXT NOT NULL,        -- 一句自然语言陈述
  content_hash  TEXT NOT NULL,        -- 归一化 hash（去重 + tombstone 用）
  keywords      TEXT,                 -- 可选：检索用关键词（人名/项目名）
  provenance    TEXT NOT NULL,        -- 'owner' | 'agent' | 'untrusted' | 'system'
  importance    REAL NOT NULL DEFAULT 0.5,  -- 0~1
  confidence    REAL NOT NULL DEFAULT 0.7,
  source_from   INTEGER,              -- 来源事件 seq 区间
  source_to     INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  valid_from    INTEGER,              -- 事实开始为真的时间（可空）
  valid_to      INTEGER,              -- 失效时间；NULL = 仍然有效
  expires_at    INTEGER,              -- 过期时间；NULL = 不过期
  confirmed_at  INTEGER,              -- 最后一次被用户/管理员确认（续期用）
  last_used_at  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | pending | superseded | archived | deleted
  superseded_by INTEGER,
  pinned        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memory_items_scope ON memory_items(scope, status);
CREATE INDEX memory_items_time ON memory_items(scope, updated_at);

-- 防止"删了又被抽回来"
CREATE TABLE memory_tombstones (
  content_hash TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  deleted_at   INTEGER NOT NULL,
  deleted_by   TEXT NOT NULL       -- 'user:<qq>' | 'admin:<qq>' | 'system'
);

-- 审计
CREATE TABLE memory_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  item_id    INTEGER,
  action     TEXT NOT NULL,        -- add | update | invalidate | delete | merge | pin
  actor      TEXT NOT NULL,        -- 'agent' | 'admin:<qq>' | 'user:<qq>' | 'system'
  before     TEXT,
  after      TEXT,
  at         INTEGER NOT NULL
);
```

- **不再有 `(scope, subject, predicate)` 唯一键**；重复靠检索 + LLM 去重/合并，而不是数据库约束。
- `content` 是自然语言；`kind` 只用于展示/预算分配，不限制表达。
- `valid_from/valid_to` 支持"上海→杭州"这类时间变化；不要求双时间轴，够用即可。
- `provenance` 决定能不能进 L0：`untrusted` 只进档案/候选，不自动晋升。
- `status` 替代 `superseded_by IS NULL` 的二元判断，支持候选、归档、回收站。
- `expires_at` 按类型设置：群级稳定事实不过期，一般事实 90 天，用户偏好 180 天；**检索命中不续期，只有 `confirmed_at` 更新才续期**。

FTS5 增加一列"分词后的文本"：

```sql
-- 首选：写入时用 Intl.Segmenter('zh', {granularity:'word'}) 分词，空格连接后存 FTS
-- 备选：tokenize='trigram'（SQLite ≥ 3.34），但它只索引 3 字符序列
CREATE VIRTUAL TABLE memory_items_fts USING fts5(
  content_seg, keywords_seg, tokenize='unicode61'
);
```

> **首选 `Intl.Segmenter` 预分词**，不要直接用 `unicode61` 索引中文：它把整句当一个 token，单字/词查询都匹配不到。`trigram` 也不是万能：它只索引 3 字符序列，**2 字中文查询（"备份""张三"）会返回 0 行**；如果要用 trigram，必须再配一个 `LIKE '%query%'` 的短查询回退。`Intl.Segmenter` 的实测输出：`张三 | 说的 | 备份 | 方案 | 还是 | 用 | restic | 吧`——"张三""备份"都是独立 token，可以直接查。

#### 6.3.2 写入路径

```
消息 → memory_events（原始档案，零 LLM）
      ↓ 每 N 条 / 每 N 字 / 空闲
   抽取队列（每 chatKey 串行）
      ↓ 一次 LLM（便宜、非推理、JSON）
   memory_items 候选
      ↓ 去重/合并/失效
   落库 + 审计
```

- **触发**：默认每 10 条或 800 字，空闲 5 分钟兜底；可配置。比 50 条/2000 字更敏感。
- **模型**：单独配置 `memoryExtractModel`，默认用部署默认；建议在 UI 上提示"不要用推理模型"。
- **输入过滤（先做，再谈抽取）**：
  - 不把 `self`（机器人自己的回复）当事实来源；可以存进档案供检索，但不参与抽取；
  - 不把 system prompt / 人格 / 群公告 / 命令回显当输入；
  - 排除自然语言元指令："把刚才那条删了""记住我说的""忘掉这个"——它们是指令，不是事实；
  - 排除敏感类别（手机号/住址/证件号/银行卡/健康/感情等），或至少默认不自动抽取；
  - 对重复内容做 hash 去重，并检查 `memory_tombstones`，防止"删了又被抽回来"。
- **输出**：`{items:[{kind, content, importance, keywords, valid_from?}], invalidate:[{id, reason}]}`；**允许 0 条**。
- **provenance**：群友原话、网页、工具输出标 `untrusted`，只能进候选；用户显式"记住"、管理员编辑、机器人稳定结论标 `owner/agent`，可直接进 L0。
- **去重**：先 FTS/向量找 top-5 相似条目，再让模型决定 `ADD / MERGE / INVALIDATE / NOOP`；如果不想多一次调用，可以用规则：content 高度相似（归一化后包含/编辑距离）→ 合并；否则追加。
- **失效**：新条目与旧条目矛盾时，设置旧条目 `valid_to = now`、`status='superseded'`，**不删除**；失效判定限制在同 `scope` + 同 `kind` + 同主体/近邻，避免 Graphiti 式的全图误杀。
- **候选审核**：个人事实、低置信条目、`untrusted` 来源默认进 `status='pending'`，管理员在 WebUI 批准；群级公共事实（项目、决定、群规）可自动生效。
- **成本**：一次抽取覆盖 N 条消息；按 200 条/天的群、每 10 条一次，约 20 次/天；每次 1–3k 输入、200–400 输出。比每轮总结低一个数量级。

#### 6.3.3 读路径

每轮 `handleMessage` 在 `ensureAgent` 之后：

```
profile = memory.profile(scope)          // 常驻，≤400 字，按 rev 缓存
episodic = memory.recall(scope, query)   // top-K，≤1200 字，零 LLM
inject = profile + episodic              // 合并、去重、按分数排序
```

- **profile** 放 system prompt（order 890），**episodic** 放本轮 user message 前（数据块），这样：
  - profile 变化少，前缀缓存影响小；
  - episodic 每轮变化，但不污染 system prompt 的稳定前缀；
  - 不需要"冻结整个会话"。
- **作用域合并**：`session` > `user` > `group`；同内容去重；总预算硬上限。
- **打分**：`0.45 * 语义相似度 + 0.25 * BM25 + 0.15 * 时间衰减 + 0.15 * importance`；`use_count/last_used_at` 做轻微加成。这个形式来自 Generative Agents（recency 指数衰减 0.995、importance 1–10、relevance 余弦，三项归一后等权），但权重按 QQ 场景调过。
- **时间查询扩展**：识别"昨天/上周/上个月/去年/最近"等表达，转成 `ts` 范围过滤或加权。LongMemEval 的实验表明 time-aware query expansion 是有效优化；当前实现只有时间衰减，没有范围过滤。
- **工具**：`qq_recall_memory` 检索 items + events，返回来源（时间、说话人昵称、条目 id）；`qq_memorize` 写 items（add/update/delete），写入后**立即刷新 profile 缓存**，工具结果说"已生效"。
- **注入观测**：每轮记一条 `scope: memory` 日志（注入了哪些 id、分数、字符数、是否命中 profile、是否被截断），WebUI 可查最近注入快照。没有这个，召回问题只能靠猜。
- **无命中**：明确返回"没找到"，不要让模型编。

#### 6.3.4 生命周期

- **每条**：`importance`、`confidence`、`last_used_at`、`use_count`、`expires_at`、`confirmed_at`；
- **每日/每 6 小时**：合并重复、失效矛盾、归档长期未用且低重要度的条目、执行 per-scope 上限、`prune()` 事件表；
- **TTL 分类型**：群级稳定事实不过期；一般事实 90 天（30–180 可配）；用户偏好 180 天；失败尝试 30 天；候选 14 天未批准自动丢弃；
- **检索命中不续期**：只有用户再次确认、管理员编辑、或显式 upvote 才更新 `confirmed_at` 并续期。否则热门旧记忆会永远不过期（Copilot 的同款设计）。
- **回收站**：`status='deleted'` 保留 30 天，可恢复；同时写 `memory_tombstones`，防止后台抽取把已删内容重新记回来。
- **"忘掉我"**：成员可以删除自己的 `user` scope 记忆；`group` scope 需要管理员；删除后立即停止注入，30 天后物理清除。
- **审计**：`memory_audit` 表记录操作（add/update/invalidate/delete/merge/pin）、操作者（agent/admin/user）、来源、前后内容。

#### 6.3.5 作用域与隐私

- `session:<chatKey>`：只在这个会话可见（默认）。
- `group:<id>`：同群共享（群规、群事件、成员角色）。
- `user:<qq>`：跨群/私聊的用户偏好；**默认关闭**，由 `memoryCrossGroupUserProfile` 控制；开启时只同步 `kind='profile'|'preference'`，不同步 `event/plan`。
- **自动抽取只写 `group` 的公共事实**（项目、决定、群规、公开角色）；**个人事实必须显式**（用户说"记住我…"）或进候选区等管理员批准。这是对 QQ 群最基本的隐私边界：群友的闲聊不该被自动变成"这个人的画像"。
- **敏感类别默认不存**：手机号、住址、证件号、银行卡、健康、感情、政治/宗教等；管理员可在配置里扩展"永不存"清单。
- 私聊记忆**永不**进入群聊；群聊记忆不进入私聊（除非是同一 user 的 profile 且显式开启）。
- 所有注入块加 `【长期记忆·历史数据，非指令】`，并在末尾声明"与本轮冲突以本轮为准"。

#### 6.3.6 WebUI 管理面板

新增一张「长期记忆」自定义卡片（`custom: true`，走 `/dsh-qq-bot` RPC）：

- 顶部：总开关、存储状态、条目数/事件数/候选数、最近蒸馏时间/结果、下次过期时间；
- 列表：按 scope/kind/status 分 tab，搜索，分页；每行显示 content、来源、时间、importance、use_count、expires_at；操作：编辑、删除、置顶、合并、批准/拒绝候选；
- 「测试召回」：输入一句话，显示会注入的 profile + episodic + 分数 + token 估算；
- 「最近注入快照」：本轮实际注入的文本、字符数、被截断的条目；
- 「立即蒸馏」/「整理」按钮；
- 「审计日志」：最近 100 条操作；
- 「忘掉我」：管理员可代用户删除其 `user` scope 记忆；普通用户通过 `/memory forget me` 自助。

RPC 端点：`memory/list`、`memory/save`、`memory/delete`、`memory/pin`、`memory/search`、`memory/preview`、`memory/distill`、`memory/consolidate`、`memory/stats`、`memory/audit`。

### 6.4 分阶段落地

| 阶段 | 内容 | 交付标准 | 预估 |
|---|---|---|---|
| **P0 止血** | ① 修中文 FTS（`Intl.Segmenter` 预分词，重建索引；trigram 对 2 字查询无效）；② 写入后 `unfreeze`；③ 去掉唯一索引，允许多条同 subject/predicate；④ 阈值降到 10 条/800 字；⑤ 空闲兜底真的 force + `idleSweep` 实时读配置；⑥ 定期 `prune`；⑦ 去掉 distill/tool 里的 QQ 号；⑧ 修 recall 文案；⑨ `/memory list|search|forget`；⑩ 排除自然语言元指令 | 中文查询能命中；用户说"记住"后下一轮能看到；同一个人的两条偏好都在 | 2–4 天 |
| **P1 两层重构** | 新 `memory_items` 表；profile/episodic 两层；每轮动态召回；`Intl.Segmenter`/trigram；生命周期；provenance/敏感过滤/tombstone；注入观测；WebUI 面板 | 跨天/跨周仍记得人物与偏好；管理员能看见/改/删；召回可解释 | 2–3 周 |
| **P2 增强** | 可选 embedding（OpenAI 兼容端点）+ hybrid + rerank；候选审核；跨群 user profile；`Dream` 式整理；评测集 | 召回质量可量化提升；成本可控 | 按需 |

> P0 可以独立上线，风险低；P1 建议在 P0 验证后再做，避免一次性重写。

### 6.5 配置项调整（建议）

删除/降级：

- `memoryCardMaxChars` → 拆成 `memoryProfileMaxChars`（默认 400）+ `memoryEpisodicMaxChars`（默认 1200）。
- `memoryMaxFacts` → `memoryMaxItemsPerScope`（默认 200）。
- `memoryDistillEvery` / `memoryDistillMinChars` → `memoryExtractEvery`（默认 10）/ `memoryExtractMinChars`（默认 800）。
- `memoryDistillMaxTokens` / `memoryDistillRetryTokens` → 保留一个 `memoryExtractMaxTokens`（默认 2000），去掉预算阶梯；失败重试一次即可。
- `memoryDistillProvider/Model` → `memoryExtractProvider/Model`，UI 明确提示"建议非推理模型"。

新增：

- `memoryProfileMaxChars`、`memoryEpisodicMaxChars`、`memoryRecallTopK`（已有）、`memoryCrossGroupUserProfile`（默认 false）、`memoryCandidateReview`（默认 true，个人事实/低置信默认进候选）、`memoryConsolidateCron`（默认每日）、`memoryAuditRetentionDays`（默认 90）。
- `memorySensitiveFilter`（默认 true）+ `memoryNeverStore`（默认手机号/住址/证件号/银行卡/健康/感情等）。
- `memoryFactTtlDays`（默认 90）、`memoryUserPreferenceTtlDays`（默认 180）、`memoryTombstoneDays`（默认 30）。
- `memoryInjectLog`（默认 true）：每轮记录注入了哪些 id、分数、字符数。
- `memoryEmbeddingProvider` / `memoryEmbeddingModel` / `memoryEmbeddingBaseUrl`（可选，空 = 纯 FTS/分词）。
- 可选 `memoryMode: off|lite|full`：`lite` 只注入 L0 画像（≤600 字，零抽取），`full` 才有 L1 + 蒸馏；对应不同预算的部署。

### 6.6 评测方案

不要看厂商榜单，自建一个小而准的评测集：

- **30–50 条中文 QQ 场景**，覆盖 LongMemEval 五能力：
  1. 单会话事实（"我叫什么/我在哪个城市"）；
  2. 跨会话偏好（"上次说回复要简短"）；
  3. 时间推理（"上周说的备份方案是什么"）；
  4. 知识更新（"我换工作了"→ 新答案，旧答案不应作为当前事实）；
  5. 拒答（"我没说过的事"→ 明确说不知道）；
  6. 群/私聊作用域（群里的记忆不出现在私聊）；
  7. 多人混淆（张三和李四的不同偏好）。
- **指标**：recall@k（注入块里是否含 gold 事实）、answer accuracy（LLM judge + 人工抽检）、注入 token 数、P50/P95 延迟、抽取调用次数/token、false memory rate（注入了错误/过时事实的比例）。
- **方法**：脚本回放固定对话 → 触发抽取 → 提问 → 记录注入块与回答；对比 P0/P1/基线。
- **护栏**：每次改召回/提示词都跑一遍；不要用"感觉更好了"作为验收。

### 6.7 不建议做的事

- ❌ 把 `sessionIdleTimeoutMs` 改回非 0 来"制造会话边界"——那会丢写句柄，是另一个坑。
- ❌ 为了前缀缓存继续冻结整张卡片——市场保护缓存的方式是"稳定段常驻 + 可变段尾部注入"，不是"整卡冻结"。
- ❌ 引入图数据库/外部记忆服务——单插件定位不值得。
- ❌ 用推理模型做抽取，再靠 16k 预算硬扛——换便宜模型更简单。
- ❌ 把记忆工具默认开放给所有群成员——QQ 是无认证入口，保持现有权限模型。
- ❌ 把原始消息全量注入——那是聊天记录，不是长期记忆。
- ❌ 做"不可见的深层记忆"（Replika 反例）——用户不能审计的记忆，迟早变成隐私事故。
- ❌ 让记忆跨作用域默认外溢（Claude 项目记忆的反例）——群聊/私聊/跨群必须有明确开关。
- ❌ 移除管理 UI 却保留数据（Cursor 反例）——删除路径必须与写入路径同生命周期。
- ❌ 超限静默截断——Claude Code 的做法是写入成功但返回错误要求重写索引；至少要把"被挤出的条目"回给模型/管理员。
- ❌ 每天固定全量重蒸（Poe 反例）——按新增量增量抽取，别把整段历史反复烧。

---

## 7. 参考链接

### QQ / IM 机器人插件

- AstrBot LivingMemory：https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory
- AstrBot Mnemosyne：https://github.com/lxfight/astrbot_plugin_mnemosyne
- AstrBot persistent-memory：https://github.com/zhanzhao2/astrbot-plugin-persistent-memory
- AstrBot Memorix：https://github.com/exynos967/astrbot_plugin_memorix
- AstrBot simple_long_memory：https://github.com/piexian/astrbot_plugin_simple_long_memory
- AstrBot agentmemory：https://github.com/zouyonghe/astrbot_plugin_agentmemory
- AstrBot 每用户 Markdown 记忆：https://github.com/Bluezeamer/astrbot_plugin_memory
- LangBot LongTermMemory：https://github.com/langbot-app/langbot-longterm-memory
- LangBot 插件市场：https://space.langbot.app/market
- ChatLuna 长期记忆文档：https://chatluna.chat/ecosystem/plugin/long-term-memory.html
- ChatLuna LivingMemory：https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory
- NoneBot 用户画像记忆：https://github.com/lanxinmob/nonebot-plugin-memory

### 通用记忆层

- Mem0 仓库：https://github.com/mem0ai/mem0
- Mem0 论文：https://arxiv.org/html/2504.19413
- Mem0 新算法说明：https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm
- Mem0 评测文档：https://docs.mem0.ai/core-concepts/memory-evaluation
- Zep 论文：https://arxiv.org/abs/2501.13956
- Graphiti 仓库：https://github.com/getzep/graphiti
- Letta Agent Memory：https://www.letta.com/blog/agent-memory/
- Letta Sleep-time Compute：https://www.letta.com/blog/sleep-time-compute/
- Letta Memory Blocks：https://www.letta.com/blog/memory-blocks/
- LangMem Hot Path：https://langchain-ai.github.io/langmem/hot_path_quickstart/
- LangMem Background：https://langchain-ai.github.io/langmem/background_quickstart/
- Memobase 仓库：https://github.com/memodb-io/memobase
- Memobase Profile 文档：https://docs.memobase.io/features/profile/profile
- Memobase Context 文档：https://docs.memobase.io/features/context
- Memobase LoCoMo 评测：https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md

### 产品级

- ChatGPT Memory 帮助中心：https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- ChatGPT Memory FAQ：https://help.openai.com/articles/8590148-memory-faq
- Claude Code Memory 文档：https://code.claude.com/docs/en/memory
- Claude Projects 文档：https://code.claude.com/docs/en/claude-projects
- Claude Memory Tool：https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- GitHub Copilot Memory：https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory
- Cursor Rules：https://cursor.com/help/customization/rules
- Cursor 1.2（Memories 需批准）：https://cursor.com/changelog/1-2
- Claude Memory 官方说明：https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- OpenClaw Memory：https://docs.openclaw.ai/concepts/memory/
- OpenClaw Memory Architecture：https://docs.openclaw.ai/concepts/memory-architecture
- OpenClaw Memory Search（CJK trigram）：https://docs.openclaw.ai/concepts/memory-search
- Coze 长期记忆：https://docs.coze.cn/guides_long_memory
- bl-chat-plugin（Yunzai 默认值参考）：https://github.com/Cat-bl/bl-chat-plugin
- DSH qq-memory（同平台对标）：https://dsh-plugins-mp.com/plugins/zsf-2026--qq-memory

### 评测与争议

- LongMemEval 论文：https://arxiv.org/abs/2410.10813
- LongMemEval 项目页：https://xiaowu0162.github.io/long-mem-eval/
- LoCoMo 审计（6.4% 金标准错误）：https://github.com/dial481/locomo-audit
- Mem0 记忆质量审计（97.8% 垃圾）：https://github.com/mem0ai/mem0/issues/4573
- Graphiti 失效误杀 issue：https://github.com/getzep/graphiti/issues/1728
- Zep 对 Mem0 评测的质疑：https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- Mem0 对 Zep LoCoMo 的复现质疑：https://github.com/getzep/zep-papers/issues/5
- 第三方复现讨论：https://github.com/vectorize-io/agent-memory-benchmark/issues/42

### 本仓库的延伸阅读

- 深度附录（Mem0/Zep/Letta/LangMem/Cognee/Memobase/Supermemory/Memori/MemOS + 论文）：[`memory-research-llm-memory-layers.md`](./memory-research-llm-memory-layers.md)
- 产品级调研全文（ChatGPT/Claude/Gemini/Cursor/Copilot/Perplexity/Poe/Character.AI/Replika/Home Assistant/OpenClaw）：[`research/ai-memory-survey-2026-10.md`](./research/ai-memory-survey-2026-10.md)
- 当前设计：[`memory-design.md`](./memory-design.md)

---

## 8. 一句话总结

dsh-qq-bot 的长期记忆不是"蒸馏不够聪明"，而是**把记忆做成了一个会话内只读的快照 + 一个固定三元组的覆盖式数据库 + 一个中文基本匹配不到的 FTS 索引**；市场已经用两代产品证明，正确形态是**两层、每轮召回、自然语言条目、追加/失效、写入侧过滤、可看见可编辑**。先做 P0 止血（尤其是中文 FTS 与卡片解冻），再按 P1 重构，比继续调蒸馏提示词和预算阶梯更有效。
