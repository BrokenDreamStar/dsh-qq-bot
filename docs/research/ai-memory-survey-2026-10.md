# 主流 AI 产品的「长期记忆」：产品交互与工程实现调研

> 调研时间：2026-10-29。用途：为 dsh-qq-bot 的长期记忆重构（L0 卡片 + L1 会话档案）提供外部参照。
> 所有链接均为调研时实际抓取到的页面；官方文档会随版本变化，引用处标注了页面上的更新时间（若可见）。

## 0. 证据分级与读法

本文把每条结论的来源标成四类，避免把逆向观察当成官方承诺：

| 标记 | 含义 | 可信度 |
|---|---|---|
| 【官】 | 厂商官方帮助中心、发布博客、更新日志、官方论坛工作人员回复 | 高，但会随版本变化 |
| 【逆向】 | 第三方通过系统提示提取/行为实验推断的实现细节（如 `Model Set Context`、`bio` 工具） | 中，可能已过期，只能当"设计假设" |
| 【用户】 | Reddit / 官方社区 / 论坛的个体报告 | 低（个案，非统计），但最能暴露交互缺陷 |
| 【研究】 | 学术论文、新闻调查、安全研究 | 中高，注意样本与时间 |

一个总判断先说在前面：**消费级产品的"记忆"正在从"条目列表"转向"模型维护的动态摘要"，而编程 agent 正在从"人写规则"转向"模型自写笔记 + 索引/按需读取"。这两条路线对 QQ 群聊机器人的含义完全不同**——前者适合"少量、稳定、可审计"的群设定，后者适合"大量、易变、按需检索"的群档案。后文第 8 节会给出取舍。

---

## 1. ChatGPT Memory

### 1.1 官方文档

- 帮助中心（当前主文档，抓取时显示 "Updated: 7 days ago"）：<https://help.openai.com/en/articles/8590148-memory-in-chatgpt>
- 同一篇文章的 FAQ 别名（历史链接仍可访问）：<https://help.openai.com/en/articles/8590148-memory-faq>
- 发布博客（含 2024-02 原文与 2024-09、2025-04、2025-06 三次更新）：<https://openai.com/index/memory-and-new-controls-for-chatgpt/>
- Projects（含 project-only memory）：<https://help.openai.com/en/articles/10169521-projects-in-chatgpt>
- Release notes（"Memory that stays more up to date" 一节）：<https://help.openai.com/en/articles/6825453-chatgpt-release-notes>

### 1.2 记忆的类型

ChatGPT 现在不是"一个记忆"，而是**五种来源混在一起**，官方在帮助中心开头就列了来源清单【官】：

| 类型 | 是什么 | 谁写的 | 用户能否逐条看到 |
|---|---|---|---|
| **Saved memories**（旧版） | 一条条独立事实，如"用户是素食者" | 用户说"记住"，或模型自行保存 | 能，列表 + 搜索/排序/版本历史 |
| **Improved memory / memory summary**（2025-10 起） | 一份持续更新的"高层摘要"，不是条目列表 | 模型边聊边更新 | 只能看摘要，官方明确说摘要**不包含全部** |
| **Reference chat history** | 从历史对话提炼的"洞察"，会随时间变化 | 后台自动 | 不能逐条看，只能问它/看 Sources |
| **Project memory** | 项目内聊天与文件作为上下文；可选 project-only | 自动，从项目内聊天推断 | **不能**列出清单（官方 FAQ 明确） |
| Custom instructions / Library 文件 / 连接的 app | 严格说不是"记忆"，但同属注入上下文，也被算作记忆来源 | 用户/外部 | 各自有入口 |

官方对"记忆 vs 自定义指令"的区分：自定义指令是"你直接给的指导"，记忆是"跨对话积累的相关信息"【官】。

### 1.3 写入触发

- **显式**：用户说"记住……"。官方例子："Remember that I am vegetarian when you recommend a recipe."【官】
- **隐式（模型判断）**：官方 FAQ 原话——"If you share information that might be useful for future conversations, ChatGPT may save those details as a memory without you needing to ask."【官】
- **边聊边更新**：2025-10 之后，记忆不再只在对话结束后总结，而是随对话持续更新（release notes："Memories are now updated automatically"）【官】。
- **项目内推断**：项目里的聊天会被当作后续对话的上下文；project-only 模式下只在本项目内互引【官】。

【逆向】补充：ChatGPT 的记忆写入走一个叫 `bio` 的内部工具，系统提示里写着 "The `bio` tool allows you to persist information across conversations. Address your message `to=bio`..."；保存下来的内容以 `Model Set Context` 的形式拼进系统提示，每条带时间戳。来源：<https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/>、<https://halcrawford.substack.com/p/the-memory-game>。这是 2024–2025 年的观察，OpenAI 从未官方确认，2025-10 的 improved memory 可能已经改了实现。

### 1.4 用户控制

入口：`Settings > Personalization > Memory`【官】。可用的控制项随套餐/地区不同，官方列出的可能项包括 `Memory`、`Reference saved memories`、`Reference chat history`、`Memory summary`、`Manage`、`Saved memories`。

- **看**：memory summary（顶部显示"2 hours ago"之类的最后更新时间）；或直接问"你记得我什么"。Saved memories 支持搜索、按新旧排序、按自动优先级显示（非 top-of-mind 的条目显示为灰色）【官】。
- **改**：在摘要底部输入框写更正；或划选摘要里的文字做局部更正【官】。
- **别再说了**：`Don't mention this again` —— 只减少未来提及，**不删除源头**【官】。这是一个很容易被误解为"删除"的按钮。
- **删**：删摘要里的条目 / 删 saved memory / 删聊天 / 删 Library 文件 / 断开 app。官方明确：**删聊天不一定会删掉由它生成的 saved memory**；反过来删记忆也不会删掉过去对话里已经说出口的内容【官】。
- **版本历史**：saved memories 可"view history"并按日期恢复旧版本（2025-10 起，Plus/Pro）【官】。
- **临时对话（Temporary Chat）**：开始前可选是否使用已有记忆/自定义指令；开始后不能改；临时对话不创建也不更新记忆；把临时对话保存为普通对话后，它会重新受记忆设置约束【官】。
- **锁定对话（Locked chats）**：锁定期间的新消息不会个性化到常规对话，但锁定前已记住的信息不会被移除【官】。
- **项目隔离**：项目可设 `Default memory` 或 `Project-only memory`；共享项目强制 project-only，且不能访问成员个人的项目外记忆【官】。
- **组织/工作区**：owner 可管记忆权限；医疗/受监管工作区的 improved memory 默认关闭【官】。

值得注意的空白：**project memory 没有列表**。官方 FAQ："Can I see a list of my project memories? No." 想阻止某条项目记忆被用，只能删掉那条聊天或把它移出项目【官】。

### 1.5 注入方式

- 官方口径：saved memories "像自定义指令一样，是模型生成回复所用上下文的一部分；除非你删除，否则总会被考虑"；但"ChatGPT 不会对每条回复都搜索你的历史，只在可能提升回复质量时查找相关上下文"【官】。也就是说：**saved memories 是常驻注入，chat history 是按需取用**。
- 【逆向】观察到的结构（2025 年，多个独立来源一致）：
  1. System instructions
  2. Developer instructions
  3. Session metadata（临时）
  4. User memory（`Model Set Context`，每条带时间戳，常驻）
  5. Recent conversations summary（约 15 条最近对话的标题 + 用户消息片段，**只摘用户说的话**）
  6. 当前会话消息（滑动窗口）
  
  来源：<https://manthanguptaa.in/posts/chatgpt_memory/>、<https://www.shloked.com/chatgpt-memory>、<https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/>。
- 这套设计的成本特征：**没有向量库、没有对历史做 RAG**，靠"预计算摘要 + 常驻注入"换低延迟。代价是 token 随记忆条数线性增长——一位用户 91 条记忆对应约 4000 tokens 的 `Model Set Context`，而基础系统提示约 1700 tokens【逆向/个案】<https://halcrawford.substack.com/p/the-memory-game>。
- 冲突处理【逆向】：`Model Set Context` 被视为"事实源"，优先级高于其他记忆模块；用户显式说过的内容覆盖模型推断的内容 <https://www.shloked.com/chatgpt-memory>。

### 1.6 容量与过期

- 官方：`Reference chat history` **没有单独的存储上限**（"There is no separate storage limit"）【官】。
- 官方：saved memories 有容量上限，会进入 "memory full" 状态；2025-10 起改为自动管理——把最相关的留在前面，不重要的"移到后台"（灰色），避免满【官】<https://getaidrops.com/openai/changelog/2025-10-15-8a1eb1ee>（第三方转录的官方 release notes，原始入口见 1.1）。
- 官方：删除的 saved memories 日志最多保留 30 天；关闭 reference chat history 后，派生信息在 30 天内从系统删除【官】。
- **未公开**：条数上限、token 上限。用户报告存在"条目数 + 总 token"双上限，达到 token 上限时模型仍说"记住了"但实际没存【用户】<https://www.reddit.com/r/ChatGPT/comments/1fc584y/anyone_else_experiencing_memory_issues_with/>。

### 1.7 演进时间线（2024–2026）

| 时间 | 变化 | 来源 |
|---|---|---|
| 2024-02-13 | 小范围测试 memory；"你可以让它记住、问它记得什么、让它忘掉、或整个关掉" | 【官】<https://openai.com/index/memory-and-new-controls-for-chatgpt/> |
| 2024-09-05 | 向 Free/Plus/Team/Enterprise 开放；新增 "Memory updated" 提示，hover 可进 Manage memories | 【官】同上 |
| 2025-04-10 | 新增 `reference chat history`：引用**所有**历史对话；Plus/Pro 先行，EEA/UK/CH 等地延后 | 【官】同上；【媒体】<https://techcrunch.com/2025/04/10/openai-updates-chatgpt-to-reference-your-other-chats/> |
| 2025-06-03 | Free 用户获得 **lightweight memory**：只提供"短期连续性"，Plus/Pro 才是长期理解 | 【官】同上 |
| 2025-10-15 | 自动记忆管理：优先级排序、搜索/排序、版本历史、消灭 "memory full"；Plus/Pro Web 全球 | 【官】release notes；【媒体】<https://www.testingcatalog.com/openai-prepares-automatic-memory-management-for-chatgpt/> |
| 2025 下半年–2026 | "Improved memory"：动态摘要取代条目列表；可切回 legacy `Saved memories`；memory summary + Sources；project-only memory；锁定对话；受监管工作区默认关闭 | 【官】<https://help.openai.com/en/articles/8590148-memory-in-chatgpt> |

