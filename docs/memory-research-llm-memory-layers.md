# 主流开源 LLM 长期记忆层调研（2026-10）

> 目的：为 dsh-qq-bot 的长期记忆重构提供参考。所有结论附来源；明确区分 **【官方文档】**、**【厂商自测/厂商宣称】**、**【第三方验证/第三方批评】**。抓取时间 2026-10-29。
>
> 阅读提示：这个领域的基准数字**几乎全部是厂商自测**，而且不同 harness 之间不可比（见 §7）。任何"某某 92 分"都不应当作选型依据。

---

## 0. 一句话结论

1. **Mem0 已经在 2026-04 把核心算法换掉了**：从论文里的 `ADD/UPDATE/DELETE/NOOP` 四操作，改成 **单次 LLM 调用的 ADD-only**，并把图存储从 OSS 里删掉（只留托管平台）。今天再照抄论文那套"写入时让 LLM 判断 UPDATE/DELETE"的 pipeline，抄的是**已被官方废弃的设计**。
2. **写入时做冲突判定是当前最大的坑**：Graphiti 的失效判定有一个仍未修的 issue——一次写入可以让**全图**里语义相近但无关的事实互相"退休"（某生产图 3,950 条事实里 41% 被打了 `invalid_at`，抽审 4 条有 3 条是误杀）。
3. **"记什么"比"怎么检索"更决定成败**：一份 32 天、10,134 条 mem0 记忆的生产审计显示 **97.8% 是垃圾**，其中 52.7% 是"把 boot 文件/系统提示反复重新抽取成记忆"。对 QQ 群聊，这等价于把人格设定、群公告、机器人自己的回复反复记成"事实"。
4. 对"单机 + SQLite + 中文群聊 + 低预算"，**没有现成项目可以直接用**；可借鉴的是四个机制：**append-only + 显式失效位**（Zep/Graphiti）、**固定 L0 常驻块 + 可检索 L1**（Letta/Memobase）、**按 token 阈值批量蒸馏**（Memobase/LangMem）、**importance×recency×relevance 三因子排序**（Generative Agents）。

---

## 1. Mem0 / OpenMemory（mem0ai/mem0）

- 仓库：<https://github.com/mem0ai/mem0>（Apache-2.0，抓取时 67,967 stars / 885 open issues）
- 文档：<https://docs.mem0.ai>　论文：<https://arxiv.org/abs/2504.19413>（arXiv 2504.19413, 2025-04）
- 活跃度：极高（README 常年更新，2026-04 刚做大版本算法替换；issue 量大、关闭也快）

### 1.1 记忆分层与数据模型

**【官方文档】** 只有一层"记忆条目"（fact 文本 + embedding + metadata），没有 Letta 式的分层。作用域靠三个 id 切分：`user_id` / `agent_id` / `run_id`（平台另有 `app_id`）。所谓"语义/情景记忆"是**没实现的枚举**——文档自己写明 `semantic_memory` / `episodic_memory` "defined but never wired into the extraction pipeline"，传进去会报校验错误，只有 `procedural_memory` 可用（Python OSS 限定）。
来源：<https://docs.mem0.ai/core-concepts/memory-types>

存储分三处（v3）：
| 存储 | 内容 |
|---|---|
| 向量库 | 记忆文本、embedding、metadata（时间戳、hash、类别、attributed_to） |
| 图/实体表 | 实体 + embedding + 关联的记忆 id（只用于**排序加权**，OSS 里没有可查询的图） |
| SQL | 变更历史（ADD 事件）+ 滚动消息窗口（供去重与上下文） |

来源：<https://docs.mem0.ai/core-concepts/memory-evaluation>

### 1.2 写入路径

**旧版（论文 2025-04）**：抽取阶段从对话里拉候选事实 Ω；更新阶段对每条候选事实，先向量检索 top-s 相似记忆，再把"候选 + 相似记忆"交给 LLM，用 **function call** 让它选 `ADD / UPDATE / DELETE / NOOP`——不是分类器，是让 LLM 推理决定。
来源：<https://arxiv.org/html/2504.19413>（§Update phase）

**新版（v3，2026-04，当前 OSS 默认）**：六段式，**ADD-only，一次 LLM 调用**：
1. 会话在 agent 回复后**异步**进入 pipeline；2. context lookup（找相关旧记忆防重）；3. 单次 LLM 蒸馏出 ADD-only facts；4. hash 去重 + 向量化；5. 实体链接（专有名词/引号文本/复合名词短语）；6. 独立的时间推理 pass，抽取"事件何时发生、是否持续、精度、记忆类型（event/state/plan/preference/relationship/absence）"，可异步。
来源：<https://docs.mem0.ai/core-concepts/memory-evaluation>

破坏性变更（自托管用户必读）：`add()` 只再返回 `ADD`；`top_k` 默认 100→20；`threshold` 默认 `None`→0.1；`rerank` 默认 `True`→`False`；`enable_graph` / `graph_store` **从 OSS 删除**，图记忆变成平台专属功能。
来源：<https://docs.mem0.ai/open-source/graph_memory/overview>

默认组件（库模式）：LLM `gpt-5-mini`、embedding `text-embedding-3-small`、向量库**本地 Qdrant**（`/tmp/qdrant`）、历史库 **SQLite**（`~/.mem0/history.db`）、reranker 默认关闭。
来源：<https://docs.mem0.ai/open-source/overview>

自托管 server：Docker Compose（FastAPI + Postgres/pgvector，厂商部署文章另称带 Neo4j 做实体关系）。
来源：<https://docs.mem0.ai/open-source/overview>、<https://mem0.ai/library/integrations/self-host-mem0-docker>

### 1.3 更新与冲突

- **v3 的策略是"不解决冲突"**：新事实与旧事实并存，什么都不覆盖。官方理由是"保留时间上下文、避免过早合并造成信息丢失"（<https://docs.mem0.ai/core-concepts/memory-evaluation>）。
- **【第三方】静态审计**（issue #7002，读 OSS 2.0.15 源码）：写入时实际只有三道闸——MD5 精确去重、抽取 prompt 里的一句话、以及实体门（精确同名或 cosine ≥ 0.95）；**实体门只连边、从不合并记忆**；`update()` / `delete()` 不在 `add()` 路径上，`DEFAULT_UPDATE_MEMORY_PROMPT` 只有测试能到达；`expiration_date` 要调用方自己填，系统从不填。结论："没有人决定冲突"。
  来源：<https://github.com/mem0ai/mem0/issues/7002>
- 代价写在官方基准里：LongMemEval 的 `knowledge_update` 是**最难**的一类（93.6），官方解释正是"ADD-only 保留旧事实，语义相近的旧事实仍会一起被检索出来"。

### 1.4 检索

v3 多信号并行打分后融合：**语义（向量）+ BM25 关键词（含动词词形还原）+ 实体匹配 + 时间推理**（查询的时间意图分类不额外调 LLM，用写入时存的时间元数据打分；时间分是**加性**的，不会把候选过滤掉）。官方称融合分在每个类别上都优于单信号。
来源：<https://docs.mem0.ai/core-concepts/memory-evaluation>