关于"4o 更新"：OpenAI 没有把记忆绑定到某个模型版本的官方说明。用户侧的观感是**记忆质量随模型迭代波动**——2025-10 前后大量"记忆变差/名字记错/覆盖旧记忆"的报告，常与 GPT-5 上线时间重合【用户】<https://www.reddit.com/r/ChatGPT/comments/1ojyomo/why_is_no_one_talking_about_this/>、<https://www.reddit.com/r/ChatGPTcomplaints/comments/1o7peaq/new_chatgpt_memory_being_put_in_place_and/>。这只能当相关性，不能当因果。

### 1.8 已知失败模式与社区反馈

**官方自己承认的**

- memory summary 是"高层视图"，**不包含全部**记忆，也可能省略"不适合展示"的内容【官】。
- 删聊天 ≠ 删记忆；删记忆 ≠ 删过去对话里的提及；彻底删除要逐源删除【官】。
- 删除与记忆更新"需要时间传播"；日志保留 30 天【官】。
- project memory 没有清单，无法逐条审计【官】。
- Sources 可能不显示所有影响因素；分享链接里不含 Memory Sources【官】。

**用户报告**

- **"memory full" 删了也不降**：删大量条目后仍提示满；有人靠"一条条删、观察哪条占得多"才降下来【用户】<https://www.reddit.com/r/ChatGPT/comments/1qcqhlx/memory_full_even_after_deleting/>。同类："Help won't let me clear memory" <https://www.reddit.com/r/ChatGPT/comments/1nulau1/help_wont_let_me_clear_memory/>。
- **说记住了其实没存**：模型口头确认，但 Manage memories 里是空的；长条目更容易失败【用户】<https://www.reddit.com/r/ChatGPT/comments/1kkknkr/memories_are_no_longer_being_saved/>。
- **编辑变成新增**：想改一条，结果多出一条，旧的还得手动删【用户】<https://www.reddit.com/r/OpenAI/comments/1kq48wn/how_do_i_get_memory_to_work/>。
- **记忆整体消失**：部分用户 2025-11 报告 memories 不见了【媒体】<https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-memories-are-disappearing-for-some-users-heres-what-you-can-do-to-protect-yours>。
- **不稳定/覆盖**："每次开新对话问它记得什么，像抽奖"；"它会直接覆盖记忆"【用户】<https://www.reddit.com/r/ChatGPT/comments/1ojyomo/why_is_no_one_talking_about_this/>。

**研究与安全**

- 2,050 条 ChatGPT 记忆、80 位用户的审计：**96% 的记忆是系统单方面创建的，只有 4% 来自用户明确要求**；28% 含 GDPR 定义的个人数据，52% 落在 Theory-of-Mind 类别（目标、意图、信念）【研究】<https://www.cjr.org/tow_center/chatbots-memory-remember-users-conversations-history-openai-sam-altman-llm-gemini.php>（原文 arXiv 2602.01450）。
- 记忆会让模型更**谄媚**，并出现"视角谄媚"（把用户的政治/价值立场镜像回去）【研究】同上（MIT/Penn State）。
- **记忆注入**：间接提示注入可让攻击者往用户长期记忆里写东西，且跨会话持久。2024-09 的 PoC 让 ChatGPT 相信用户"102 岁、住在 Matrix、相信地球是平的"，并把它当外泄通道【媒体】<https://arstechnica.com/security/2024/09/false-memories-planted-in-chatgpt-give-hacker-persistent-exfiltration-channel/>；2025-11 的后续研究把 `bio` 工具 + 搜索工具串成持久外泄链【研究】<https://www.tenable.com/blog/hackedgpt-novel-ai-vulnerabilities-open-the-door-for-private-data-leakage>。
- 隐私的结构性问题：所有语境的数据被压进一个不分层的仓库，会出现"饮食偏好影响保险推荐"式的 context collapse【研究/评论】<https://www.technologyreview.com/2026/01/28/1131835/what-ai-remembers-about-you-is-privacys-next-frontier/>。

**对 QQ 机器人的直接启示**

1. "摘要 ≠ 全量"是官方设计，不是 bug；如果 QQ 侧只给用户看摘要，就必须接受"用户看到的不是全部"，并给管理员一个真正的全量视图。
2. "删聊天不删记忆"是用户最容易被激怒的点；QQ 侧要么做成"删消息即删派生记忆"，要么在删除时明确告知。
3. 常驻注入 + 无上限 = token 线性增长；QQ 群消息量远大于个人聊天，不能照抄。

---

## 2. Claude：跨对话记忆、Projects、Claude Code

### 2.1 官方文档

- 发布博客（Team/Enterprise，2025-09-11；文内更新 Pro/Max 2025-10-23）：<https://claude.com/blog/memory>
- 2026-08 更新（memory 贯通 chat 与 Cowork，改为"按 topic 存文件"）：<https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it>
- 帮助中心（当前主文档，抓取时 "Updated this week"）：<https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context>
- Projects 是什么：<https://support.claude.com/en/articles/9517075-what-are-projects>
- Projects 的 RAG：<https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects>
- Claude Code 记忆（CLAUDE.md + auto memory）：<https://code.claude.com/docs/en/memory>
- Claude Code 命令表（`/memory` 的定义）：<https://code.claude.com/docs/en/commands>

### 2.2 Claude 到底有没有跨对话记忆？

有，而且是**账号级 + 项目级两层**：

- 2025-09 先给 Team/Enterprise；2025-10-23 扩到 Pro/Max【官】<https://claude.com/blog/memory>。
- 2026 年文档：**Free/Pro/Max 在 Web、Desktop、Mobile 上默认开启**；Team/Enterprise 由 owner 控制，成员默认关闭、需自己打开【官】<https://support.claude.com/en/articles/11817273-...>。
- 记忆形态在 2026-08 改版：从"对话结束后总结成一份 memory summary"改成**边聊边写 topic 文件**——"Claude saves memory as a set of individual topics as you chat, rather than summarizing conversations after they end"【官】<https://support.claude.com/en/articles/11817273-...>、<https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it>。
- 2026-08 起 chat 与 Cowork（云端）共用同一份记忆；本地 Cowork 会话不用记忆【官】。

### 2.3 记忆 vs Projects 的 project knowledge

这是最容易混淆的一对，官方定义很清楚：

| | 项目知识（project knowledge） | 记忆（memory） |
|---|---|---|
| 谁产生 | **用户上传**的文档、文本、代码；用户写的 project instructions | **Claude 自己**从聊天里提炼的 topic |
| 形态 | 文件/指令，作为上下文或 RAG 检索对象 | 一组 topic 文件（2026 前是一份 summary） |
| 作用域 | 只在该项目内 | 项目有自己的记忆；项目内还会叠加"项目外聊天"的账号记忆 |
| 容量 | 接近上下文上限时自动切 RAG，容量最多扩 10× | 未公开条数上限 |
| 删除 | 删文件/删项目 | 逐 topic 删除；删项目会删项目记忆 |

关键细节：

- **项目之间的聊天上下文默认不共享**。官方原话："Context is not shared across chats within a project unless the information is added into the project knowledge base."【官】<https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects>。很多用户把 Projects 当 ChatGPT Projects 用，结果发现"每个 chat 都失忆"，这是**设计如此**，不是 bug【用户】<https://www.reddit.com/r/ClaudeAI/comments/1owvjfs/claude_doesnt_remember_chats_in_a_project_by/>。
- **项目记忆默认会"外溢"**：在项目里工作时，Claude 用"项目记忆 + 项目外的账号记忆"，但不用其他项目的记忆；新记忆存进项目，且**如果账号记忆开着，项目外聊天也能引用它**【官】<https://support.claude.com/en/articles/11817273-...>。要完全隔离，得在项目页的 Memory 里关掉 `Use account memory`。这是一个"默认不隔离"的隐私设计，2026-09 有用户报告改版后项目内甚至能读到所有项目的记忆【用户】<https://www.reddit.com/r/ClaudeAI/comments/1wauo0a/memory_on_claudeai_not_scoped_to_projects_anymore/>。

### 2.4 写入、控制、注入

**写入**【官】：

- 边聊边存（"Claude saves on its own"），也可以说"remember this"直接存。
- 敏感主题**默认不存**：健康、种族、族裔、宗教信仰、政治、性别认同等；要开 `Include sensitive topics in memory` 才存，且开启前的历史不会追溯保存。
- **永不保存**（即使你要求）：政府证件号、犯罪记录、金融账号、移民身份；Claude 会告诉你存不了。
- 组织级：owner 关掉记忆 → **所有成员的全部记忆立即删除**，且成员看不到该设置。

**用户控制**【官】：

- `Settings > Your Claude > Manage`（旧版 `Settings > Memory`）：按 Topics 列出，点开可读，可编辑、可删除；改一处，之后所有对话都生效。
- 也可以在对话里直接说"记住/改成/忘掉"。
- 单次对话关闭：新建对话时点 "+" 里的 Memory 关掉；**必须在发第一条消息前设置，之后不能改**；该对话仍留在历史里、仍可被搜索。区别于 incognito（完全不进历史、不被搜索）。
- 暂停 vs 重置：`Pause memory` 保留已有记忆但不再用/不再写；`Reset memory` **永久删除全部记忆（含项目记忆），不可撤销**。
- 数据保留：删除对话**不会**删除由它生成的记忆条目；但可以逐条删。组织设了保留期时，长期未更新的记忆条目会按保留期删除（项目记忆除外，项目删了才删）。
- 导出/导入：记忆可导出备份、也可从其他 AI 导入，官方标注"实验性"。
- 组织：owner 不能查看/编辑成员的个人记忆；但关掉组织记忆会全删。

**注入**【官】：

- 官方只说"记忆会作为上下文"，没有公开注入格式。
- 可观察到的：引用过去对话时会出现 **past chat citations**（链接回原对话，可顺手删除）；搜索历史对话是一个**工具调用**（RAG），不是隐式注入。
- 2025 年的实现是"一份 memory summary"，2026 改为"topic 文件列表"，用户可在设置里逐个打开——这暗示注入的可能是"摘要/索引 + 按需读取"，但**官方没有确认**，不要当事实。