中文注意点：BM25 与实体抽取依赖 `mem0ai[nlp]` 的 **spaCy `en_core_web_sm`**（英文模型）；Qdrant 后端还要 `fastembed` 才有 BM25，否则**静默退化为纯语义检索**。
来源：<https://docs.mem0.ai/open-source/graph_memory/overview>

### 1.5 注入与 token 预算

没有"注入层"概念，由调用方自己 `search(top_k=3~20)` 拼进 system prompt（README 的示例就是 `top_k=3`）。官方基准按 **top_200 检索预算**报分，平均每次查询 **6.8K~7.0K tokens**（对比 full-context 25K+）。

### 1.6 遗忘 / TTL

OSS 没有内建 TTL/衰减：`expiration_date` 需要调用方传（见 #7002）。平台侧有 temporal reasoning 但不可见源码。

### 1.7 基准（务必看清版本与口径）

**旧算法（论文 2025-04，LoCoMo，GPT-4o-mini，LLM-as-Judge "J" 分）**【厂商自测】：

| 方法 | 检索 tokens | search p50/p95 (s) | total p50/p95 (s) | J |
|---|---|---|---|---|
| Mem0 | 1,764 | 0.148 / 0.200 | 0.708 / **1.440** | **66.88** |
| Mem0g（图） | 3,616 | 0.476 / 0.657 | 1.091 / 2.590 | **68.44** |
| Zep | 3,911 | 0.513 / 0.778 | 1.292 / 2.926 | 65.99 |
| A-Mem | 2,520 | 0.668 / 1.485 | 1.410 / 4.374 | 48.38 |
| LangMem | 127 | 17.99 / 59.82 | 18.53 / 60.40 | 58.10 |
| Full-context | 26,031 | — | 9.870 / 17.117 | **72.90** |
| OpenAI(ChatGPT memory) | 4,437 | — | 0.466 / 0.889 | 52.90 |

来源：<https://arxiv.org/html/2504.19413>（Table 2）。摘要口径：比 OpenAI 相对提升 26%，图版再高约 2%，p95 延迟低 91%、token 省 >90%。

**关键反直觉事实**：**full-context 的 J 分（72.90）高于所有记忆系统**。Mem0 的卖点是"用 6 分换 91% 延迟 + 93% token"，不是"更准"。

**v3（2026-04）**【厂商自测，且明确注明平台 vs OSS 不同】：
- 平台：LoCoMo **92.5**（6,956 tokens/查询，p50 0.88s）、LongMemEval **94.4**（6,787 tokens，1.09s）、BEAM 1M 64.1、BEAM 10M 48.6（<https://docs.mem0.ai/core-concepts/memory-evaluation>）
- OSS 迁移文档口径：LoCoMo 71.4→**91.6**、LongMemEval 67.8→**93.4**，抽取延迟约减半（<https://docs.mem0.ai/open-source/graph_memory/overview>）
- 官方明说："Scores reflect Mem0's managed platform, which includes proprietary optimizations not available in the open-source SDK."

BEAM 10M 的分类分数是最诚实的失败模式清单：temporal_reasoning **16.3**、event_ordering **20.2**、multi_session_reasoning **26.1**、contradiction_resolution **32.5~35.7**——长程时间推理与矛盾消解至今没解决。

### 1.8 已知失败模式 / 社区批评

- **复现失败**：#3944 用平台跑官方 LoCoMo 脚本，J 只有 ~0.20；根因是平台用**当前日期**而非数据集时间戳，把 2023-05-07 的事记成"2026 年 1 月"。维护者承认并修复。 <https://github.com/mem0ai/mem0/issues/3944>
- **垃圾率 97.8%**：#4573，32 天 / 10,134 条 / 两种抽取模型（gemma2:2b 与 Claude Sonnet 4.6）。分类：boot 文件与系统提示重复抽取 **52.7%**、心跳/cron 噪音 11.5%、系统架构 dump 8.2%、瞬时任务状态 7.4%、**幻觉用户画像 5.2%**、身份混淆 3.3%、隐私泄漏 2.1%。换更强的模型**没有改善**（Sonnet 批次仍 89.6% 垃圾）；同一句"Operator prefers Telegram"出现 200+ 次；单条幻觉被复制 668 份。 <https://github.com/mem0ai/mem0/issues/4573>
- **判分过松**：官方 harness 的 LoCoMo judge 允许"部分正确即 CORRECT""日期差 14 天内算对""同名实体即算对"，第三方质疑会系统性抬高分数。 <https://github.com/mem0ai/memory-benchmarks/issues/10>
- 另有基线不一致的指控（A-Mem 数字与原文对不上）：<https://github.com/mem0ai/mem0/issues/4003>（见 locomo-audit 汇总）

### 1.9 OpenMemory：**正在下线**

**【官方】** 仓库内 `openmemory/` 顶部挂着 Sunsetting Notice：OpenMemory 正在 sunset，本地自托管请改用 Mem0 self-hosted server（`cd server && make bootstrap`）。
来源：<https://github.com/mem0ai/mem0/tree/main/openmemory>

历史架构（仍可参考）：FastAPI + MCP over SSE + **默认 SQLite（openmemory.db）** + **Qdrant** 向量库 + Next.js dashboard；MCP 工具 `add_memories / search_memory / list_memories / delete_all_memories`；每 app 的 ACL 与审计日志。
来源：<https://mem0.ai/library/coding-agents/how-to-make-your-clients-more-context-aware-with-openmemory-mcp>

⚠️ 注意区分：GitHub 上另有一个 `CaviraOSS/OpenMemory`（现名 LongMemory，Apache-2.0，SQLite 本地优先），**与 mem0 无关**，搜资料时极易混淆。

### 1.10 对本项目（单机/SQLite/中文群聊/低预算）

- ✅ 可借鉴：**单次 LLM 调用完成抽取**（成本可控）、**hash 去重**、**实体作为第三路召回信号**、**写入异步化**、**时间元数据在写入时抽好、检索时只做打分**（不额外调 LLM）。
- ❌ 不要抄：写入时 LLM 判 UPDATE/DELETE（已废弃且易误杀）；Qdrant 依赖；英文 spaCy 的词形还原（中文无效）。
- ⚠️ 直接接入不划算：OSS 仍需向量库 + 每轮 `add()` 一次 LLM 调用；中文 BM25 需要自己换 tokenizer。

---

## 2. Zep / Graphiti

- Graphiti 仓库：<https://github.com/getzep/graphiti>（Apache-2.0，活跃：2026-10 仍有提交）
- 论文：<https://arxiv.org/abs/2501.13956>（Zep: A Temporal Knowledge Graph Architecture for Agent Memory）
- 文档：<https://help.getzep.com/graphiti>
- 定位差异（官方）：**Graphiti 是开源框架**（自带图库、LLM、embedder，自己搭服务）；**Zep 是商业统一上下文层**（自研图库 Konig，宣称 sub-200ms）。