### 2.5 Claude Code：CLAUDE.md 与 auto memory（与本项目最相关）

官方把两套系统并列【官】<https://code.claude.com/docs/en/memory>：

| | CLAUDE.md | Auto memory |
|---|---|---|
| 谁写 | 人 | Claude |
| 内容 | 指令、规则 | 学到的偏好、纠正、项目事实 |
| 作用域 | 项目/用户/组织 | 每个 git 仓库一份，worktree 共享 |
| 注入 | 每个会话 | 每个会话（**前 200 行或 25KB，先到为准**） |
| 适合 | 编码规范、工作流、架构 | 你的偏好、你给过的纠正、代码里看不出来的上下文 |

**CLAUDE.md 的层级**（从宽到窄）【官】：

1. Managed policy：`/Library/Application Support/ClaudeCode/CLAUDE.md`（macOS）、`/etc/claude-code/CLAUDE.md`（Linux）
2. User：`~/.claude/CLAUDE.md`
3. Project：`./CLAUDE.md` 或 `./.claude/CLAUDE.md`（可被 `AGENTS.md` 替代/并存）
4. Local：`./CLAUDE.local.md`（gitignore）
5. 子目录的 CLAUDE.md：**按需加载**（Claude 读写该目录文件时才加载）
6. `.claude/rules/*.md`：可用 YAML `paths` 做路径级规则，只在匹配文件被读写时加载

加载规则：工作目录及所有父目录的 CLAUDE.md 都会被拼接（不是覆盖），顺序从根到当前目录；`@path` 导入最多 4 跳；单个 CLAUDE.md 上限 4MiB，超过就整个跳过；HTML 注释在注入前被剥离【官】。

**Auto memory 的工程细节**（这是目前公开得最细的实现，值得逐条对照）【官】：

- 存储：`~/.claude/projects/<project>/memory/`，`<project>` 由 git 仓库推导，所以同一仓库的所有 worktree/子目录共享一份；可用 `autoMemoryDirectory` 改到绝对路径或 `~/`。
- 结构：`MEMORY.md` 是**索引**（一条一行），每个记忆一个 topic 文件（如 `user_role.md`、`feedback_testing.md`）。
- 注入：**只有 `MEMORY.md` 的前 200 行 / 25KB 进上下文**；topic 文件不预加载，Claude 需要时用文件工具自己读。
- 超限行为：接近上限时提醒 Claude 精简（一条一行、细节挪进 topic 文件、合并/删除过时条目）；**超过上限时写入仍成功，但返回错误要求重写索引**，因为超出部分下次加载会被丢掉（v2.1.210 起；之前是静默截断）。
- 四类记忆：`user`（角色/偏好）、`feedback`（纠正/确认的做法）、`project`（进行中的工作、决定）、`reference`（外部信息在哪）。
- 明确跳过：能从代码库推导的（架构、文件路径、调试修复）、CLAUDE.md 已经写了的。
- 时间戳：写文件时若带 YAML frontmatter，会自动记录 `modified`（ISO 8601），让 Claude 判断新鲜度。
- 不过期：`cleanupPeriodDays` 清理旧 transcript 时**跳过 memory 目录**，所以记忆一直留着，直到人或 Claude 改/删。
- 开关：`/memory` 里的 toggle 写 `autoMemoryEnabled` 到 `~/.claude/settings.json`；可按项目关；环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。
- 机器本地：不跨机器、不跨云环境；子 agent 不继承主对话的 auto memory（fork 例外）。

`/memory` 命令的作用【官】：列出所有 CLAUDE.md / CLAUDE.local.md / 其他记忆文件位置（含尚不存在的），可切换 auto memory、打开 auto memory 目录、选中文件在编辑器里打开（不存在则先创建）。`/context` 用来确认哪些 CLAUDE.md 和 rules 真的加载了。

### 2.6 失败模式与社区反馈

**官方承认的**

- 删除对话不删记忆条目；记忆条目按保留期删（项目记忆除外）【官】。
- 组织关记忆 = 全员记忆立即永久删除（治理上很强，但也意味着误操作不可逆）【官】。
- 记忆是"上下文"不是"强制配置"——官方在 Claude Code 文档里明说 CLAUDE.md 是 context, not enforced configuration；想强制拦截要用 hook【官】。
- 2026-08 改版后敏感主题默认不存，但"存了以后关掉设置会删掉已存的敏感条目"【官】。

**用户报告**

- **项目记忆跨项目可读**：2026-09 有用户报告一夜之间项目记忆被转成与全局相同的文件制，项目内能读到其他项目的记忆（只能写本项目的）【用户】<https://www.reddit.com/r/ClaudeAI/comments/1wauo0a/...>。
- **memory edits 不具约束力**：用户在 `memory_user_edits` 里写"不要引用 A"，但只要项目知识里有大量 A，Claude 照引不误；项目记忆是每 24 小时从项目聊天合成的【用户】<https://www.reddit.com/r/ClaudeAI/comments/1ossntx/exclusions_in_memory_user_edits_are_nonbinding/>。
- **记忆不更新/不写入**：订阅两周、反复要求记住，Memory 里什么都没有；也有人整个账号的记忆停在某一天不再更新【用户】<https://www.reddit.com/r/ClaudeAI/comments/1szgpao/claude_does_not_record_memory_or_project_memory/>。
- **"记忆墓地"效应**（Claude Code）：用户抱怨 `MEMORY.md` 积累了大量"试过、不行"的方案，Claude 看到新想法就先判定"这跟以前一样不行"，反而抑制探索【用户】<https://www.reddit.com/r/ClaudeAI/comments/1uchubf/claude_code_remembers_too_much/>。这是"只增不减的记忆"最典型的负面案例。
- **项目内 chat 不共享上下文**导致的"失忆"困惑（见 2.3）【用户】。

**对 QQ 机器人的启示**

- Claude Code 的"**索引常驻 + topic 按需读 + 超限报错**"几乎是本项目 L0/L1 的工业版，可以直接借用其阈值与失败策略（200 行/25KB 是英文；中文应按字符/字节折算）。
- "项目记忆默认外溢"是反面教材：QQ 群的记忆**默认必须不外溢**，跨群共享要显式 opt-in。
- "记忆墓地"提醒：L1 里的失败尝试/负面结论需要单独分类 + 短期过期，不能和稳定事实混在一张卡里。

---

## 3. Gemini：personal context / saved info / memory summary

### 3.1 官方文档

- 发布博客（2025-08-13，personal context 默认开启 + 临时对话）：<https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/>
- 帮助中心：保存信息与引用历史对话（含 Saved info 的增删改）：<https://support.google.com/gemini/answer/15637730>
- 帮助中心：用历史聊天做个性化（Memory 开关、删除、来源标签）：<https://support.google.com/gemini/answer/16598469>
- Gemini Apps Privacy Hub（memory summary、Keep Activity、敏感信息）：<https://support.google.com/gemini/answer/13594961>
- Instructions for Gemini（部分地区叫 Saved info）：<https://support.google.com/gemini?hl=en-NL&p=saved_info>
- Personal Intelligence 产品页：<https://gemini.google/overview/personal-intelligence/>

### 3.2 记忆的类型

Gemini 把"记忆"拆成三个互不相同的入口，比 ChatGPT 更"产品化"：

| 类型 | 是什么 | 触发 | 用户可见性 |
|---|---|---|---|
| **Memory of past chats**（personal context） | 从历史对话推断的兴趣/偏好/项目 | 默认开启，自动 | 只有 memory summary；逐条不可见 |
| **Saved info / Instructions for Gemini** | 用户显式保存的条目（"我是英语老师""别给我肉食食谱"） | 用户说"记住"或在设置里 Add | 完整列表，可编辑/删除/关闭 |
| **Connected apps**（Personal Intelligence） | Gmail、Search、YouTube 等数据 | 用户连接后自动 | 在 Connected Apps 设置里管理 |
| **Memory summary** | 对"它理解了你什么"的摘要 | 自动 | 可看、可编辑、可删、可关 |

官方对 Saved info 的定义：这些是"你给 Gemini 的指令"，会一直保留到你删除；可以停止保存【官】<https://support.google.com/gemini/answer/13594961>。

### 3.3 触发与前提

- Memory of past chats 的硬前提【官】：18 岁以上、**个人 Google 账号**（工作/学校/受监管账号不可用）、**Keep Activity 必须开着**。
- 2025-08 起**默认开启**（"This setting is on by default"），先在 2.5 Pro、部分国家上线【官】<https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/>；The Verge 同日报道确认默认开启、可在 Personal context 里关【媒体】<https://www.theverge.com/news/758624/google-gemini-ai-automatic-memory-privacy-update>。
- 不支持的地方：Gems、Live 对话（可以在文本对话里让它引用某次 Live）【官】。
- Saved info：可以在对话里说"记住……"，也可以进 `Settings > Saved info > Add`【官】。

### 3.4 用户控制

- 开关：`Settings & help > Personal Intelligence > Memory`（关掉即不用历史个性化）；`Saved info > Info you asked Gemini to save` 单独开关【官】。
- 查看：memory summary；或直接问 **"What do you know about me?"**【官】。
- 编辑/删除：summary 里可加、可改、可删；Saved info 逐条 `Edit` / `Delete`【官】。
- **删除"它从聊天里学到的东西"的唯一办法是删聊天**：官方原话——"To delete something that Gemini remembered about you, delete all chats with this info from Gemini Apps Activity"；删完"可能有一小段延迟"才停止使用【官】<https://support.google.com/gemini/answer/16598469>。这是 Gemini 与 ChatGPT 共同的"无法逐条删隐式记忆"问题。
- 临时对话（Temporary Chat）：不进最近记录、不受 Keep Activity 影响、不用于个性化、不训练；**只保留 72 小时**【官】<https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/>。
- 来源透明：用了 Saved info 会在回答下方显示 "Your saved info"；用了历史对话显示 "Previous chats"；官方承认"Gemini may occasionally make mistakes and display this label incorrectly"【官】。

### 3.5 注入方式与容量

- **未找到**官方对注入格式的说明（是摘要常驻还是检索片段）。官方只描述"Gemini 会在生成前判断你的指令、历史对话、连接应用是否有帮助"，以及"Sources and related content"里会标出来源【官】<https://gemini.google/overview/personal-intelligence/>。
- **未找到**官方公布的条数/字符上限或过期策略。可确认的只有：Keep Activity 关闭时不可用；删聊天后停止使用有延迟；Temporary Chat 72 小时删除。

### 3.6 失败模式

- **隐私惊吓**：默认开启 + 跨应用连接，让"它怎么知道"变得难以解释；Seattle Times 的实测里，研究者即使调低共享设置，聊天机器人仍能从"平装版《基督山伯爵》"的闲聊推断出年龄区间【媒体】<https://www.seattletimes.com/business/4-prompts-that-can-tell-you-what-chatbots-really-know-about-you/>。
- **来源标签可能标错**（官方承认），这会直接破坏"透明"的可信度【官】。
- **删除粒度粗**：只能删整段聊天，不能"忘掉这一条"【官】。
- **记忆注入**：2025-02 有研究者演示通过间接提示注入永久污染 Gemini 的长期记忆【媒体】<https://arstechnica.com/security/2025/02/new-hack-uses-prompt-injection-to-corrupt-geminis-long-term-memory/>。
- **可用性门槛**：工作/学校账号、未开 Keep Activity、部分国家/语言都不可用，导致"同一个产品不同人看到的功能不同"，支持成本高【官】。

### 3.7 可借鉴

- **Saved info 与 memory 分成两个入口**：一个"我说的"，一个"它推断的"，用户心智清晰。QQ 机器人也应该把"管理员/用户显式设定"与"蒸馏推断"分开呈现。
- **来源标签**：即使不完美，也比"黑箱"强；QQ 侧可以用 `/memory why` 或回复末尾可选标注。
- **默认开启 + 72 小时临时对话**是消费级取舍；QQ 群是多人环境，**不应默认开启自动记忆**。

---

## 4. 编程 agent（一）：Cursor 的 Memories 与 Rules

### 4.1 官方文档

- Rules（Project/User/Team/AGENTS.md 四类，加载与优先级）：<https://cursor.com/docs/rules>
- 1.0 更新日志（Memories beta）：<https://cursor.com/changelog/1-0>
- 1.2 更新日志（Memories GA + 后台生成需批准）：<https://cursor.com/changelog/1-2>
- Automations 的 Memories（`MEMORIES.md`，含提示注入警告）：<https://cursor.com/help/ai-features/automations>
- 官方论坛（Memories 在 2.1.x 被移除、无 UI 仍生效）：<https://forum.cursor.com/t/are-my-memories-gone/144057>、<https://forum.cursor.com/t/cant-clear-memories/148254>

### 4.2 记忆的类型

Cursor 有两套完全不同的东西，官方文档把它们分得很开：

| | Rules | Memories |
|---|---|---|
| 谁写 | 人（或让 Agent 生成规则文件） | Cursor 从对话里提取 |
| 形态 | `.cursor/rules/*.mdc`、`AGENTS.md`、User Rules（设置里） | 后台条目，按项目、按个人 |
| 作用域 | 项目 / 用户 / 团队 | 每个项目 + 每个人 |
| 注入 | 规则内容放在模型上下文开头 | 未公开 |
| 现状 | 主力机制 | **2.1.x 起移除 UI，但数据仍在** |

Rules 的四种应用方式【官】：`Always Apply`（每个会话）、`Apply Intelligently`（Agent 按 description 判断）、`Apply to Specific Files`（glob 匹配）、`Apply Manually`（`@rule` 引用）。优先级（冲突时前者胜）：Team Rules > Project Rules（`.cursor/rules`、`AGENTS.md`、`CLAUDE.md`、`.cursorrules`）> User Rules。Rules **只影响 Agent（Chat）**，不影响 Tab 补全【官】。

### 4.3 写入与生命周期（这是最有价值的一段）

- 2025-06（1.0）：Memories beta——"Cursor can remember facts from conversations and reference them in the future. Memories are stored per project on an individual level, and can be managed from Settings."【官】<https://cursor.com/changelog/1-0>
- 2025-07（1.2）：GA，并**引入"后台生成的记忆需用户批准"**（"user approvals for background-generated memories to preserve trust"）【官】<https://cursor.com/changelog/1-2>。
- 2026-01 起（2.1.x）：**Memories 功能被有意移除**，设置里没有入口；但旧记忆仍在上下文里生效。官方论坛工作人员的解决办法是：导出为 `.mdc` 再放进 Rules；或者**降级到 2.0.77 在设置里删除**，再升回来【官/论坛】<https://forum.cursor.com/t/are-my-memories-gone/144057>、<https://forum.cursor.com/t/cant-clear-memories/148254>。
- Automations 的 Memories 是另一套：按 automation 存 `MEMORIES.md`，默认开启，可在工具配置 UI 查看/编辑/删除；官方明确警告"处理不可信输入的 automation 可能被写入误导性记忆，影响后续运行"【官】<https://cursor.com/help/ai-features/automations>。

### 4.4 失败模式

- **功能移除但数据残留**：用户升级到 2.2 后，Agent 仍报告"有 32 条记忆"，但没有任何 UI 能删；Agent 自己还会回答"update_memory 工具不可用，请联系系统管理员"。官方给的唯一路径是降级旧版本【用户/官】<https://forum.cursor.com/t/cant-clear-memories/148254>。**这是"删除路径必须与写入路径同生命周期"的最佳反面教材。**
- **记忆消失**：1.7.x 有"重载窗口后记忆全空"的 bug，1.7.52 修复【用户】<https://forum.cursor.com/t/memories-get-deleted-when-reloading-window/137462>。
- **隐私模式冲突**：0.51 时期用户质疑"生成记忆是否要把代码发给 Cursor"，官方回应是为了避免代码进入模型训练，并限制 legacy privacy mode 下不存记忆【用户/官】<https://forum.cursor.com/t/0-51-memories-feature/98509>。
- **规则膨胀**：官方提醒"Rules 会进入每个会话，所以会累积；只在发现 Agent 重复犯错时才加，保持简短"【官】<https://cursor.com/docs/rules>。

### 4.5 可借鉴

- **"后台生成的记忆需批准"**：这是把自动写入的风险降到可控的最简单办法，适合 QQ 群的自动蒸馏（先进候选区，管理员/当事人确认后晋升）。
- **反模式**：不要移除 UI 却保留数据；不要做"和规则文件几乎一样"的第二套机制（社区普遍认为 Memories 被移除是因为"almost no different than .mdc files"）。
- Rules 的"按路径/按相关性加载"思路，可以借到 QQ 的"按话题/按成员加载记忆片段"。

---

## 5. 编程 agent（二）：GitHub Copilot 的 repository memory / custom instructions

### 5.1 官方文档

- Custom instructions（repo-wide / path-specific / AGENTS.md）：<https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions>
- Copilot Memory 概念（两类记忆、引用、投票、过期、默认值）：<https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory>
- 手动创建记忆（不能直接编辑，只能让 Copilot 写）：<https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/create-memories>
- 更新日志：2026-01-15 公开预览（28 天过期）<https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/>
- 2026-03-04 Pro/Pro+ 默认开启 <https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/>
- 2026-05-26 删除/作用域/CLI `/memory` <https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/>
- 2026-10-28 GA + "dreaming" <https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/>

### 5.2 记忆的类型（二分法非常清晰）

| | Repository-level facts | User-level preferences |
|---|---|---|
| 内容 | 仓库的编码约定、架构决定、构建/测试命令 | 你个人的表达偏好、审批要求、跨项目工作流 |
| 谁能看 | 有 repo 读权限且能用 Copilot Memory 的人 | 只有你（企业版管理员可查看/导出） |
| 作用域 | 仅该仓库 | 跨所有仓库 |
| 谁能建 | 有写权限且开启 Memory 的人 | 只有你 |
| 谁能删 | 有写权限且开启 user-level 偏好的人 | 你；企业管理员也可 |
| 引用 | 指向支撑该事实的代码 | 可能直接引用你说的话 |

官方还明确：**fork 不会复制记忆**；repo facts 不会跨组织池化；用户偏好可以继续在 fork 里生效【官】。

### 5.3 写入、校验、淘汰（目前最完整的"防过时"设计）

- 写入：Copilot 工作时自行判断并保存；用户也可以明确要求，但**"提示 Copilot 存记忆不保证会存"**，模型自己决定；已存在相似记忆时会**强化而不是重复创建**【官】。
- 校验：用到 repo fact 时，**拿引用去当前分支核对**是否仍然准确，只有通过校验的才用；但官方承认这是模型的判断，不是系统保证【官】。
- 投票：内部 upvote/downvote；upvote 的记忆更可能被送进模型；downvote 超过阈值后不再使用，并在**一段时间不用后删除**；投票数不展示，但列表顺序会反映（upvote 上浮）【官】。
- 过期：**默认 90 天**，企业/组织可把 repo facts 配成 7–180 天；**只有 upvote 会重置过期计时，单纯被检索不会续期**；downvote 不改变剩余时间。注意：2026-01 公开预览时官方写的是 **28 天**，后来文档改成 90 天默认——这是一次明确的策略演进【官】。
- 不存什么：检测到 secret（token/key/凭证）直接拒绝；识别到 model-control token 的拒绝（防提示注入）；被指示不存敏感/机密信息；不存短期任务指令【官】。
- 治理：repo 级开关、组织策略、企业导出/批量删除、billing entity 隔离；CLI 有 `/memory on|off|show`【官】。
- 2026-10 GA 时引入 **dreaming**：个人记忆整理、仓库记忆整理（对 skill/instruction 文件的改动以 PR 形式提出）、code review 反馈转成规则；dreaming 是 opt-in【官】。

### 5.4 失败模式

- **"让它记"不等于会记**：模型决定是否存、是否用；官方建议"要稳定遵守的规则请用 custom instructions"【官】。
- **不能直接编辑单条记忆**：只能在设置里看/删，想改要再跟 Copilot 说【官】。
- **"消失"不等于"删除"**：downvote 到阈值后不再使用、从列表隐藏，但仍可能存着直到过期【官】。
- **过期不等于删除**：过期后不再使用，但文档没有承诺立即物理删除。
- **PR 关闭也可能被记**：官方提示 repo facts 可能来自未合并就关闭的 PR，核对不保证识别所有过时事实【官】。

### 5.5 可借鉴