### 2.1 分层与数据模型（这是它真正的价值）

三层子图（论文 §2）：
1. **Episode 子图**：原始输入（message / text / JSON）+ 引用时间戳 `t_ref`，**非有损**的 ground truth；
2. **Semantic Entity 子图**：实体节点（含随时间演化的 summary）+ 实体间的关系边（fact，三元组）；
3. **Community 子图**：强连通实体簇 + 高层摘要（借 GraphRAG 思路）。

**双时间轴**：`T` = 事件发生时间（valid_at / invalid_at），`T'` = 入库事务时间（created_at / expired_at）。事实**只失效不删除**。
来源：<https://arxiv.org/abs/2501.13956>

### 2.2 写入路径

Episode 入库后，对每个 episode 跑一串 LLM 调用：实体抽取 → 实体消解/去重（与既有节点比对）→ 边（事实）抽取 → 边去重 → **冲突/失效判定** → 社区摘要（label propagation）。抽取支持 Pydantic 定义的 **prescribed ontology**，也支持 learned ontology。
来源：<https://github.com/getzep/graphiti>（README "Incremental Graph Construction" / "Prescribed & Learned Ontology"）

成本提示（官方）：ingestion pipeline 为高并发设计，默认 `SEMAPHORE_LIMIT=10` 就是为了压 429；官方还警告**不支持 Structured Output 的模型会导致 schema 错误与入库失败**，"小模型尤其严重"。
来源：<https://github.com/getzep/graphiti>（README IMPORTANT 段）

### 2.3 更新与冲突（最值得抄、也最值得警惕）

实现（源码 `graphiti_core/utils/maintenance/edge_operations.py`）：
- 新边若自带 `invalid_at`（即"这是历史事实"），直接 `expired_at = now`；
- 若某个候选边的 `valid_at` **晚于**新边，则**新边**被标为失效（"未来才成立的事实"）；
- `resolve_edge_contradictions`：仅当 `edge.valid_at < resolved_edge.valid_at` 时，把旧边 `invalid_at = 新边.valid_at`、`expired_at = now`。
- 语义：**时间区间重叠/先后关系决定谁失效，被失效的边永不删除**，所以可以回答"当时是什么"。
来源：<https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py>

**【第三方/未修复】失效判定会误杀**：issue #1728（open，2026-08 提出，2026-09 仍在讨论）。根因是 #906 重构后，失效候选检索**丢了 endpoint 作用域**——`search(..., SearchFilters())` 在全 group 内按语义相似度找候选，而旧的 `get_edge_invalidation_candidates` 会限制"只碰新边两个端点的边"。后果：一条**只是提到**某实体的事实，可以退休该实体上另一条毫不相关但真实的事实。实测：3,950 条事实的图里 **1,616 条（41%）带 `invalid_at`**；抽审 4 条，3 条是误杀（不同关系名、不同目标实体）。而且 LLM 只看到裸 fact 字符串、看不到两端实体，返回的 `contradicted_facts` 被直接当成失效集合，没有任何校验。
来源：<https://github.com/getzep/graphiti/issues/1728>

### 2.4 检索

- 三种基础检索：**cosine 语义 + BM25 全文 + BFS 图遍历**，可组合。
- **16 个现成 recipe**（`search_config_recipes.py`），按 edge / node / episode / community 四类对象分别配 search_methods + reranker：
  - `COMBINED_HYBRID_SEARCH_RRF`（BM25+cosine，RRF 融合）
  - `COMBINED_HYBRID_SEARCH_MMR`（MMR 多样性）
  - `COMBINED_HYBRID_SEARCH_CROSS_ENCODER`（BM25+cosine+**BFS**，cross-encoder 重排）
  - 以及 `NODE_DISTANCE`（按图距离）、`EPISODE_MENTIONS`（按提及次数）等
- Cross-encoder 三种：`OpenAIRerankerClient`（默认，用 logprobs）、Gemini、`BGERerankerClient`（bge-reranker-v2-m3，本地）。
来源：<https://help.getzep.com/graphiti/working-with-data/searching>、<https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_config_recipes.py>

### 2.5 注入与 token 预算

论文的 LongMemEval 设置：检索 **top 10** 节点与边注入，平均上下文 **1.6K tokens**（baseline full-context 115K）。

### 2.6 遗忘/TTL

没有 TTL；"遗忘"= `invalid_at` + 检索时按时间过滤（`SearchFilters` 可按时间点查询）。边永不物理删除。

### 2.7 基准

**【厂商自测，论文】**
- **DMR**（MemGPT 提出的 500 段多轮对话）：Zep **94.8%**（gpt-4-turbo）vs MemGPT **93.4%**；但同表里 full-context baseline 就有 **94.4%**（4-turbo）/ **98.0%**（4o-mini），Zep 用 4o-mini 是 98.2%。论文自己承认"每段只有 60 条消息，本来就塞得进上下文"。
- **LongMemEval**：4o-mini 63.8% vs baseline 55.4%（+15.2%），延迟 3.20s vs 31.3s，上下文 1.6K vs 115K；4o 71.2% vs 60.2%（+18.5%），2.58s vs 28.9s。
- 论文自曝的**负结果**：`single-session-assistant` 类别**下降** 17.7%（4o）/ 9.06%（4o-mini）。
来源：<https://arxiv.org/abs/2501.13956>（§4.2、§4.3.2、Table 2）

**【第三方】LoCoMo 84% 的争议**：有人复算 Zep 的 LoCoMo 分数，指其把被排除的 adversarial 类算进了分子、分母却没算，84% 应为 **58.44%**，并称改了 system prompt 与检索模板。
来源：<https://github.com/getzep/zep-papers/issues/5>（属对方仓库内的第三方 issue，非 Zep 官方结论）

### 2.8 对本项目

- ✅ **最值得抄的是数据模型**：episode（原始消息，不改写）+ 派生事实（带 valid/invalid 区间）+ 永不物理删除。用 SQLite 两张表就能实现，不需要图库。
- ✅ 检索融合思路（BM25 + 语义 + 一跳邻居）在 SQLite 上可用 FTS5 + 邻接表近似。
- ❌ 不要抄：写入时让 LLM 自由判定"哪条事实被哪条取代"——#1728 就是这条路的天花板；图库（Neo4j/FalkorDB/Neptune）对单机是纯负担（Kuzu 已 deprecated）。
- ⚠️ 每个 episode 5~10 次 LLM 调用，QQ 群聊的量级下成本不可接受。

---

## 3. Letta（原 MemGPT）

- 仓库：<https://github.com/letta-ai/letta>（Apache-2.0，25,270 stars）。**注意**：README 已声明当前源码迁到 `letta-ai/letta-code`，本仓库主要留 V1 SDK；V1 SDK 正在被 Agent SDK 取代。
- 文档：<https://docs.letta.com>
- 论文：<https://arxiv.org/abs/2310.08560>（MemGPT: Towards LLMs as Operating Systems）

### 3.1 分层模型（OS 类比）