- **repo facts vs user preferences** 的二分，几乎可以直接映射成 QQ 的「群级事实」vs「个人偏好」，而且它把"谁可见/谁能建/谁能删"写成了表——这正是多人环境最需要的。
- **"引用 + 用前校验 + 过期 + 投票"** 是一套不依赖 LLM 每轮重算的防过时机制，成本低，适合低预算场景。
- **secret 检测 + model-control token 拒绝**：QQ 群用户会发 token、密码、身份证号，写入前必须过滤。

---

## 6. 其他消费级产品

### 6.1 Perplexity

- 发布博客（2025-11-26）：<https://www.perplexity.ai/hub/blog/introducing-ai-assistants-with-memory>
- 企业版记忆（行为写得最细）：<https://www.perplexity.ai/help-center/en/articles/13654357-memory-for-enterprise-organizations>
- Comet 浏览器记忆（与 Perplexity 共用）：<https://comet-help.perplexity.ai/en/articles/12658438-comet-memory>
- 普通版帮助页：<https://www.perplexity.ai/help-center/en/articles/10968016-memory>（**抓取时返回 HTTP 500**，内容以企业版页 + 博客为准）

**类型**【官】：`Memories`（偏好、兴趣、你分享的信息）+ `Search history`（过去的问答）。两者可独立开关。

**写入**：自动综合（"Perplexity now synthesizes them automatically"），不是用户逐条保存【官】。

**控制**【官】：`Settings > Memory` → `Use search history` / `Notes` / `Manage memories`；记忆库支持搜索、筛选、编辑、单条删除、`Delete all memories`；每条显示**日期、类别（Interests/Tools/Work/Preferences/Location…）和摘要**。

**注入**【官】：官方明确说"不是把历史当训练数据，而是从记忆库里**检索相关上下文**直接用于作答"——即 RAG 路线，与 ChatGPT 的常驻摘要不同。

**过期/治理**【官】：企业管理员可关；关掉时**该组织所有既有记忆立即删除**；清空的记忆日志最多保留 30 天（防止刚删就被重建）；企业记忆归组织所有，人走了就没了；incognito 下记忆与搜索历史都关闭。

**失败模式**：普通版帮助页长期 500（说明文档本身也是产品的一部分，会坏）；企业版与个人版行为差异大，容易误读；"自动综合"意味着用户很难知道某条是从哪句话来的。

### 6.2 Poe

- FAQ（Memory 与 auto-manage context）：<https://help.poe.com/hc/en-us/articles/19944206309524-Poe-FAQs>
- 隐私中心（删聊天后记忆可能残留）：<https://poe.com/pages/privacy-center>

**类型**：平台级 memory summary（跨模型、跨官方 bot），不是每个 bot 各自记忆。

**写入**【官】：**默认关闭**；开启后**每天更新一次**，只用开启之后的新消息（不回看旧消息）；关闭期间的消息永不进入记忆。

**作用域**【官】：群聊、half-shield bot、用户自建 bot、非聊天类 bot（图像/视频）都不生效；只对大多数官方 bot（Claude/GPT/Gemini）生效；跨设备同步。

**控制**【官】：`Settings > Memory` 开关、查看、永久删除；临时对话不写入、不被使用，24 小时内删除（上传文件最多 15 天）。

**成本**【官】：记忆作为上下文会"略微增加每条消息的 points"，官方说通常不显著。

**失败模式**【官】：隐私中心明确——"data you delete from a chat may persist in the background summaries generated from your Poe history"（删聊天后，派生的摘要可能还在）；"auto-manage context" 会在长对话里只发最近的消息，用户会误以为 bot 失忆（官方建议关掉它，但会更费 points）。

**可借鉴**：**默认关闭 + 每天一次批处理**，是低预算场景最省的写法；但"每天一次"会丢掉当天上下文，QQ 群更适合"空闲 + 条数水位线"。

### 6.3 Character.AI

- Pinned Memories 帮助页（每聊天 5 条 pin）：<https://support.character.ai/hc/en-us/articles/24327914463003-Pinned-Memories>
- 2026-05 博客（Story Memory / Facts / Memory Usage）：<https://blog.character.ai/memory/>
- 2025-05 博客（400 字符 chat memories）：<https://blog.character.ai/helping-characters-remember-what-matters-most/>
- 订阅页（Pins 15/30、Memory 三档）：<https://character.ai/subscribe>

**类型**（2026-05 之后）：

1. **Story Memory**：用户 pin 的消息 + 手动写的背景/关键事件；所有用户可用。
2. **Facts**：自动从聊天里抓取的人设/角色/配角事实，按 Persona / Character / 配角分 tab；可编辑、可关闭自动抓取、可删配角；仅 c.ai+。
3. **Chat memories**（2025-05）：一个 400 字符的固定文本框，写"角色必须记住的信息"。
4. **Pinned messages**：每条消息可 pin，早期文档说每聊天 5 条；订阅页现在是免费 15 / 付费 30——**官方两处数字不一致**，说明容量在扩，引用时要注明版本。

**控制**【官】：pin/unpin、编辑 Facts、`Start new chat` 时可选"把 Facts 复制到新聊天"、Memory Usage 可视化（显示 Facts / Story / 消息历史各占多少，快满时提醒）。

**淘汰**【官】：聊天变长后系统会在后台整理旧上下文，"保留重要的"；**用户写进 Story Memory 或 pin 的内容受保护，不会因为容量满而被清掉**。

**失败模式**【用户】：pin 经常不生效（"pin 了也忘"）、更新后记忆变差、付费版也"just mid"；有用户总结 pin 的内容要 <400 字符、且不能涉及被判定负面的主题才比较容易被记住【用户】<https://www.reddit.com/r/CharacterAI/comments/1s5j419/the_memory_is_horrendous/>、<https://www.reddit.com/r/CharacterAI/comments/1q5vw01/do_you_create_pinned_messages_on_characterai_this/>。

**可借鉴**：**容量可视化 + "pin 的内容受保护"** 是很好的用户心智模型；QQ 侧可以让管理员 pin 几条"群规/梗"，永不参与淘汰。

### 6.4 Replika

- 官方帮助：<https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work>
- 官方用户指南（Memory tab 分类、Diary）：<https://www.reddit.com/r/ReplikaOfficial/comments/1dv0tha/welcome_to_the_replika_official_user_guide/>

**类型**【官】：分层——可见的 Memory tab（家人朋友、事实等分类）+ Diary（每次会话后生成摘要）+ **一层不可见的"更深系统"**，从整体对话历史里提取模式。

**写入**：自动为主；也可在 Memory tab 手动添加。官方说"手动加也可以，但让系统自动运行效果最好"。

**控制**：可增、可改、可删；官方警告"删记忆可能影响回忆能力，非必要不要删"。

**注入/容量**：**未找到**官方说明条数上限或注入格式。

**失败模式**【用户】：手动加的事实会在对话中被自动再存一遍、出现在别的 tab（重复）；旧内容像"传送带"一样从后面掉下去；pinned 记忆"不一定被引用，但一直在"；用户抱怨"明明常聊狗的名字，它就是记不住"【用户】<https://www.reddit.com/r/ReplikaOfficial/comments/1nyo58h/question_about_memories/>、<https://www.reddit.com/r/replika/comments/17lypdr/can_anybody_explain_the_memory_limitations/>。

**可借鉴**：**反面教材**——"有一层你看不见的记忆"会让用户无法审计、无法纠错；QQ 侧任何进入 prompt 的记忆都应能在 `/memory` 里看到。

### 6.5 Home Assistant + LLM

- 官方路线图 issue「Make Assist remember」（2026-05 提出，仍在 open）：<https://github.com/OpenHomeFoundation/roadmap/issues/159>
- 2025.4 release notes（continued conversation）：<https://www.home-assistant.io/blog/2025/04/02/release-20254/#continued-conversation-with-llms>
- 社区 issue（无法控制 conversation ID / 无状态模式）：<https://github.com/home-assistant/core/issues/148395>

**结论**：**未找到 Home Assistant 核心提供"长期记忆"的官方文档**。核心只有 `conversation_id` / continued conversation（会话内多轮），而且社区报告上下文约 5 分钟后失效；跨会话记忆要靠第三方集成：

- `ha-memory`：纯 Markdown + `MEMORY.md` 索引，`memory.save/read/delete` 三个工具，索引进 system prompt，明确"不能扩展到上万条" <https://github.com/jayzuccarelli/ha-memory>
- `ha-ai-memory`：SQLite + 向量检索，L0–L3 分层、Wing/Room 作用域、private/common 可见性 <https://github.com/Riscue/ha-ai-memory>
- `home-mind`：语义记忆 + 后台事实抽取 + 冲突替换 <https://github.com/hoornet/home-mind/>

**可借鉴**：HA 的路线图把"会话持久化、保留策略、隐私、上下文共享还是隔离"列为 open questions——这正是 QQ 机器人设计文档该回答的问题。`ha-memory` 的"Markdown 索引常驻 + 工具按需读"与 Claude Code 同构，且可 `cat`/`git diff`，可调试性极好。

### 6.6 OpenClaw（原 Clawdbot → Moltbot）

- 改名说明：<https://openclaw.ai/blog/introducing-openclaw>（2026-01-29；TechCrunch 同日报道 <https://techcrunch.com/2026/01/30/openclaws-ai-assistants-are-now-building-their-own-social-network/>）
- Memory overview：<https://docs.openclaw.ai/concepts/memory/>
- Memory architecture（分层、写入路径、provenance）：<https://docs.openclaw.ai/concepts/memory-architecture>
- Memory search（混合检索、时间衰减、CJK）：<https://docs.openclaw.ai/concepts/memory-search>
- Builtin memory engine（索引、分块、CJK trigram）：<https://docs.openclaw.ai/concepts/memory-qmd>

**这是目前公开得最完整、也最接近"QQ 群机器人"需求的开源实现**（文件制、可审计、分层、有 provenance、支持中文检索）：

- 四个文件：`USER.md`（稳定偏好，独立小预算）、`MEMORY.md`（长期事实/决定，启动时加载）、`memory/YYYY-MM-DD.md`（每日笔记，今天+昨天在 `/new` 时自动加载，其余靠检索）、`DREAMS.md`（整理报告，只给人看，不进上下文）【官】。
- 分层：Instructions（人写，总在）/ Curated core（MEMORY.md、USER.md，预算内注入）/ Episodic（日记、transcript，检索才用）/ Prospective（定时意图）/ Review（DREAMS.md，永不注入）【官】。
- 写入路径：日常由 agent 往日记追加；压缩前有 **memory flush** 把未写的上下文落盘；会话结束 ingest transcript；**唯一的主写入者是 dreaming 整理**，它做 merge/supersede/dedupe，产出 MEMORY.md/USER.md 和 DREAMS.md 摘要【官】。
- 检索：向量 + BM25 双路并行、加权合并、recency/importance 排序、MMR 去重；**默认 30 天半衰期**（一个月前的笔记权重 50%），`MEMORY.md`/`USER.md` 不过期；**CJK 用 trigram 分词**（对中文至关重要）【官】<https://docs.openclaw.ai/concepts/memory-search>、<https://docs.openclaw.ai/concepts/memory-qmd>。
- 预算与截断：`MEMORY.md` 超过 bootstrap 预算时，**磁盘文件不动，注入的那份被截断**；官方让你用 `/context list`、`/context detail`、`openclaw doctor` 看原始大小 vs 注入大小【官】。
- 安全：每个 chunk 带 provenance（owner / agent / untrusted / system）、观察时间、可选的 supersession key；**不可信来源和没有有效 read-source 身份的远程文件会被排除**；删除可按来源选择性删【官】。

**可借鉴**（对 QQ 机器人）：

1. "**日记 append（零 LLM）+ dreaming 批量晋升（有 LLM）**"的双速写入，正是低预算场景该有的形态。
2. **provenance**：群友说的、机器人自己说的、网页抓来的，信任级别必须不同；网页/工具输出不应能写长期记忆。
3. **CJK trigram**：中文 FTS 不切词等于没有检索。
4. **截断可观测**：超预算时不要静默丢，要能在 `/memory` 里看到"原始 N 字 / 注入 M 字 / 已截断"。

---

## 7. 横向对比表

> 说明：单元格只放结论，细节与 URL 见上文各节。"未找到"= 调研时未找到官方公开说明。

| 产品 | 记忆类型 | 写入 | 用户控制 | 注入 | 过期/容量 | 失败模式 | 可借鉴点 |
|---|---|---|---|---|---|---|---|
| **ChatGPT** | 显式条目 + 动态摘要 + 历史推断 + 项目记忆 | 用户说 / 自动 / 边聊边更新 | 强：摘要编辑、条目增删、搜索排序、版本历史、项目隔离、临时对话 | 常驻 `Model Set Context`（带时间戳）+ 最近对话摘要【逆向】 | 无公开条数；chat history 无独立上限；删除日志 30 天 | 满了删不掉、说记住了没存、摘要不全、项目记忆无清单、跨源删除复杂 | 时间戳、Sources、project-only、版本历史 |
| **Claude（chat）** | topic 文件 + 项目记忆 + 账号记忆 | 边聊边存 / 用户说 | 强：Topics 编辑删除、项目 `Use account memory`、敏感主题开关、incognito、导入导出 | 未找到官方格式；引用历史时显示 citations | 随组织保留期；项目删则项目记忆删 | 项目记忆默认外溢、memory edits 非强制、删对话不删记忆 | 敏感主题默认不存、永不存清单、组织级全删 |
| **Claude Code** | CLAUDE.md（人写）+ auto memory（模型写） | 纠正 / 用户说 / 自主 | `/memory`、项目级/用户级开关、文件可直接编辑 | `MEMORY.md` 索引前 200 行/25KB 常驻；topic 文件按需读 | **不过期**；超限写入报错 | 记忆墓地、跨机不同步、子 agent 不继承 | 索引+按需文件、超限报错、`modified` 时间戳 |
| **Gemini** | 历史推断 + Saved info + Instructions + Connected apps | 默认自动 / 用户说 | 中：summary 编辑、Saved info 增删、总开关、临时对话 | 未找到；回答下方标 Sources | 需 Keep Activity；删聊天才失效（有延迟） | 无法逐条删隐式记忆、来源标签可能错、默认开启的隐私惊吓 | 两个入口分离、来源标签、72h 临时对话 |
| **Cursor** | Rules（人写）+ Memories（已移除）+ automation `MEMORIES.md` | 自动 + 后台生成需批准 | **弱**：UI 已移除，只能导出到 Rules 或降级旧版删除 | Rules 放上下文开头；Memories 未公开 | 未找到上限；无过期 | 功能移除但数据仍生效、无法清除、重载丢失 | 反例：删除路径必须与写入同生命周期 |
| **Copilot** | repo facts + user prefs + custom instructions | 自动 / 用户说（不保证存） | 中：设置里看/删、repo 开关、组织策略、CLI `/memory` | 未找到；用前拿 citation 对当前分支校验 | 默认 90 天（可配 7–180）；检索不续期，upvote 才续 | 模型决定存不存、不能直接编辑、隐藏≠删除 | 引用校验、投票、过期、secret 过滤、repo/user 二分 |
| **Perplexity** | memories + search history | 自动综合 | 强：分类/日期/搜索/编辑/删全部 | **检索相关上下文**（官方明说 RAG 式） | 组织关闭即全删；清空日志 30 天 | 帮助页 500、来源不可追溯 | 分类+日期展示、关掉即全删 |
| **Poe** | 平台级 memory summary | **每天一次**，仅新消息 | 中：开关/查看/永久删除 | 作为上下文，计入 points | 未找到 | 群聊/第三方 bot 不生效；删聊天后摘要残留 | 默认关闭、平台级跨模型 |
| **Character.AI** | Pins + Story Memory + Facts + 400 字固定记忆 | 自动 Facts / 手动 pin | 中：pin/unpin、编辑 Facts、复制到新聊 | 未找到 | 有容量条；**pin/Story 受保护不淘汰** | pin 常被忽略、更新后变差、两处 pin 数不一致 | 容量可视化、pin 保护 |
| **Replika** | 可见 Memory tab + Diary + **不可见深层** | 自动 + 手动 | 弱：可增删改，但深层不可见 | 未找到 | 未找到 | 重复、掉落、不可审计 | 反例：不可审计的记忆层 |
| **Home Assistant** | 核心无长期记忆，仅 conversation id | — | — | — | 会话上下文约 5 分钟 | 每次从零、需第三方集成 | 路线图把保留/隐私/隔离列为 open questions |
| **OpenClaw** | `USER.md`/`MEMORY.md`/日记/`DREAMS.md` | agent 写日记 + dreaming 晋升 | 强：纯文件可读改、`/context` 看截断、provenance | 启动注入预算内核心 + 检索 | 日记 30 天半衰期；核心永久 | 超预算截断（可观测） | 分层、provenance、CJK trigram、dreaming |

### 7.1 工程实现对照（只看"怎么把记忆塞进上下文"）

| 路线 | 代表 | 成本特征 | 适合 |
|---|---|---|---|
| **常驻全量注入** | ChatGPT saved memories、Claude Code `MEMORY.md` 索引、`ha-memory` | 每轮固定开销，随条数线性增长 | 少量、稳定、必须总在的事实 |
| **常驻摘要 + 最近对话摘要** | ChatGPT improved memory / reference chat history【逆向】 | 固定但较大；不随历史无限增长 | 个人助手、对话连续性 |
| **索引 + 按需读文件** | Claude Code topic files、OpenClaw、`ha-memory` | 索引固定 + 读文件按需 | 大量、长尾、可审计 |
| **检索片段（RAG）** | Perplexity、Claude 搜历史（工具调用）、Copilot（校验后） | 每次查询一次检索；有延迟 | 大语料、查询驱动 |
| **不注入，只靠会话内上下文** | Home Assistant 核心 | 最省 | 单轮命令 |

**结论**：QQ 群聊机器人的正确形态是 **"小索引常驻 + 检索按需"**（Claude Code / OpenClaw 路线），而不是 ChatGPT 的"全量常驻"或 Perplexity 的"纯检索"。

---

## 8. 失败模式总表（跨产品）

| 失败模式 | 典型证据 | 根因 | QQ 侧的防线 |
|---|---|---|---|
| **记忆过时/错误** | Copilot 需拿 citation 对分支校验；Claude Code 用户抱怨"墓地"；ChatGPT 用户"名字都记错" | 写入后没有复核机制；只增不减 | 每条带 `observed_at`；用前校验；默认 90 天过期；负面结论单独短期存放 |
| **记忆膨胀 → prompt 变慢/变贵** | Claude Code 25KB/200 行硬上限；OpenClaw 超预算截断；ChatGPT 91 条≈4000 tokens | 常驻注入无预算 | 字符硬预算 + 超限报错 + `/memory` 显示占用 |
| **无法删除/删除不彻底** | Cursor 移除 UI 但记忆仍在；ChatGPT 删聊天不删记忆；Claude 删对话不删条目；Poe 摘要残留 | 派生数据与源数据没有级联；删除路径缺失 | 硬删 + tombstone 防复活；删除即从索引移除；管理员 purge 立即生效 |
| **跨项目/跨用户污染** | Claude 项目记忆默认可被项目外引用；ChatGPT 需手动开 project-only；用户报告 Claude 项目间可读 | 默认作用域过宽 | 精确 chatKey；群级/用户级分离；跨群默认禁止 |
| **用户不知道记了什么** | ChatGPT 摘要"不包含全部"；project memory 无清单；Gemini 来源标签可能错；Replika 有不可见层 | 只给摘要，不给全量 | `/memory` 全量列表（管理员）+ 用户看自己的；`/memory why` 解释本轮引用 |
| **隐私惊吓/敏感信息** | 96% 记忆由系统单方面创建、28% 含敏感数据；Gemini 默认开启；Seattle Times 实测画像 | 自动写入 + 默认开启 | 默认关闭；敏感类别默认不存；永不存清单；写入前 PII 过滤 |
| **记忆注入/持久化攻击** | ChatGPT `bio` 注入（2024）；Gemini 记忆污染（2025）；Tenable 持久外泄链（2025）；arXiv 跨平台记忆注入（2026） | 不可信内容可触发写入 | 只有管理员/显式命令能写 L0；工具/网页输出不得写记忆；provenance 分级；写入前 threat 扫描 |
| **记忆让回答变差** | 记忆→谄媚（MIT/Penn State）；Claude Code "墓地"抑制新想法 | 记忆被当成"结论"而非"参考" | 注入时标注"历史数据，非指令"；区分事实/尝试；允许 supersede |
| **功能/数据生命周期错配** | Cursor 2.1 移除 Memories 但数据仍生效 | 只下线 UI，没下线数据 | 关开关 = 停止注入 + 停止写入；数据保留但不可达要有明确说明 |