| 层 | 位置 | 谁改 | 容量 |
|---|---|---|---|
| **Core memory / memory blocks** | **直接拼进 system prompt**（XML 风格），每轮必见 | agent 用工具自改，或开发者 API 改 | 有 `chars_limit`（文档示例 5000 字符） |
| **Recall memory** | 全部历史消息（DB），工具检索 | 自动写入 | 无上限 |
| **Archival memory** | 语义检索库，工具按需查 | agent 主动插入，**agent 不易改/删** | 无实际上限，可打 tag |

memory block 的真实注入形态（官方示例）：

```xml
<memory_blocks>
<persona>
<description>...</description>
<metadata>- chars_current=128
- chars_limit=5000</metadata>
<value>I am a helpful assistant named Sam...</value>
</persona>
<human>...</human>
</memory_blocks>
```

来源：<https://docs.letta.com/v1-sdk/memory/memory-blocks/index.md>

block 还能**跨 agent 共享**（shared blocks），当成协调原语用。

### 3.2 写入路径

- **hot path 自编辑**：agent 在对话中调 `core_memory_append / core_memory_replace / archival_memory_insert / archival_memory_search / conversation_search` 之类的工具。写入时机由模型自己判断。
- **sleep-time agents（2025-04 起）**：官方博客明确说这是为了修 MemGPT 原设计的两个毛病——"对话中调记忆工具会变慢"、"记忆管理与对话混在一个 agent 里不可靠"、以及"增量形成的记忆会越来越乱"。实现上**创建两个 agent**：主 agent **不给** core memory 编辑工具；sleep-time agent 持有编辑权，异步整理主 agent 的 in-context memory 与自己的 memory。
  来源：<https://www.letta.com/blog/sleep-time-compute/>
- **2026 的新方向 MemFS + dreaming**：记忆变成一个 **git 仓库**（`system/` 下的文件每轮进 system prompt，其余只在文件树里按需读），"dreaming" 用后台 subagent 复盘近期对话、合并重复、重排层级；可配置"每 N 个 step 后"或"上下文压缩时"触发，还能开 "Agent reviews" 二次审阅（更贵）。
  来源：<https://docs.letta.com/configuration/memory/>、<https://docs.letta.com/agent-sdk/memory/index.md>

### 3.3 更新与冲突

没有事实级冲突消解：靠 agent 自己 rewrite block（整块覆盖）或 archive 追加。**这是"用 LLM 的判断力代替 schema"的路线**，代价是不可审计、不可回滚（MemFS 用 git 补上了回滚）。

### 3.4 检索

- archival：embedding 语义检索（可加 tag 过滤）
- recall：对历史消息做全文/语义检索（"conversation search"）
- core：不检索，永远在上下文里

### 3.5 注入与 token 预算

核心取舍：**把宝贵的上下文预算固定分配给 core memory**（system prompt 内），其余靠工具按需拉。没有自动的 topK/衰减策略，全靠模型决策 + 字符上限。

### 3.6 遗忘/TTL

memory block 有字符上限（超限必须压缩/替换）；archival 无 TTL；消息历史永久保留（可 compaction 出上下文但仍在 DB）。

### 3.7 基准

- **DMR 93.4%**（gpt-4-turbo）——由 Zep 论文转述，MemGPT 自己报的指标。
- **【第三方】可复现性质疑**：Zep 论文称"因方法细节不足，无法用 gpt-4o-mini 复现 MemGPT 的结果"。
  来源：<https://arxiv.org/abs/2501.13956>（§4.2）

### 3.8 存储依赖

- `pip install letta` 本地：**SQLite + ChromaDB**
- Docker/生产：**Postgres + pgvector**（`LETTA_PG_URI`，需 `CREATE EXTENSION vector`）
  来源：<https://pypi.org/project/letta/0.5.1/>、<https://docs.letta.com/v1-sdk/docker/index.md>

### 3.9 对本项目

- ✅ **"固定 L0 块 + 可检索 L1"这个分层是对的**，且与插件现有 `memory/card.ts`（L0 卡片按世代冻结以保护 prefix cache）思路一致——Letta 的 block 也是稳定前缀。
- ✅ **sleep-time 的思路可借**：把"整理记忆"从对话轮里挪出去（插件已经是 `distill()` 异步 + `ctx.llm.stream()` 一次性请求，方向一致）。
- ❌ 不要抄：让模型在对话中自由调用记忆编辑工具（QQ 群里模型没那么多轮次预算，且会与工具权限/限流打架）；两套 agent 的 sleep-time 架构对单机插件过重。

---

## 4. LangMem（LangChain）

- 仓库：<https://github.com/langchain-ai/langmem>（MIT，1,726 stars / 78 open issues，2025-01 创建，相对年轻）
- 文档：<https://langchain-ai.github.io/langmem/>

### 4.1 分层模型

按认知分类给出**三种记忆 + 两种表示**：
- Semantic（事实）：**collection**（无界、检索）或 **profile**（严格 schema、单文档、只保留最新状态）
- Episodic（经历）：collection（few-shot、对话摘要）
- Procedural（行为）：prompt 规则或 collection

来源：<https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>

### 4.2 写入路径：hot path vs background

- **hot path**：给 agent `create_manage_memory_tool(namespace=...)` + `create_search_memory_tool(namespace=...)`，模型在对话中自己决定记/查。
- **background**：`create_memory_store_manager(...)` 从对话里自动抽取/合并；配 `ReflectionExecutor` 做**延迟/去抖**处理（对话活跃时先攒着，静默后再跑），官方明确提示"每条消息都跑很贵"。
  来源：<https://langchain-ai.github.io/langmem/background_quickstart/>
- 核心抽象是 **LangGraph `BaseStore`**：`namespace`（类似目录）+ `key` + `value` + 可选向量索引（`index={"dims":1536,"embed":"openai:text-embedding-3-small"}`）。生产用 `AsyncPostgresStore`，`InMemoryStore` 重启即丢。
- 另有 prompt optimization（`create_prompt_optimizer` 一类，用对话轨迹改 system prompt）——README 只写"optimize agent behavior through prompt refinement"，细节页未抓到，本文不展开。

### 4.3 更新与冲突

`create_memory_manager` 支持 `enable_inserts=True/False`：开=collection（可插入新条目，需自行处理重复/矛盾），关=profile（**只更新同一份文档**，天然无重复但也只保留最新态）。官方文档自己点明 collection 的两难："过度抽取会降低检索精度，抽取不足会降低召回"。
来源：<https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>

### 4.4 检索

委托给 store 的向量检索（`store.search(namespace, query=...)`），**没有内建时间衰减、importance、rerank**。文档里明确说"相关性不只是语义相似度，还应结合 importance 与 strength（近期/频次）"——但那是**建议**，不是实现。

### 4.5 注入与 token 预算

无内建注入策略；hot path 由模型自己调 search，background 由调用方把结果拼进 prompt。

### 4.6 遗忘/TTL

无。store 层可自己做，库本身不提供。

### 4.7 基准