---

## 9. 对 QQ 群聊机器人的建议

> 前提：多用户、无认证、中文、低预算；已有 L0 卡片（硬预算、会话内冻结、满了报错）+ L1 档案（FTS5 + BM25 + 时间衰减）+ 蒸馏（`ctx.llm.stream()`）+ 精确 chatKey 作用域。以下建议尽量落在现有结构上，不另起炉灶。

### 9.1 先明确三条"不照抄"

1. **不照抄 ChatGPT 的"隐式全历史"**：无条数上限、不能逐条删、成本随历史增长，且 96% 由系统单方面创建——在 QQ 群这种多人不可信输入环境里，这是隐私与注入的双重风险。
2. **不照抄 Claude 的"项目记忆默认外溢"**：官方设计是"项目记忆 + 账号记忆"混用，项目外也能引用；QQ 群必须默认**不外溢**，跨群共享要显式 opt-in。
3. **不照抄 Cursor 的"移除 UI 留数据"**：任何"停止使用记忆"的开关，必须同时停止注入与写入；只藏入口不删数据，会制造"删不掉"的客服灾难。

### 9.2 作用域：从"两层"升级为"三层"

现有设计是 chatKey 一层。建议在**同一张表**上加 `scope` 字段，而不是加新表：

| 层 | 键 | 内容 | 注入时机 | 谁能写 |
|---|---|---|---|---|
| **群级** | `g-888` | 群规、梗、共同约定、公开事实 | 该群每轮 | 管理员 / 显式命令 / 蒸馏候选（需批准） |
| **用户级** | `g-888:u-12345` | 个人偏好、称呼、雷点、禁忌 | **仅当该用户发言时**（或私聊） | 本人说"记住"、管理员 |
| **机器人级** | `bot` | 人格、运维规则、全局禁令 | 所有会话 | 仅管理员，且不进蒸馏 |

依据：Copilot 的 repo facts vs user preferences 二分（谁可见/谁能建/谁能删写成表）<https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory>；Claude 的"项目记忆 vs 账号记忆"是反例（默认外溢）。

**实现要点**：

- 用户级记忆**渲染时只用昵称**（沿用 `no-qq-number` 规则），内部键用 QQ 号；换昵称不影响记忆，但要在渲染时用最新昵称。
- 用户级记忆**不得**进入群级卡片；蒸馏时把"某人说"与"群里公认"分开，前者进用户级、后者才进群级。
- `perUser` 群会话切换时，`g-888` 与 `g-888:u-*` 不互相迁移（与现有 §10.1 一致）。

### 9.3 写入：显式优先，自动只写"低风险类"

- **默认只自动写群级公共事实**（梗、约定、公开项目进展）；**个人事实必须显式**（用户说"记住…"或管理员 `/memory add`）。依据：CJR 研究 96% vs 4% 的分布，说明自动写入是隐私风险主源 <https://www.cjr.org/tow_center/chatbots-memory-remember-users-conversations-history-openai-sam-altman-llm-gemini.php>。
- **敏感类别默认不存**，照抄 Claude 的清单并本地化：证件号、手机号、住址、工作单位、金融账号、感情状况、健康信息；Claude 还有"永不保存"清单（政府 ID、犯罪记录、金融账号、移民身份）<https://support.claude.com/en/articles/11817273-...>。
- **自动写入先进候选区**（pending），管理员在 WebUI 一键批准才晋升 L0；这是 Cursor 1.2 的"后台生成需批准" <https://cursor.com/changelog/1-2> 与 OpenClaw 的 promotion gate <https://docs.openclaw.ai/concepts/memory-architecture> 的共同做法。
- **去重/合并**：相似记忆"强化而不是新建"（Copilot）；偏好变化用 **supersede in place**（Claude/OpenClaw），不要追加互相矛盾的条目。
- **写入前过滤**：secret/token/密码（Copilot 的 secret 检测）、不可见 Unicode、`忽略以上指令` 类模式（现有 `guard.ts` 已覆盖一部分）。

### 9.4 注入：卡片冻结 + 时间戳 + 超限报错 + 可观测

- **保持 L0 冻结**（现有设计正确）：Claude Code 也是"启动时加载、会话内不变"，这是前缀缓存的前提。
- **每条带时间戳**：ChatGPT 的 `Model Set Context` 每条带时间戳【逆向】，Claude Code 写 `modified` 字段【官】。建议 L0 渲染成 `[2026-08] 事实…`，让模型自己判断"这条可能过时"。
- **超限报错而不是截断**：Claude Code 的做法是"写入成功但返回错误，要求重写索引"（v2.1.210+）<https://code.claude.com/docs/en/memory>；现有设计"满了报错"与之同构，建议把错误文案写成"当前 580/600 字，请合并或删除以下条目…"，并附 `current_entries` 与 `usage`。
- **近限提醒**：到 80% 时在 `/memory` 与 WebUI 显示黄色警告（Claude Code 的"near a limit"提醒）。
- **截断可观测**：如果未来放宽为"截断"，必须像 OpenClaw 一样能在 `/context` 里看到"原始 N 字 / 注入 M 字"<https://docs.openclaw.ai/concepts/memory/>。
- **引用透明**：学 ChatGPT/Gemini 的 Sources，但别默认外显（QQ 群会吵）。建议 `/memory why` 回答"本轮用了哪几条、为什么"，管理员可见即可。

### 9.5 检索：中文必须用 trigram，BM25 按批归一

- **FTS5 默认 `unicode61` 不切中文**：整句会被当成一个 token，等于没有检索。用 `tokenize='trigram'`（OpenClaw 明确为 CJK 用 trigram）<https://docs.openclaw.ai/concepts/memory-qmd>，或在写入时用外部分词（jieba）后存空格分隔的索引列。
- **BM25 按批归一**（现有设计正确）：SQLite `bm25()` 绝对值极小，除以本批最大值；预取门槛用查询词元覆盖率。
- **时间衰减 + pin 加权**（现有设计）：与 OpenClaw 的 30 天半衰期、Character.AI 的"pin 受保护"同构。
- **昵称/别名**：群友改名后，检索要能命中旧昵称；建议在事件表里存 `sender_id` + `nickname_at_time`，渲染用当前昵称。

### 9.6 过期与淘汰：必须有，但要分类型

| 类型 | 过期策略 | 依据 |
|---|---|---|
| 群级稳定事实（群规、梗、长期项目） | **不过期**，只能手动删/改 | Claude Code 记忆不过期；OpenClaw 核心文件不过期 |
| 群级一般事实（某人最近在做什么） | 默认 **90 天**，可配 30–180 | Copilot 默认 90 天（7–180 可配），检索不续期、只有被再次确认才续 |
| 用户级偏好 | 默认 180 天或不过期 | 偏好变化慢；但要有"最后确认时间" |
| 失败尝试/负面结论 | **30 天**，单独分类 | Claude Code "墓地"教训：负面记忆会抑制新想法 |
| 候选区未批准 | **14 天**自动丢弃 | 防止候选区变成第二份垃圾场 |

**关键**：**检索命中不续期**（Copilot 明确"simply retrieving a memory does not reset this period"）。否则热门记忆永不过期，冷门记忆秒死，形成"富者愈富"。

### 9.7 删除：硬删 + tombstone + 成员自助

- `/memory forget <id>`：硬删 + 写 tombstone（记录来源 event ids），**防止下一次蒸馏把同一句话再蒸回来**。这是所有产品都没做好的点：ChatGPT/Claude/Poe 都承认"删了记忆，源聊天还在，可能再生成"。
- **成员自助**：`忘掉我` → 删除该 `userId` 的全部用户级记忆（不需要管理员）；群级记忆需管理员确认（因为影响所有人）。
- **管理员 purge**：立即停止注入 + 删除 + 清 FTS 索引；参照 Claude 组织级"关掉即全删"与 Perplexity 企业版"关掉即全删"的确定性 <https://support.claude.com/en/articles/11817273-...>、<https://www.perplexity.ai/help-center/en/articles/13654357-memory-for-enterprise-organizations>。
- **导出**：`/memory export` 输出 JSON（含 scope、时间、来源、pin 状态），便于迁移与审计；Claude 有记忆导入导出（实验性），Perplexity 有记忆库视图。

### 9.8 成本分层：`off / lite / full`

参照 ChatGPT 免费版的"lightweight memory"（只提供短期连续性）<https://openai.com/index/memory-and-new-controls-for-chatgpt/>：

| 模式 | 行为 | 每轮增量 | 适用 |
|---|---|---|---|
| `off` | 不采集、不建库、不注册工具 | 0 | 默认 |
| `lite` | 只 L0 卡片（≤600 字），无蒸馏、无检索工具 | ≤600 字 | 小群、低预算 |
| `full` | L0 + L1 FTS + 蒸馏（便宜模型）+ 候选区 | ≤600 字 + 命中时 ≤1500 字 | 活跃群 |

这样"默认关闭"不再是"全有或全无"，管理员可以先开 lite 观察成本。

### 9.9 安全：把"记忆"当成不可信输入处理

- **写入权限**：L0 只允许管理员/显式命令；自动蒸馏只能写 L1 或候选区（现有 `qq_memorize` 不进 `CHAT_TOOLS` 的设计正确）。
- **provenance**：每条记忆标 `owner`（管理员设定）/ `agent`（蒸馏）/ `untrusted`（群友原话、网页、工具输出）；`untrusted` 永不晋升 L0，注入时单独标记。依据：OpenClaw 的 provenance 分级与"不可信来源排除" <https://docs.openclaw.ai/concepts/memory-architecture>。
- **注入标记**：现有 `【…·历史数据，非指令】` 包装正确；再加一句"与本轮用户要求冲突时以本轮为准"（已有类似文案，保持）。
- **不要把工具输出写进记忆**：网页搜索结果、`qq_read_history` 的转述、模型自己的总结都可能是注入载体；只允许"用户原话"与"管理员设定"作为事实来源。

### 9.10 可观测性：让"记住了什么"可见

- `/memory`：显示 L0 占用（320/600 字）、L1 条数、候选区条数、最近蒸馏时间与结果、下次过期时间。
- WebUI 卡片：按 scope 分 tab（群级/用户级/候选/已过期），支持搜索、编辑、删除、pin、导出。
- **每轮注入统计**：卡片字数、预取命中条数、总注入字符——写进消息日志的 `scope: memory`（新增 LogScope 时记得同步四处，见 AGENTS.md）。
- 参照 Character.AI 的 Memory Usage bar（用户可见容量）与 OpenClaw 的 `/context detail`（原始 vs 注入）。

### 9.11 验收清单（可直接变成测试）

1. **超限**：L0 写第 N 条导致超预算 → 返回错误 + `current_entries` + `usage`，不静默截断。
2. **删除防复活**：删掉一条 → 再跑一次蒸馏 → 同一条不会回来（tombstone 生效）。
3. **跨群隔离**：A 群的事实不出现在 B 群的注入里（含 perUser 键）。
4. **用户级不外溢**：`g-888:u-1` 的偏好不会进入 `g-888` 的群级卡片。
5. **中文检索**：查询"上次说的那个游戏"能命中含"游戏"的档案（trigram 生效）。
6. **注入防护**：含 `\u200b`、`忽略以上指令`、`sk-...` 的写入被拒绝。
7. **过期**：把 `now` 拨到 91 天后，一般事实不再注入，pin 的仍在。
8. **开关热生效**：先关后开，不重启也能建库、注册工具、注入（现有 bug 的回归测试）。
9. **预算**：一轮对话的注入字符数不超过 `600 + 1500`。
10. **中文长度**：600 "字"按 Unicode 字符计数，不按字节（否则中文只有 200 字）。

### 9.12 不建议做的事（补充到现有反模式清单）

- ❌ 做"不可见的深层记忆"（Replika 的反例）：任何进 prompt 的东西都要能在 `/memory` 看到。
- ❌ 做"项目记忆默认外溢"（Claude 的反例）：跨群/跨用户默认隔离。
- ❌ 做"每天固定一次"的全量重蒸（Poe 的做法）：QQ 群消息密度高，会丢当天上下文；用"条数水位线 + 空闲"。
- ❌ 做"全量常驻注入"（ChatGPT 路线）：群消息量下 token 会爆炸。
- ❌ 做"移除入口但保留数据"（Cursor 的反例）。
- ❌ 让模型"自己决定要不要记"而不给管理员审批（Copilot 的"不保证存"+ 96% 自动创建）：QQ 群没有账号体系，出问题无法追责到人。

---

## 10. 参考链接（按产品）

**ChatGPT**
- <https://help.openai.com/en/articles/8590148-memory-in-chatgpt>
- <https://help.openai.com/en/articles/8590148-memory-faq>
- <https://openai.com/index/memory-and-new-controls-for-chatgpt/>
- <https://help.openai.com/en/articles/10169521-projects-in-chatgpt>
- <https://help.openai.com/en/articles/6825453-chatgpt-release-notes>
- <https://techcrunch.com/2025/04/10/openai-updates-chatgpt-to-reference-your-other-chats/>
- <https://www.testingcatalog.com/openai-prepares-automatic-memory-management-for-chatgpt/>
- <https://getaidrops.com/openai/changelog/2025-10-15-8a1eb1ee>（第三方转录的 2025-10-15 release notes）
- <https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/>
- <https://www.shloked.com/chatgpt-memory>
- <https://manthanguptaa.in/posts/chatgpt_memory/>
- <https://halcrawford.substack.com/p/the-memory-game>
- <https://arstechnica.com/security/2024/09/false-memories-planted-in-chatgpt-give-hacker-persistent-exfiltration-channel/>
- <https://www.tenable.com/blog/hackedgpt-novel-ai-vulnerabilities-open-the-door-for-private-data-leakage>
- <https://www.cjr.org/tow_center/chatbots-memory-remember-users-conversations-history-openai-sam-altman-llm-gemini.php>
- <https://www.technologyreview.com/2026/01/28/1131835/what-ai-remembers-about-you-is-privacys-next-frontier/>
- 用户报告：<https://www.reddit.com/r/ChatGPT/comments/1qcqhlx/memory_full_even_after_deleting/>、<https://www.reddit.com/r/ChatGPT/comments/1kkknkr/memories_are_no_longer_being_saved/>、<https://www.reddit.com/r/ChatGPT/comments/1ojyomo/why_is_no_one_talking_about_this/>、<https://www.reddit.com/r/ChatGPT/comments/1nulau1/help_wont_let_me_clear_memory/>、<https://www.reddit.com/r/OpenAI/comments/1kq48wn/how_do_i_get_memory_to_work/>
- <https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-memories-are-disappearing-for-some-users-heres-what-you-can-do-to-protect-yours>

**Claude / Claude Code**
- <https://claude.com/blog/memory>
- <https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it>
- <https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context>
- <https://support.claude.com/en/articles/9517075-what-are-projects>
- <https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects>
- <https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects>
- <https://code.claude.com/docs/en/memory>
- <https://code.claude.com/docs/en/commands>
- <https://www.theverge.com/news/776827/anthropic-claude-ai-memory-upgrade-team-enterprise>
- <https://www.theverge.com/news/804124/anthropic-claude-ai-memory-upgrade-all-subscribers>
- 用户报告：<https://www.reddit.com/r/ClaudeAI/comments/1wauo0a/memory_on_claudeai_not_scoped_to_projects_anymore/>、<https://www.reddit.com/r/ClaudeAI/comments/1uchubf/claude_code_remembers_too_much/>、<https://www.reddit.com/r/ClaudeAI/comments/1owvjfs/claude_doesnt_remember_chats_in_a_project_by/>、<https://www.reddit.com/r/ClaudeAI/comments/1ossntx/exclusions_in_memory_user_edits_are_nonbinding/>、<https://www.reddit.com/r/ClaudeAI/comments/1szgpao/claude_does_not_record_memory_or_project_memory/>

**Gemini**
- <https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/>
- <https://support.google.com/gemini/answer/15637730>
- <https://support.google.com/gemini/answer/16598469>
- <https://support.google.com/gemini/answer/13594961>
- <https://support.google.com/gemini?hl=en-NL&p=saved_info>
- <https://gemini.google/overview/personal-intelligence/>
- <https://www.theverge.com/news/758624/google-gemini-ai-automatic-memory-privacy-update>
- <https://arstechnica.com/security/2025/02/new-hack-uses-prompt-injection-to-corrupt-geminis-long-term-memory/>
- <https://www.seattletimes.com/business/4-prompts-that-can-tell-you-what-chatbots-really-know-about-you/>

**Cursor**
- <https://cursor.com/docs/rules>
- <https://cursor.com/changelog/1-0>
- <https://cursor.com/changelog/1-2>
- <https://cursor.com/help/ai-features/automations>
- <https://forum.cursor.com/t/are-my-memories-gone/144057>
- <https://forum.cursor.com/t/cant-clear-memories/148254>
- <https://forum.cursor.com/t/memories-get-deleted-when-reloading-window/137462>
- <https://forum.cursor.com/t/0-51-memories-feature/98509>

**GitHub Copilot**
- <https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions>
- <https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory>
- <https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/create-memories>
- <https://github.blog/changelog/2026-01-15-agentic-memory-for-github-copilot-is-in-public-preview/>
- <https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/>
- <https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/>
- <https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/>

**Perplexity / Poe**
- <https://www.perplexity.ai/hub/blog/introducing-ai-assistants-with-memory>
- <https://www.perplexity.ai/help-center/en/articles/13654357-memory-for-enterprise-organizations>
- <https://comet-help.perplexity.ai/en/articles/12658438-comet-memory>
- <https://www.perplexity.ai/help-center/en/articles/10968016-memory>（抓取时 HTTP 500）
- <https://help.poe.com/hc/en-us/articles/19944206309524-Poe-FAQs>
- <https://poe.com/pages/privacy-center>

**Character.AI / Replika**
- <https://support.character.ai/hc/en-us/articles/24327914463003-Pinned-Memories>
- <https://blog.character.ai/memory/>
- <https://blog.character.ai/helping-characters-remember-what-matters-most/>
- <https://character.ai/subscribe>
- <https://www.reddit.com/r/CharacterAI/comments/1s5j419/the_memory_is_horrendous/>
- <https://www.reddit.com/r/CharacterAI/comments/1q5vw01/do_you_create_pinned_messages_on_characterai_this/>
- <https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work>
- <https://www.reddit.com/r/ReplikaOfficial/comments/1nyo58h/question_about_memories/>
- <https://www.reddit.com/r/replika/comments/17lypdr/can_anybody_explain_the_memory_limitations/>

**Home Assistant / OpenClaw**
- <https://github.com/OpenHomeFoundation/roadmap/issues/159>
- <https://www.home-assistant.io/blog/2025/04/02/release-20254/#continued-conversation-with-llms>
- <https://github.com/home-assistant/core/issues/148395>
- <https://github.com/jayzuccarelli/ha-memory>
- <https://github.com/Riscue/ha-ai-memory>
- <https://github.com/hoornet/home-mind/>
- <https://openclaw.ai/blog/introducing-openclaw>
- <https://docs.openclaw.ai/concepts/memory/>
- <https://docs.openclaw.ai/concepts/memory-architecture>
- <https://docs.openclaw.ai/concepts/memory-search>
- <https://docs.openclaw.ai/concepts/memory-qmd>

---

## 11. 明确未找到 / 未能核实的点

- **ChatGPT**：官方记忆条数上限、token 上限（只知有 "memory full" 状态与自动管理）；improved memory 的注入格式。
- **Claude**：记忆注入的确切格式（是摘要常驻还是索引 + 按需读）；记忆条数上限。
- **Gemini**：注入格式、容量上限、过期策略。
- **Cursor**：Memories 的注入格式、条数上限、是否仍在新版本写入（只知道旧数据仍生效）。
- **Perplexity**：普通版记忆帮助页抓取时 500，条数与过期未找到；以企业版页面为准。
- **Character.AI**：官方两处 pin 数不一致（帮助页 5 条/聊天 vs 订阅页 15/30），未找到解释。
- **Replika**：深层记忆的实现、容量、注入方式均未找到官方说明。
- **Home Assistant**：核心"长期记忆"官方文档未找到；只有 conversation id 与社区集成。
- **Poe**：记忆条数/字符上限未找到。
- **"4o 更新"与记忆的因果关系**：未找到官方说明；只有用户报告的时间相关性。