**【厂商（Mem0）自测，对 LangMem 不利，谨慎看待】**：LoCoMo J = 58.10，但 **search p50 17.99s / p95 59.82s**，被 Mem0 论文直接评为 "impractical for interactive applications"。
来源：<https://arxiv.org/html/2504.19413>（Table 2）

### 4.8 对本项目

- ✅ **"profile vs collection"的二分非常好用**：QQ 群场景天然需要"群画像/成员画像"（profile，单文档覆盖）+ "事件流水"（collection，append）。
- ✅ **去抖（ReflectionExecutor）** 与插件的"按消息数阈值蒸馏"是同一思路，可以互补：再加一个"静默 N 分钟也触发"。
- ❌ 依赖 LangGraph 生态；无衰减/无 rerank/无冲突处理，等于只给了骨架。

---

## 5. 其他代表性项目

### 5.1 Cognee（topoteretes/cognee）

- <https://github.com/topoteretes/cognee>（Apache-2.0，32,832 stars / 1,075 open issues，非常活跃）
- **模型**：三库并存——关系库（文档/分块/**provenance**）、向量库（语义）、图库（实体关系）。
- **写入**：`add`（38+ 格式，规范化+hash 去重）→ `cognify`（六段：分类文档、权限检查、切块、**LLM 抽实体关系**、生成摘要、embed + 提交边；重跑只处理新增/变更）→ `memify`（剪枝陈旧节点、强化高频连接、按使用信号重配边权、补派生事实）。
- **两层记忆**：`remember(data, session_id=...)` 写**会话缓存**（原始、不切块、不抽图），`improve(session_ids=[...])` 把会话蒸馏成"经验/教训"文档并入永久图；`recall()` 先查会话缓存再落到图，结果带 `_source` 标记。
- **检索**：官方称 14 种模式（从经典 RAG 到 CoT 图遍历）。
- **默认后端**：SQLite + LanceDB + Ladybug（嵌入式，零基础设施）——**对单机最友好的一档**。
- 来源：<https://docs.cognee.ai/core-concepts/architecture>、<https://docs.cognee.ai/core-concepts/data-flows>、<https://www.cognee.ai/how-cognee-builds-ai-memory>（厂商博客）
- 对本项目：默认嵌入式存储是加分项，但 ECL 全链路每篇文档多次 LLM 调用，群聊逐条消息场景不划算；适合"群文件/公告/长文档"这类低频高价值输入。

### 5.2 Memobase（memodb-io/memobase）

- <https://github.com/memodb-io/memobase>（**Apache-2.0**，仓库 2026-01 仍有提交，文档 2025-12 更新）
- **模型**：不是"事实库"，是**用户画像 + 事件时间线**。画像由 **profile slots**（topic → sub_topics 的键值槽）组成，内置 `basic_info.name/gender`、`education.school/major` 等，可 `additional_user_profiles` 扩展或 `overwrite_user_profiles` 完全自定义。
- **写入**：**按用户缓冲 + 批量**。`max_chat_blob_buffer_token_size: 1024`（攒够 1024 token 才处理）、`buffer_flush_interval: 3600`（1 小时兜底）、`persistent_chat_blobs: false`（处理完默认删除原始 blob）。官方卖点正是"buffer 摊薄成本、系统里没有 agent 所以不会失控烧钱"。
- **维护**：`max_profile_subtopics: 15`（超了触发重组）、`max_pre_profile_token_size: 128`（单个槽超了触发重摘要）、`cache_user_profiles_ttl: 1200`。
- **检索/注入**：`context(chats=..., max_tokens=..., profile_event_ratio=..., time_range_in_days=..., prefer_topics=...)` 直接返回可注入的**结构化字符串**（"## User Background / ## Latest Events"），在线只做几次 SQL，官方称 <100ms。
- **中文**：**明确内建多语言 prompt（en / zh / ja）**，`language: "zh"` 即可——这是本文所有项目里唯一把中文当一等公民的。
- **存储**：FastAPI + Postgres + pgvector（**不是 SQLite**）。
- 来源：<https://docs.memobase.io/>、<https://docs.memobase.io/references/local_config>、<https://docs.memobase.io/features/context>、<https://docs.memobase.io/features/profile/profile>
- 对本项目：**思路最贴近**（画像 + 事件 + 预算化注入 + 批量写），但 Postgres 依赖与"按用户"而非"按群"的模型需要改造。

### 5.3 Supermemory（supermemoryai/supermemory）

- <https://github.com/supermemoryai/supermemory>（**MIT**，31,433 stars；但**自托管 server 二进制不开源**，"built from a separate, non-public codebase"）
- **模型**：Documents（原始，供 RAG 落地）vs **Memories**（抽取出的事实，构成 living graph）。三种边：**updates**（覆盖语义，`isLatest` 保证检索命中最新，历史可留档）、**extends**（补充，两者都有效）、**derives**（推断，跨记忆推理出未明说的事实）。
- **写入**：两阶段——chunks 索引（`status: done` 即可搜）+ **dreaming**（记忆模型做合并/整理）。`dreaming: "dynamic"`（默认，把相关文档分组一起做梦，质量更高、更省）vs `"instant"`（立刻、多计一次操作）。
- **注入**：另有 **Profile**（静态 + 动态摘要）作为常驻上下文。
- **基准**【厂商自测】：自称 LongMemEval / LoCoMo / ConvoMem 均 #1；LongMemEval **95% Recall@15 @ ~720 tokens**（对比 full-context 降 99.4%）。
- **【第三方】**：某对比站给 Supermemory LongMemEval 85.2%、Mem0 49%——**与两家的自报数字（94.4 / 95）完全对不上**，正好说明跨 harness 不可比。
- 来源：<https://supermemory.ai/docs/concepts/graph-memory>、<https://supermemory.ai/docs/concepts/how-it-works>、<https://supermemory.ai/docs/self-hosting/overview>、<https://gamgee.ai/vs/mem0-vs-supermemory/>（第三方对比，商业站点，谨慎）
- 对本项目：核心引擎闭源 + 云端优先，**不适合**"单机 + 可审计"的诉求；可借鉴 `updates/extends/derives` 三分类与 `isLatest` 检索位。

### 5.4 Memori（MemoriLabs/Memori，原 GibsonAI/memori）

- <https://github.com/GibsonAI/memori>（15,288 stars；GitHub 标 **License: Other**——非标准 OSI 标识，商用前必须自己读 LICENSE）
- **模型**：**SQL-native**，把记忆存进你已有的关系库（CockroachDB / MariaDB / MongoDB / MySQL / Oracle / Postgres / **SQLite** / TiDB）。抽象是 Entity（谁）/ Process（哪个 agent）/ Session（哪次交互）/ Memory。
- **写入**：包装 LLM client（`Memori(conn=...).llm.register(client)`），**自动**在后台做 capture + "Advanced Augmentation"（把工具调用、决策、结果也变成记忆原语）。也有 conscious/auto 两种模式的说法（本文未抓到该页原文，不展开）。
- **检索**：语义召回 + **importance 排序 + 时间衰减**（"intelligent decay"），可手动 recall。
- **基准**【厂商自测】：LoCoMo **87%**，平均 **721 tokens/查询**（full-context 的 2.8%），并称优于 Zep / LangMem / Mem0。
- 来源：<https://memorilabs.ai/docs/memori-byodb/>、<https://github.com/GibsonAI/memori>
- 对本项目：**SQLite 可用的少数派**，工程形态（包一层 client 自动记忆）不适合插件（插件走 dsh 的 agent loop，不是 OpenAI SDK）。

### 5.5 MemOS（MemTensor/MemOS）

- <https://github.com/MemTensor/MemOS>（Apache-2.0，12,126 stars / 155 open issues）
- **模型**：**MemCube** —— 把记忆内容 + 元数据（provenance、version）打包成基本单元，统一 **plaintext / activation（KV-cache 级）/ parameter（权重级）** 三种记忆形态，可 compose / migrate / fuse。三层架构：Interface / Operation / Infrastructure。
- 论文：<https://arxiv.org/html/2507.03724v2>
- README 宣称 **35.24% token 节省**、hybrid-retrieval、cross-task skill reuse。
- **对本项目特别相关**：README 明确提供 **DeepSeek Harness (`dsh`) 插件**（topics 里有 `dsh-plugin`、`deepseek-harness`），可给 dsh 加自动 recall + 后台捕获 + 本地 Memory Viewer。若要快速试错，这是唯一"开箱对接 dsh"的选项。
- 对本项目：能力最"重"（想做记忆 OS），单机插件用不到 parameter 级记忆；但 dsh 插件值得单独评估一次。

---

## 6. 学术与基准：什么方法在什么场景有效

### 6.1 MemGPT（<https://arxiv.org/abs/2310.08560>）

**核心思想**：虚拟上下文管理（OS 分页类比）。主上下文（prompt）有限，外部存储无限；LLM 通过 **function call** 自己在两者间搬运（"page in/out"），并决定何时回复用户。
**有效场景**：单文档远超上下文的分析任务；多轮对话中需要"记住并演化"人设。
**代价**：每次记忆操作都是一次额外的 LLM 往返；模型可能"忘记去记"或"记错位置"。Letta 官方后来自己承认这点（见 §3.2 的 sleep-time 博客）。

### 6.2 Generative Agents（<https://arxiv.org/abs/2304.03442>）

**这是"检索打分"最经典、最可复刻的一套**（全部数字来自论文原文）：
- **Memory stream**：每条记忆 = 自然语言描述 + 创建时间 + **最近访问时间**。
- **Recency**：按"自上次被检索以来的游戏小时数"做**指数衰减，衰减因子 0.995**。
- **Importance**：让 LLM 直接输出 **1~10** 的整数（"1 = 刷牙，10 = 分手/大学录取"），**在记忆创建时**生成一次。
- **Relevance**：记忆文本 embedding 与 query embedding 的**余弦相似度**。
- **融合**：三者 **min-max 归一化到 [0,1]** 后加权求和，`score = α_recency·recency + α_importance·importance + α_relevance·relevance`，论文里 **三个 α 都取 1**；按分数取能塞进上下文的前若干条。
- **Reflection**：当"最近感知到的事件的重要度累计 **超过 150**"时触发（实际约每天 2~3 次）。流程：取**最近 100 条**记录 → 让 LLM 生成"3 个最显著的高层问题" → 用这些问题去检索 → 让 LLM 抽取洞见并**引用证据记录** → 洞见作为新记忆写回流中（可被再次检索）。
来源：<https://arxiv.org/html/2304.03442v2>

**为什么值得抄**：它把"重要性"变成了可计算的量，而不是靠 LLM 每次现场判断；reflection 的"先生成问题再检索"是低成本抽象机制。

### 6.3 A-MEM（<https://arxiv.org/abs/2502.12110>）

**Zettelkasten 式**：每条新记忆生成一张"笔记"，含**上下文描述、关键词、标签**；系统检索历史笔记，语义相近就**建链**；更关键的是 **memory evolution**——新笔记会**反过来修改旧笔记的上下文表示与属性**，让网络持续自我精炼。
**有效场景**：知识不断被重新组织、需要"联想"的任务；论文称在 6 个基座模型上都优于 SOTA。
**代价/争议**：写入要为每条记忆做"找链 + 演化"，LLM 调用多；Mem0 的复现里 A-Mem 的 J 只有 **48.38**（且 Mem0 被指基线数字与 A-Mem 原文不符，见 <https://github.com/mem0ai/mem0/issues/4003>）。→ **"结构更精致"不等于"端到端更准"**。

### 6.4 MemoryBank（<https://arxiv.org/abs/2305.10250>）

**艾宾浩斯遗忘曲线**建模：记忆强度随"距上次回忆的时间"衰减，回忆时**强度增加**；用 R（retention）/S（strength）参数控制遗忘速率；配合对话摘要与**用户画像**更新。
**有效场景**：长期陪伴/心理咨询类（论文的 SiliconFriend），强调"该忘的忘掉、重要的强化"。
**对本项目**：这是"时间衰减 + 访问强化"最省钱的实现范式，纯公式、零 LLM 成本。

### 6.5 LongMemEval（<https://arxiv.org/abs/2410.10813>，ICLR 2025）

- 500 道人工题，**五项能力**：信息抽取、多 session 推理、**时间推理**、**知识更新**、**拒答（abstention）**。
- 结论：商用助手与长上下文模型在持续交互下**准确率掉约 30%**。
- 框架：把记忆拆成 **indexing / retrieval / reading** 三段；三个有效优化：**session 分解**（value granularity）、**fact-augmented key expansion**（索引时把事实拼进 key）、**time-aware query expansion**（查询时扩时间范围）。
- **对本项目的直接启示**：检索质量一半取决于"索引时怎么切、key 里放什么"，而不是"用什么向量库"。

### 6.6 LoCoMo（<https://arxiv.org/abs/2402.17753>）

- 平均 **304.9 轮 / 19.3 个 session / 9,209 tokens**，最长 35 个 session；任务含 QA、事件摘要、多模态对话生成。
- 结论：长上下文与 RAG 有改善，但**仍显著落后人类**。

### 6.7 【第三方】LoCoMo 本身的问题（重要）

独立审计仓库 <https://github.com/dial481/locomo-audit>：
- **6.4%（99/1,540）的金标准答案是错的**，理论满分只有 **93.57%**；
- **判分器过松**：刻意"含糊但切题"的错误答案有 **62.81%** 被判对；
- **adversarial 类（446 题，22.5%）从未被任何公开结果评测**；
- **换一个 full-context 的 CoT prompt，GPT-4.1-mini 就能到 92.62%**，超过多数"记忆系统"——**分数差距很大程度来自 answer prompt，不是记忆架构**；
- 类别样本量 96~841 不等，**56% 的相邻名次差异在统计上不可区分**。

→ 任何"我们在 LoCoMo 上 SOTA"的说法，都必须问：哪个版本、哪个 prompt、几次重复、有没有算 adversarial。

### 6.8 常见失败模式（汇总，带出处）

| 失败模式 | 具体表现 | 出处 |
|---|---|---|
| **自我强化 / 重复抽取** | 系统提示、boot 文件、机器人自己的话被反复记成"事实"；一条幻觉被复制 668 份；"Operator prefers Telegram" 出现 200+ 次 | mem0#4573 |
| **错误合并 / 错误失效** | 语义相近但主体不同的事实互相"退休"；41% 事实被标失效，抽审 3/4 是误杀 | graphiti#1728 |
| **时间推理崩坏** | 用"当前时间"代替数据时间戳；BEAM 10M 上 temporal 16.3、event_ordering 20.2 | mem0#3944、mem0 文档 |
| **检索噪音 / 判分虚高** | judge 接受"含糊但切题"；ground truth 本身错 6.4% | locomo-audit、memory-benchmarks#10 |
| **抽象丢失** | ADD-only 保留全部旧事实 → knowledge_update 成为最难类（93.6）；矛盾消解 32.5~35.7 | mem0 文档 |
| **延迟/成本失控** | 每条消息一次 LLM 抽取；LangMem 检索 p95 59.82s；Graphiti 每 episode 多次调用 + 429 风险 | mem0 论文 Table 2、graphiti README |
| **schema 脆弱** | 不支持 structured output 的模型会让 Graphiti 入库失败 | graphiti README |

---

## 7. 横向对比表

| 项目 | 分层模型 | 写入 | 更新/冲突 | 检索 | 存储依赖 | 成本 | 最适合场景 | 对本项目的可借鉴点 |
|---|---|---|---|---|---|---|---|---|
| **Mem0** (Apache-2.0) | 单层 fact + 作用域 id（user/agent/run）；语义/情景"类型"未实现 | v3：**单次 LLM ADD-only**，异步；hash 去重 + 实体链接 + 独立时间 pass | **不解决**：新旧并存，update/delete 不在 add 路径；实体门 cosine 0.95 只连边 | 语义 + BM25 + 实体 + 时间，加性融合；rerank 默认关 | 向量库（默认本地 Qdrant）+ SQLite history | 每次 add 1 次 LLM + 1 次 embedding | 通用助手/客服，托管优先 | 单调用抽取、hash 去重、实体作第三路信号、时间元数据写入时抽好 |
| **Zep/Graphiti** (Apache-2.0) | **episode / 实体 / 社区** 三层子图 + 双时间轴 | 每 episode 多次 LLM：实体抽取→消解→边抽取→去重→失效判定→社区摘要 | **事实失效不删除**：`invalid_at`/`expired_at`；但候选检索丢失作用域会误杀（#1728） | cosine + BM25 + BFS，16 种 recipe，RRF/MMR/node_distance/cross-encoder | Neo4j / FalkorDB / Neptune（Kuzu 已弃） | 高（多 LLM 调用 + 图库运维） | 需要"当时是什么"的时间推理、企业知识 | **数据模型**（原始 episode 不改写 + 派生事实带有效区间 + 永不物理删除） |
| **Letta/MemGPT** (Apache-2.0) | **core blocks（进 prompt）/ recall（消息）/ archival（语义库）** | hot path 自编辑工具；sleep-time agent 异步整理；新方向 MemFS(git)+dreaming | 无事实级消解，靠模型 rewrite 整块（MemFS 可 git 回滚） | block 不检索；archival 语义；recall 消息检索 | 本地 SQLite+Chroma；Docker Postgres+pgvector | 中高（每次记忆操作一次往返） | 长期陪伴、需要"人格稳定"的 agent | 固定 L0 常驻块 + 可检索 L1；把整理挪出对话轮 |
| **LangMem** (MIT) | semantic/episodic/procedural × **collection / profile** | hot path 工具 或 background `create_memory_store_manager` + `ReflectionExecutor` 去抖 | `enable_inserts` 开=collection（自行去重）、关=profile（单文档覆盖） | 仅 store 向量检索，无衰减/无 rerank | LangGraph BaseStore（内存 / Postgres） | 低~中（可去抖），但检索慢（第三方测得 p95 59.8s） | LangGraph 生态内的快速原型 | **profile vs collection 二分**；去抖后再蒸馏 |
| **Cognee** (Apache-2.0) | 会话缓存 + 永久图（关系/向量/图三库） | `add`→`cognify`（六段，含 LLM 抽实体关系）→`memify`（剪枝/强化/派生） | 靠 memify 重配边权与剪枝，无严格时间有效性 | 14 种模式（向量/图/混合/CoT 遍历） | 默认 SQLite + LanceDB + Ladybug（嵌入式） | 中高（每文档多次 LLM） | 文档/代码知识库，低频高价值 | 嵌入式默认后端；会话缓存与永久图分离；`_source` 溯源标记 |
| **Memobase** (Apache-2.0) | **用户画像槽（topic/sub_topic）+ 事件时间线** | **按用户缓冲，攒 1024 token 或 1 小时批量处理**；处理完删原始 blob | 画像槽覆盖式更新；子主题 >15 触发重组；单槽 >128 token 重摘要 | 画像直出（SQL）+ 事件语义检索；`context()` 预算化拼装 | FastAPI + **Postgres + pgvector** | **低**（批量摊薄，无 agent 循环） | 陪伴/教育类"记住这个人" | **批量阈值 + 预算化注入 + 画像/事件二分**；**内建中文 prompt** |
| **Supermemory** (MIT；server 闭源) | Documents（原始）+ Memories（事实图）+ Profile（常驻摘要） | 两阶段：chunks 索引 + **dreaming**（dynamic 分组 / instant 立即） | `updates`（isLatest 覆盖语义）/ `extends` / `derives` 三分类 | 混合语义检索 + 图关系（`include.related`） | 自托管单二进制（`~/.supermemory`）；云为专有引擎 | 低（自托管免费 10k 文档）~ 云付费 | 想要"开箱即用 + 托管"的产品 | **updates/extends/derives 三分类**与 `isLatest` 检索位 |
| **Memori** (License: Other) | Entity / Process / Session / Memory（全在关系库） | 包一层 LLM client 自动捕获 + 后台增强（含工具调用轨迹） | 依赖 SQL 表结构，importance + 时间衰减排序 | 语义召回 + importance + decay | **任意 SQL 库（含 SQLite）** | 低~中 | 已有关系库、想"零新增基础设施" | 用 SQL 表 + 衰减做记忆，不引向量库的可行性 |
| **MemOS** (Apache-2.0) | **MemCube**：plaintext / activation / parameter 三形态统一 | 记忆调度与演化（compose/migrate/fuse） | 版本化（MemCube 带 provenance/version） | hybrid retrieval | 自托管服务 | 中高 | 研究/平台级"记忆 OS" | 已有 **dsh 插件**，值得单独试；概念对本项目偏重 |

---

## 8. 对"单机 + SQLite + 中文群聊 + 低预算"的落地建议

### 8.1 选型结论

**不要整体引入任何一个框架。** 理由：
- 需要 Postgres/图库的：Graphiti、Letta(Docker)、Memobase、Mem0(server) —— 与单机 SQLite 冲突；
- 核心闭源/云端优先的：Supermemory、Mem0 平台；
- 依赖特定生态的：LangMem(LangGraph)、Memori(包 OpenAI client)；
- 剩下的 Cognee 默认嵌入式，但写入链路对"每条群消息"过重。

**可借鉴的是机制，不是代码。**

### 8.2 五个可以直接落地的机制

1. **append-only 事件 + 显式失效位**（Zep/Graphiti）
   L1 表加 `valid_from / invalid_to / superseded_by`，**永不物理删除**；`/memory forget` 只写失效位。这样"当时群里说的是什么"可回溯，也避免 UPDATE 造成的不可逆损失。
2. **L0 固定块 + L1 检索**（Letta / Memobase）
   插件已有 `card.ts`（L0，按世代冻结以保护 prefix cache）——**这个设计是对的，不要改成"每次 rev 变就重渲染"**。可再加一层"群画像 profile"（群主题、常驻成员、黑话/称呼），像 Memobase 的 profile slot 一样**覆盖式更新**，与事件流水分离。
3. **批量 + 阈值蒸馏**（Memobase 1024 token / 1h；LangMem 去抖）
   插件现在按消息条数触发。建议补两个触发条件：**累计 token 阈值**、**静默 N 分钟**。群聊刷屏时按条触发等于烧钱。
4. **三因子排序**（Generative Agents）
   插件已有 BM25（按批归一）+ 时间衰减 + 覆盖率。可再加 **importance（写入时让蒸馏模型顺手打 1~10 分，零额外调用）**，并按 `α·rel + β·imp + γ·recency` 融合；这是纯公式，无额外成本。
5. **Reflection 的"先提问再检索"**（Generative Agents）
   蒸馏时不要只让模型"总结最近消息"，而是先让它生成"关于这个群/这个人，现在最该回答的 3 个问题"，再针对问题抽取事实——这正是把"流水"压成"洞见"的低成本办法。

### 8.3 必须防的坑（有实证）

- **别把机器人自己的输出、人格设定、群公告记成事实**（mem0#4573 里 52.7% 的垃圾来自这一类）。写入侧要过滤：`role=assistant` 的内容、与 L0 卡片高度重合的句子、命令回显。
- **别在写入时让 LLM 自由判定"谁取代谁"**（graphiti#1728）。若要做冲突处理，限制在**同一主体 + 同一谓词**的小窗口内（Graphiti 重构前就是这么做的），并且**保留旧记录**。
- **时间戳必须用消息时间，不是 `Date.now()`**（mem0#3944 的根因）。QQ 消息事件里带 `time`，务必透传；历史补录时更要小心。
- **中文 BM25 要自己选 tokenizer**。FTS5 默认 unicode61 对中文等于按字切；可考虑 `trigram` tokenizer 或写入前做轻量分词。**不要照搬 mem0 的 spaCy 英文词形还原**。
- **评测要自建**：拿 50~100 条真实群聊构造"该记住/不该记住/该忘掉/时间点"四类小题，人工判分。**不要用 LoCoMo 分数做决策**（见 §6.7）。

### 8.4 成本量级（用于估算，非承诺）

按 v3 的设计，一次蒸馏 = **1 次 LLM 调用**（抽取）+ 若干 embedding。以 1024 token 输入、每日活跃群 2,000 条消息估算：若按条触发 ≈ 2,000 次调用/日；按 1024 token 批量 ≈ 30~60 次调用/日（两个数量级差异）。**这就是"批量阈值"值得优先做的原因**。

---

## 9. 参考链接汇总

**项目**
- Mem0 仓库 <https://github.com/mem0ai/mem0>｜文档 <https://docs.mem0.ai>｜论文 <https://arxiv.org/abs/2504.19413>
- Mem0 v3 迁移 <https://docs.mem0.ai/open-source/graph_memory/overview>｜评测口径 <https://docs.mem0.ai/core-concepts/memory-evaluation>｜记忆类型 <https://docs.mem0.ai/core-concepts/memory-types>
- OpenMemory（sunset）<https://github.com/mem0ai/mem0/tree/main/openmemory>
- Graphiti <https://github.com/getzep/graphiti>｜检索 <https://help.getzep.com/graphiti/working-with-data/searching>｜论文 <https://arxiv.org/abs/2501.13956>
- Letta <https://github.com/letta-ai/letta>｜memory blocks <https://docs.letta.com/v1-sdk/memory/memory-blocks/index.md>｜archival <https://docs.letta.com/v1-sdk/memory/archival-memory/index.md>｜sleep-time <https://www.letta.com/blog/sleep-time-compute/>｜MemFS/dreaming <https://docs.letta.com/configuration/memory/>
- LangMem <https://github.com/langchain-ai/langmem>｜概念 <https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>｜background <https://langchain-ai.github.io/langmem/background_quickstart/>
- Cognee <https://github.com/topoteretes/cognee>｜架构 <https://docs.cognee.ai/core-concepts/architecture>｜数据流 <https://docs.cognee.ai/core-concepts/data-flows>
- Memobase <https://github.com/memodb-io/memobase>｜配置 <https://docs.memobase.io/references/local_config>｜context API <https://docs.memobase.io/features/context>
- Supermemory <https://github.com/supermemoryai/supermemory>｜图记忆 <https://supermemory.ai/docs/concepts/graph-memory>｜自托管 <https://supermemory.ai/docs/self-hosting/overview>
- Memori <https://github.com/GibsonAI/memori>｜BYODB <https://memorilabs.ai/docs/memori-byodb/>
- MemOS <https://github.com/MemTensor/MemOS>｜论文 <https://arxiv.org/html/2507.03724v2>

**论文/基准**
- MemGPT <https://arxiv.org/abs/2310.08560>
- Generative Agents <https://arxiv.org/abs/2304.03442>（HTML <https://arxiv.org/html/2304.03442v2>）
- A-MEM <https://arxiv.org/abs/2502.12110>
- MemoryBank <https://arxiv.org/abs/2305.10250>
- LongMemEval <https://arxiv.org/abs/2410.10813>
- LoCoMo <https://arxiv.org/abs/2402.17753>

**批评/审计**
- mem0#3944 复现失败 <https://github.com/mem0ai/mem0/issues/3944>
- mem0#4573 97.8% 垃圾 <https://github.com/mem0ai/mem0/issues/4573>
- mem0#7002 去重/冲突静态审计 <https://github.com/mem0ai/mem0/issues/7002>
- memory-benchmarks#10 judge 过松 <https://github.com/mem0ai/memory-benchmarks/issues/10>
- graphiti#1728 失效误杀 <https://github.com/getzep/graphiti/issues/1728>
- zep-papers#5 LoCoMo 84%→58.44% <https://github.com/getzep/zep-papers/issues/5>
- LoCoMo 独立审计 <https://github.com/dial481/locomo-audit>
