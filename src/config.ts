/**
 * 插件配置 —— schemastery schema（dsh Web UI 自动渲染配置面板）。
 *
 * 命名约定：环境变量前缀 DSHQQ_（默认值见 cordis.patch.yml）。
 */
import Schema from '@deepseek-ai/schemastery';
import { TOOL_OPTIONS_META_KEY } from './toolOptions.ts';
import { SEARCH_BACKEND_IDS, type SearchBackendId } from './search/priority.ts';
import { BUSY_STRATEGIES, DEFAULT_BUSY_STRATEGY, DEFAULT_BUSY_WAIT_MS, type BusyStrategy } from './bridge/reclaim.ts';
import { DEFAULT_ASK_WAIT_MS } from './bridge/ask.ts';
import { DEFAULT_STALL_IDLE_MS } from './bridge/stall.ts';

export interface RateLimitConfig {
	/** 限速时间窗口（ms）；max 为 0 时禁用限速 */
	windowMs: number;
	/** 窗口内最大触发次数；0 = 不限速 */
	max: number;
}

/** 网页搜索的后端 id（`searchOrder` 数组的元素；零依赖共用，见 search/priority.ts）。 */
export type { SearchBackendId };
export { SEARCH_BACKEND_IDS };

export interface DshQQConfig {
	// ── 接入与安全 ──────────────────────────────────────────────
	// 连接（卡片「连接」）
	/** forward = 插件作为 WS 客户端连 napcat（正向 WS）；reverse = napcat 连插件（反向 WS，插件监听端口） */
	transport: 'forward' | 'reverse';
	/** 正向 WS 地址，如 ws://127.0.0.1:3001 */
	url: string;
	/** 反向 WS 监听端口（transport=reverse 时生效） */
	reversePort: number;
	/** 反向 WS 监听路径；空 = 接受任意路径 */
	reversePath: string;
	/** OneBot access token；空则不发送/校验 Authorization */
	accessToken: string;
	/** 断线重连初始延迟（ms），指数退避，上限 60s */
	reconnectDelayMs: number;
	/** 下载图片等 HTTP 请求超时（ms） */
	httpTimeoutMs: number;

	// 访问控制（卡片「访问控制」；安全默认：allowlist 模式下列表为空 = 全部拒绝）
	/** 私聊访问模式 */
	privateMode: 'allowlist' | 'open' | 'disabled';
	/** 群聊访问模式 */
	groupMode: 'allowlist' | 'open' | 'disabled';
	/** 私聊白名单（QQ 号） */
	allowedUsers: string[];
	/** 群聊白名单（群号） */
	allowedGroups: string[];
	/** 自动同意好友请求与加群邀请 */
	autoApproveRequests: boolean;

	// 黑名单与管理员（「访问控制」卡片内的「黑名单与管理员」分节）
	/** 用户黑名单（始终拒绝，优先级最高） */
	blockedUsers: string[];
	/** 群黑名单（始终拒绝，优先级最高） */
	blockedGroups: string[];
	/** 管理员 QQ 号（绕过白名单；可用 /op 动态追加） */
	adminUsers: string[];
	/**
	 * @deprecated v0.3 起路径配置统一为 `dataDir` 一项（`<数据目录>/admins.json`）。
	 * 此字段只为老配置的**确定性迁移**保留：有值时 /op 记录仍读它，否则读写
	 * `<dataDir>/admins.json`。设置页已不再显示，请改用 dataDir。
	 */
	adminUsersFile: string;

	// 工具权限（卡片「工具权限」；三层安全的"工具"层）
	/** 启用工具权限分层：普通用户仅能用 userTools，管理员不受限 */
	restrictTools: boolean;
	/** 普通用户（非管理员）可用的工具名单；空 = 纯对话。支持尾部 * 前缀通配 */
	userTools: string[];
	/** 全员禁用的工具名单（含管理员），用于在 QQ 入口整体下线高危能力。支持尾部 * 前缀通配 */
	blockedTools: string[];
	/** 注册 qq_send / qq_send_image / qq_recall 工具 */
	registerSendTools: boolean;

	// 定时任务（未来任务；卡片「工具权限」的定时任务分节 + WebUI「定时任务」任务列表卡片）
	/** 启用定时任务：注册 task_schedule 等工具（重启生效）并启动触发器（热启停） */
	tasksEnabled: boolean;
	/** 单会话可创建的定时任务上限 */
	taskMaxPerChat: number;

	// 网页搜索（网页搜索卡片；qq_web_search 工具按三个顺位依次顺延）
	/** 注册 qq_web_search 工具（重启生效）；顺位、Key、超时都热应用 */
	searchEnabled: boolean;
	/**
	 * 搜索后端的**优先级顺序列表**（有序数组）：`exa`（Exa API）、`tavily`（Tavily API）、
	 * `dsh`（宿主 ctx.web，即内置 web_search 用的后端）。
	 *
	 * 数组顺序 = 尝试顺序：某个后端没配 Key、调用失败或没有结果时顺延到下一个；
	 * **不在数组里的后端不参与**（相当于旧版的 none），空数组 = 网页搜索不可用。
	 * WebUI 用「列表 + 行右侧上下箭头」编辑（见 client 的 orderList 控件）——
	 * 用户先后反馈"一行逗号串太难用""三个下拉还是不够直观"，最终落在可排序列表上。
	 * 配置文件里仍兼容 `web_search` / `dsh_web_search` 等别名（resolveSearchChain）。
	 */
	searchOrder: string[];
	/** Exa API Key（secret；空 = 跳过 exa 这一档） */
	exaApiKey: string;
	/** Exa API 基址；空 = 官方 https://api.exa.ai（自建网关/中转用） */
	exaBaseUrl: string;
	/** Tavily API Key（secret；空 = 跳过 tavily 这一档） */
	tavilyApiKey: string;
	/** Tavily API 基址；空 = 官方 https://api.tavily.com（自建网关/中转用） */
	tavilyBaseUrl: string;
	/** 单次搜索返回的来源条数上限（每个后端都按它请求） */
	searchMaxResults: number;
	/** 一次工具调用允许的查询条数上限（模型给的 queries 数组长度） */
	searchMaxQueries: number;
	/** 单个后端的请求超时（ms）；超时只影响这一档，链继续顺延 */
	searchTimeoutMs: number;

	// ── 对话体验 ────────────────────────────────────────────────
	// 唤醒（卡片「唤醒」）
	/** 私聊是否也需要唤醒前缀（默认不需要） */
	privateNeedsWake: boolean;
	/** 群聊仅在 @机器人 时触发（指令 / 前缀仍可用） */
	groupMentionOnly: boolean;
	/** 群聊唤醒前缀（@ 之外）；私聊开启 privateNeedsWake 后同样生效 */
	wakePrefixes: string[];
	/**
	 * 信息过滤前缀：消息文本以任一条目开头时整条丢弃，任何入口都不触发回复
	 * （含 / 指令、@机器人、私聊与群聊）。空 = 不过滤。
	 */
	messageFilter: string[];

	// 会话与限速（卡片「会话与限速」）
	/** 群聊会话隔离：shared = 每群一个共享会话；perUser = 群内每人独立会话 */
	groupSession: 'shared' | 'perUser';
	/** 限速（按会话） */
	rateLimit: RateLimitConfig;
	/** 单会话排队上限，超出直接提示繁忙 */
	maxQueue: number;
	/**
	 * 无进展中断（ms）：一轮里连续这么久**没有任何会话事件**（模型输出、工具调用）
	 * 就判定卡死并中断本轮；0 = 不监视。
	 * **它不是总时长超时**（那个已删除，见 bridge/stall.ts）：长任务只要有进展就
	 * 不会被打断，只有"一声不吭"才会命中；等用户回答期间不计入。
	 */
	turnIdleTimeoutMs: number;
	/** 会话空闲回收时间（ms），0 = 不回收 */
	sessionIdleTimeoutMs: number;
	/**
	 * 会话被 dsh 界面（WebUI / TUI）占着写句柄时的策略（见 bridge/reclaim.ts）：
	 * fork = 从原会话分叉（默认，完整保留上下文）；wait = 等对方释放，超时再 fork；
	 * rotate = 立即换新会话（丢上下文，用户明确要“重新开始”时用）。
	 */
	busyStrategy: BusyStrategy;
	/** wait 策略的等待上限（ms），超时才走 fork；0 = 不等待直接 fork */
	busyWaitMs: number;
	/** fork 时最多继承的事件条数；超过则回退 wait/rotate，0 = 不限制 */
	forkMaxEvents: number;

	// 回复形态（卡片「回复形态」）
	/** 单条消息字符上限（QQ 约 4500 安全），超出自动切块发送 */
	replyMaxChars: number;
	/** 超长文本是否折叠为合并转发消息（QQ 里的"聊天记录"） */
	foldForward: boolean;
	/** 折叠转发的触发字符数（foldForward 开启且文本超过该值时折叠；0 = 不折叠） */
	foldThreshold: number;
	/** 回复时引用触发消息 */
	replyWithQuote: boolean;
	/** 群聊里被 @ 触发时引用那条 @ 消息（QQ 的引用回复；默认开） */
	replyQuoteOnMention: boolean;
	/** 引用回复反查原文的最大长度（字符） */
	quoteMaxChars: number;
	/** 群聊回复时 @ 触发者 */
	replyWithMention: boolean;

	// 群成员识别（卡片「群成员识别」）
	/** 注入群成员列表 section（解决"分不清谁是谁"） */
	rosterEnabled: boolean;
	/** 群成员列表全量刷新间隔（ms） */
	rosterTtlMs: number;
	/** 群成员列表 section 最多列出的成员数（自己/管理员/活跃者优先） */
	rosterMaxMembers: number;

	// 聊天记录（卡片「聊天记录」）
	/** 启用聊天记录读取：缓冲本会话收到的消息（含没有唤醒机器人的）并注册 qq_read_history 工具（工具注册需重启） */
	historyEnabled: boolean;
	/** 单次读取的最大条数（模型请求的 count 会被夹到该值） */
	historyMaxMessages: number;
	/** 每个会话在内存中保留的聊天记录条数；0 = 不保留本地缓冲（只读远端历史） */
	historyBufferPerChat: number;
	/** 允许通过 OneBot 读取远端历史（get_group_msg_history / get_friend_msg_history），可看到机器人启动之前的消息 */
	historyRemoteFetch: boolean;

	// 提问与回答（卡片「提问与回答」；dsh user-questions 缝的 QQ 侧应答器）
	/**
	 * 把 agent 的提问（`ask_user_question`、计划确认等走 `ctx.userQuestions`
	 * 缝的工具）转发到 QQ，并接受 QQ 回复作为答案（见 bridge/ask.ts / asker.ts）。
	 * 关闭 = 提问只在 dsh 界面里回答，QQ 用户看不到问题（旧行为）。
	 */
	askUserEnabled: boolean;
	/**
	 * 等待回答的上限（ms）：超时后不再等 QQ，把请求让给 dsh 界面的应答器。
	 * 一轮对话没有超时（已删除），所以这就是等待自己的上限。
	 */
	askUserWaitMs: number;

	// 长期记忆 / RAG（卡片「长期记忆」；默认关闭）
	/** 总开关：记录聊天到本地 RAG 库、每轮注入相关历史、注册记忆/技能工具。默认关闭。 */
	memoryEnabled: boolean;
	/** 首次开启时后台安装 runtime（@huggingface/transformers + sqlite-vec）。 */
	memoryRuntimeAutoInstall: boolean;
	/** 启用 embedding（bge-small-zh-v1.5 int8）；关闭则纯 FTS。 */
	memoryEmbeddingEnabled: boolean;
	/** embedding 模型 id（transformers.js 的 ONNX 移植）。 */
	memoryEmbeddingModel: string;
	/** ONNX 精度：int8 / fp16 / fp32。 */
	memoryEmbeddingDtype: string;
	/** HF 直连地址；失败自动切镜像。 */
	memoryHfEndpoint: string;
	/** HF 镜像地址（默认 hf-mirror.com）。 */
	memoryHfMirror: string;
	/** 启用本地 reranker（bge-reranker-base int8）；默认关闭。 */
	memoryRerankEnabled: boolean;
	/** reranker 模型 id。 */
	memoryRerankModel: string;
	/** 重排候选数（从融合 top-N 里取）。 */
	memoryRerankTopN: number;
	/** 重排超时（ms）；超时用融合分。 */
	memoryRerankTimeoutMs: number;
	/** 注册 qq_recall_memory 工具。 */
	memoryRecallEnabled: boolean;
	/** 单次检索返回条数上限。 */
	memoryRecallTopK: number;
	/** 单次检索返回字数上限。 */
	memoryRecallMaxChars: number;
	/** 每轮自动预取相关历史。 */
	memoryPrefetch: boolean;
	/** 自动预取最低分（0~1）。 */
	memoryPrefetchMinScore: number;
	/** 自动预取最多注入几条。 */
	memoryPrefetchMaxItems: number;
	/** 注入块总字数上限。 */
	memoryInjectMaxChars: number;
	/** 时间衰减半衰期（天）。 */
	memoryRecencyHalfLifeDays: number;
	/** 一个 chunk 最多几条消息。 */
	memoryChunkMessages: number;
	/** 一个 chunk 最多多少字。 */
	memoryChunkMaxChars: number;
	/** 相邻 chunk 重叠几条消息。 */
	memoryChunkOverlap: number;
	/** 聊天/ chunk 保留天数。 */
	memoryRetentionDays: number;
	/** 每个会话保留的消息条数上限。 */
	memoryMaxMessagesPerChat: number;
	/** 每个会话保留的 chunk 条数上限。 */
	memoryMaxChunksPerChat: number;
	/** 敏感信息过滤（手机号/证件号/银行卡/住址/凭证）。 */
	memorySensitiveFilter: boolean;
	/** 每轮记录注入明细。 */
	memoryInjectLog: boolean;
	/** 启用自演进技能。 */
	memorySkillEnabled: boolean;
	/** 自动从成功轮次学习技能。 */
	memorySkillAutoLearn: boolean;
	/** 每多少轮尝试学习一次。 */
	memorySkillLearnEveryTurns: number;
	/** 至少几次工具调用才学习。 */
	memorySkillLearnMinToolCalls: number;
	/** 技能学习模型 provider（留空 = 部署默认）。 */
	memorySkillProvider: string;
	/** 技能学习模型 id（留空 = 部署默认）。 */
	memorySkillModel: string;
	/** 每个会话技能条数上限。 */
	memorySkillMaxPerChat: number;
	/** 每轮技能列表最多几条。 */
	memorySkillInjectMaxItems: number;
	/** 每轮技能列表字数上限。 */
	memorySkillInjectMaxChars: number;
	/** 自动生成的技能直接 active（false = draft）。 */
	memorySkillAutoActivate: boolean;
	/** 自动 active 的最低置信度。 */
	memorySkillMinConfidence: number;
	/** 技能正文最大字数。 */
	memorySkillBodyMaxChars: number;
	/** worker 检索超时（ms）。 */
	memoryWorkerSearchTimeoutMs: number;
	/** worker 写入超时（ms）。 */
	memoryWorkerIngestTimeoutMs: number;
	/** embedding 批大小。 */
	memoryEmbedBatch: number;

	// 媒体与互动（卡片「媒体与互动」）
	/** 是否启用收图（下载图片传给 agent） */
	mediaEnabled: boolean;
	/** 单张图片下载上限（MB） */
	mediaMaxMB: number;
	/** 戳一戳（目标为机器人时）的自动回复；空 = 不响应 */
	pokeReply: string;

	// ── 运行与维护 ──────────────────────────────────────────────
	// 消息日志与诊断（卡片「消息日志与诊断」）
	/** 记录 OneBot 收发与 dsh 回复（内存环形缓冲，WebUI「消息日志与诊断」卡片内嵌视图 / /logs 命令查看） */
	messageLog: boolean;
	/** 内存日志条数上限 */
	messageLogMax: number;
	/** 追加落盘 NDJSON 到 <dataDir>/message-log.ndjson（跨重启保留） */
	messageLogToFile: boolean;
	/** 调试日志 */
	debug: boolean;

	// Agent 与工作目录（卡片「Agent 与工作目录」）
	/** 挂载的 Agent 预设 id；空 = 部署默认 */
	preset: string;
	/** 未显式 /cwd 切换时的 agent 工作目录：chat = 会话目录；home = 用户主目录（网关模式） */
	workspaceMode: 'chat' | 'home';
	/**
	 * **唯一的路径设置**：插件数据目录，默认 `<用户主目录>/dsh-qq-bot-data`。
	 * 每个聊天对象一个会话子目录 `<数据目录>/sessions/Friend_<QQ号>|Group_<群号>`，
	 * 它同时是 agent 默认工作目录、dsh 工作区目录（WebUI 左栏分组名即目录名）与
	 * 媒体落盘根（`media/<chatKey>`）；人格库、会话身份表、定时任务、动态管理员、
	 * 群成员缓存与消息日志也都放在这个目录里。dsh 会话的工作目录创建后不可修改，
	 * 所以已存在的会话需 /reset 一次才落到新目录（插件会在 QQ 里提示）。
	 */
	dataDir: string;
	/**
	 * @deprecated v0.3 起与 `dataDir` 合并成**一个**数据目录（会话目录改到
	 * `<数据目录>/sessions/`）。此字段只为老配置的**确定性迁移**保留：`dataDir`
	 * 为空时用它作为数据目录（老部署的根因此不变），写入侧 dataDirMigration 会把
	 * 旧值搬进 `dataDir`。设置页已不再显示，请改用 dataDir。
	 */
	workspaceRoot: string;
	/**
	 * @deprecated v0.2 之前的「会话分组目录根」，v0.3 起同样并入 `dataDir`；
	 * 仅在 `dataDir` 与 `workspaceRoot` 都为空时作为兜底。设置页已不再显示。
	 */
	sessionGroupRoot: string;
}

/**
 * 配置 schema。
 *
 * **根节点标记 `.volatile()`**：dsh ≥ 0.2.1 的 settings 服务只把 volatile 字段
 * 暴露成可编辑表单，并用「整个配置的稳定引用」做热更新（loader 直接更新引用，
 * 不重启插件）。插件在 `index.ts` 里把引用解开成普通对象使用，并监听
 * `loader/volatile-update` 重新合并（见 `volatileConfig.ts`）。
 * 若去掉这个标记，WebUI 的「QQ（napcat）」配置页会整体消失。
 */
export const ConfigSchema = Schema.object({
	// ── 接入与安全 ──
	transport: Schema.union(['forward', 'reverse']).default('forward')
		.description('接入方式：forward=正向WS（插件连 napcat）；reverse=反向WS（napcat 连插件）'),
	url: Schema.string().default('ws://127.0.0.1:3001').description('OneBot 11 正向 WebSocket 地址'),
	reversePort: Schema.number().step(1).min(1).max(65535).default(6199).description('反向 WS 监听端口（transport=reverse 时生效）'),
	reversePath: Schema.string().default('/ws').description('反向 WS 监听路径；留空接受任意路径'),
	accessToken: Schema.string().role('secret').default('').description('OneBot access token；空则不发送 Authorization 头'),
	reconnectDelayMs: Schema.number().step(1).min(500).max(60000).default(3000)
		.description('断线重连初始延迟（ms），指数退避，上限 60s'),
	httpTimeoutMs: Schema.number().step(1).min(1000).max(120000).default(15000).description('下载媒体等 HTTP 请求超时（ms）'),

	privateMode: Schema.union(['allowlist', 'open', 'disabled']).default('allowlist').description('私聊访问模式（allowlist 且列表为空 = 全部拒绝）'),
	groupMode: Schema.union(['allowlist', 'open', 'disabled']).default('allowlist').description('群聊访问模式（allowlist 且列表为空 = 全部拒绝）'),
	allowedUsers: Schema.array(Schema.string()).default([]).description('私聊白名单（QQ 号）'),
	allowedGroups: Schema.array(Schema.string()).default([]).description('群聊白名单（群号）'),
	autoApproveRequests: Schema.boolean().default(false).description('自动同意好友请求与加群邀请'),

	blockedUsers: Schema.array(Schema.string()).default([]).description('用户黑名单（优先级最高）'),
	blockedGroups: Schema.array(Schema.string()).default([]).description('群黑名单（优先级最高）'),
	adminUsers: Schema.array(Schema.string()).default([]).description('管理员 QQ 号（绕过白名单，可用 /op 动态追加）'),
	adminUsersFile: Schema.string().default('').description('[已废弃] 旧「管理员列表持久化文件」：路径已统一为 dataDir，仅在有值时继续沿用；空 = <数据目录>/admins.json'),

	restrictTools: Schema.boolean().default(true).description('工具权限分层：普通用户仅能用 userTools 列出的工具（默认纯对话），管理员全量可用'),
	userTools: Schema.array(Schema.string()).default([]).description('普通用户可用工具白名单，如 ["web_search", "read*"]；空 = 纯对话。支持尾部 * 前缀通配'),
	blockedTools: Schema.array(Schema.string()).default([]).description('全员禁用的工具（含管理员），如 ["shell", "run_code"]；支持尾部 * 前缀通配'),
	registerSendTools: Schema.boolean().default(true).description('注册 qq_send / qq_send_image / qq_recall 工具'),
	tasksEnabled: Schema.boolean().default(true).description('启用定时任务（未来任务）：agent 可用 task_schedule / task_list / task_cancel 工具把"每天9点叫我起床"这类话术落成任务。任务可选「直接推送」（到点渲染模板原样发出，不调模型、零 token）或「agent 执行」（到期唤醒模型）。工具注册需重启 dsh；触发器的启停即时生效'),
	taskMaxPerChat: Schema.number().step(1).min(1).max(100).default(20).description('单个会话最多可创建的定时任务数（防刷）'),

	searchEnabled: Schema.boolean().default(true).description('注册 qq_web_search 工具（网页搜索，需重启 dsh 生效）；搜索后端优先级链、API Key 与超时都是即时生效。该工具默认只对管理员开放，普通用户需在「工具权限」卡片把 qq_web_search 加进 userTools'),
	searchOrder: Schema.array(Schema.string()).default([...SEARCH_BACKEND_IDS]).description('搜索后端的优先级顺序（有序列表，WebUI 里用上下箭头排序）：exa = Exa API，tavily = Tavily API，dsh = 宿主内置 web_search 用的同一个后端。没配 Key、调用失败或没有结果时顺延到下一个；移出列表的后端不参与；留空 = 网页搜索不可用'),
	exaApiKey: Schema.string().role('secret').default('').description('Exa API Key；留空 = 跳过 exa 这一档（不回显，留空保存 = 保持不变）'),
	exaBaseUrl: Schema.string().default('').description('Exa API 基址；留空 = 官方 https://api.exa.ai（自建网关或中转时填这里）'),
	tavilyApiKey: Schema.string().role('secret').default('').description('Tavily API Key（tvly-…）；留空 = 跳过 tavily 这一档（不回显，留空保存 = 保持不变）'),
	tavilyBaseUrl: Schema.string().default('').description('Tavily API 基址；留空 = 官方 https://api.tavily.com（自建网关或中转时填这里）'),
	searchMaxResults: Schema.number().step(1).min(1).max(20).default(8).description('单次搜索返回的来源条数上限（每个后端都按它请求，合并跨查询结果后也按它截断）'),
	searchMaxQueries: Schema.number().step(1).min(1).max(8).default(4).description('一次工具调用允许的查询条数上限（模型 queries 数组的长度）'),
	searchTimeoutMs: Schema.number().step(1).min(1000).max(60000).default(20000).description('单个后端的请求超时（ms）；超时只算这一档失败，链继续顺延到下一个后端'),

	// ── 对话体验 ──
	privateNeedsWake: Schema.boolean().default(false).description('私聊是否需要唤醒前缀'),
	groupMentionOnly: Schema.boolean().default(true).description('群聊仅在 @机器人 时触发（/ 指令与前缀唤醒仍可用）'),
	wakePrefixes: Schema.array(Schema.string()).default([]).description('群聊额外唤醒前缀，如 ["小助手"]；私聊开启「私聊需要唤醒」后同样生效'),
	messageFilter: Schema.array(Schema.string()).default([]).description('信息过滤：消息以这些前缀开头时整条丢弃，不触发任何回复（含 / 指令、@ 与私聊）；如 ["#"] 表示 # 开头的消息一律不回复。空 = 不过滤'),

	groupSession: Schema.union(['shared', 'perUser']).default('shared').description('群聊会话隔离：shared=每群共享；perUser=群内每人独立'),
	rateLimit: Schema.object({
		windowMs: Schema.number().step(1).min(1000).max(3600000).default(60000).description('限速时间窗口（ms）'),
		max: Schema.number().step(1).min(0).max(1000).default(30).description('窗口内最大触发次数；0 = 不限速'),
	}).default({ windowMs: 60000, max: 30 }).description('按会话限速'),
	maxQueue: Schema.number().step(1).min(1).max(200).default(20).description('单会话排队上限'),
	// 一轮对话没有总时长超时（曾有的 maxTurnMs 已按用户要求删除，不要再加回来）：
	// agent 跑到什么时候由它自己决定，只有"连续没有任何事件"才由这个看门狗兜底。
	turnIdleTimeoutMs: Schema.number().step(1).min(0).max(3600000).default(DEFAULT_STALL_IDLE_MS).description('无进展中断（ms）：连续这么久没有任何会话事件（模型输出、工具调用）才判定卡死并中断本轮；长任务只要有进展就不会被打断，0 = 不监视'),
	// 默认 0 = 不回收是刻意的：回收会主动释放写句柄，而 dsh 界面（WebUI）一旦
	// promote 了那个会话就**不会**再释放（宿主没有 release/demote 入口），插件
	// 只能 fork/等（busyStrategy）或换号。永不回收 = 界面只能复用本插件的 agent。
	sessionIdleTimeoutMs: Schema.number().step(1).min(0).max(86400000).default(0).description('会话空闲回收时间（ms）；0 = 不回收（默认，写句柄一直留在插件手里，dsh 界面只能复用同一个 agent，代价是每个聊过天的对象常驻一个 agent）'),
	// 占用策略的默认值是刻意的：fork 保留完整上下文，wait 只损失时延，rotate 会静默丢对话。
	busyStrategy: Schema.union([...BUSY_STRATEGIES]).default(DEFAULT_BUSY_STRATEGY).description('会话被 dsh 界面占用时的策略：fork = 从原会话分叉（默认，完整保留上下文）；wait = 等对方释放，超时再 fork；rotate = 立即换新会话（丢上下文）'),
	busyWaitMs: Schema.number().step(1000).min(0).max(3600000).default(DEFAULT_BUSY_WAIT_MS).description('wait 策略的等待上限（ms）；超时才走 fork，0 = 不等待直接 fork'),
	forkMaxEvents: Schema.number().step(1).min(0).max(100000).default(4000).description('fork 时最多继承的事件条数；超过则回退 wait/rotate，0 = 不限制'),

	replyMaxChars: Schema.number().step(1).min(100).max(5000).default(4500).description('单条消息字符上限，超出自动分块'),
	foldForward: Schema.boolean().default(true).description('超长文本折叠为合并转发消息（QQ 的"聊天记录"）；关闭则一律按单条上限切块发送'),
	foldThreshold: Schema.number().step(1).min(0).max(90000).default(4000).description('超过该字符数且开启折叠时，改为合并转发；0 = 不折叠'),
	replyWithQuote: Schema.boolean().default(false).description('回复时一律引用触发消息（含唤醒前缀/任意消息触发）'),
	replyQuoteOnMention: Schema.boolean().default(true).description('群聊里被 @ 触发时引用那条 @ 消息（QQ 的引用回复，让群里看清在回哪句）；关闭后与普通消息一样只在 replyWithQuote 开启时引用'),
	quoteMaxChars: Schema.number().step(1).min(50).max(2000).default(500).description('引用回复反查原文的最大长度（字符）'),
	replyWithMention: Schema.boolean().default(false).description('群聊回复时 @ 触发者（被 @ 触发且已引用时不再重复 @）'),

	rosterEnabled: Schema.boolean().default(true).description('注入群成员列表 system prompt（每轮动态求值），让 agent 分清群成员身份'),
	rosterTtlMs: Schema.number().step(1).min(60000).max(604800000).default(21600000).description('群成员列表全量刷新间隔（ms），默认 6 小时'),
	rosterMaxMembers: Schema.number().step(1).min(10).max(500).default(60).description('群成员列表 section 最多列出的成员数（自己/管理员/活跃者优先）'),

	historyEnabled: Schema.boolean().default(true).description('聊天记录：让 agent 在群聊里被唤醒时能主动读取"刚才大家在聊什么"（qq_read_history 工具；注册工具需重启 dsh，记录与开关即时生效）'),
	historyMaxMessages: Schema.number().step(1).min(1).max(200).default(50).description('单次读取聊天记录的最大条数（模型请求的条数会被夹到该值）'),
	historyBufferPerChat: Schema.number().step(1).min(0).max(2000).default(200).description('每个会话在内存中保留的聊天记录条数（只保留最近的消息，不落盘）；0 = 不保留本地缓冲，只读远端历史'),
	historyRemoteFetch: Schema.boolean().default(true).description('允许通过 OneBot 历史接口（get_group_msg_history / get_friend_msg_history）读取机器人启动之前的消息；对接端不支持时自动只用本地缓冲'),

	askUserEnabled: Schema.boolean().default(true).description('把 agent 的提问转发到 QQ：ask_user_question（以及计划确认等走同一条缝的工具）需要用户拍板时，把问题与选项发到 QQ，并接受 QQ 回复作为答案（回复序号/选项内容/自由文本，回复「跳过」跳过本题）。关闭后提问只在 dsh 界面里回答，QQ 用户看不到问题'),
	askUserWaitMs: Schema.number().step(1000).min(0).max(3600000).default(DEFAULT_ASK_WAIT_MS).description('等待用户回答的上限（ms）：超时后不再等 QQ（把请求让给 dsh 界面的应答器；两边都没人答时模型会收到一条超时错误）；实际等待不超过单轮上限的一半；填 0 = 用默认值'),

	// ── 长期记忆 / RAG（卡片「长期记忆」）──
	memoryEnabled: Schema.boolean().default(false).description('长期记忆总开关（默认关闭）：把聊天写入本地 RAG 库（<数据目录>/memory.db），每轮注入相关历史，并注册 qq_recall_memory / qq_use_skill / qq_list_skills 工具。首次开启会后台安装运行时并下载 embedding 模型；运行时未就绪时先跑 FTS-only。工具默认仅管理员可用，普通用户要用得在「工具权限」卡片加进 userTools'),
	memoryRuntimeAutoInstall: Schema.boolean().default(true).description('首次开启时后台安装 RAG 运行时（@huggingface/transformers + sqlite-vec 到 <数据目录>/runtime/，不写插件依赖树）'),
	memoryEmbeddingEnabled: Schema.boolean().default(true).description('启用 embedding（bge-small-zh-v1.5 int8）：关闭则只用 FTS5 关键词检索'),
	memoryEmbeddingModel: Schema.string().default('Xenova/bge-small-zh-v1.5').description('embedding 模型 id（transformers.js 的 ONNX 移植；首次启用时下载到 <数据目录>/models/）'),
	memoryEmbeddingDtype: Schema.string().default('int8').description('ONNX 精度：int8（默认，约 24MB）/ fp16 / fp32'),
	memoryHfEndpoint: Schema.string().default('https://huggingface.co').description('HuggingFace 直连地址；下载失败会自动切换到下面的镜像重试'),
	memoryHfMirror: Schema.string().default('https://hf-mirror.com').description('HuggingFace 镜像地址（直连失败时自动使用）'),
	memoryRerankEnabled: Schema.boolean().default(false).description('启用本地 reranker（bge-reranker-base int8）：对融合 top-N 重新打分。默认关闭（首次启用会下载约 280MB 模型，CPU 推理有延迟）'),
	memoryRerankModel: Schema.string().default('Xenova/bge-reranker-base').description('reranker 模型 id'),
	memoryRerankTopN: Schema.number().step(5).min(5).max(100).default(50).description('重排候选数：从融合结果里取前 N 条做 (query, document) 打分'),
	memoryRerankTimeoutMs: Schema.number().step(500).min(500).max(30000).default(5000).description('重排超时（ms）：超时/异常直接用融合分，不影响回复'),
	memoryRecallEnabled: Schema.boolean().default(true).description('注册 qq_recall_memory 检索工具（即时生效；每轮自动预取不受它影响）'),
	memoryRecallTopK: Schema.number().step(1).min(1).max(30).default(8).description('单次检索最多返回多少条历史记录'),
	memoryRecallMaxChars: Schema.number().step(100).min(200).max(6000).default(1500).description('单次检索返回的正文总字数上限（整条取舍，不截断句子）'),
	memoryPrefetch: Schema.boolean().default(true).description('每轮按用户消息自动召回相关历史并注入 user 尾部（本地检索，零 LLM）'),
	memoryPrefetchMinScore: Schema.number().step(0.05).min(0).max(1).default(0.35).description('自动预取的最低分（0~1）：低于该分本轮不注入'),
	memoryPrefetchMaxItems: Schema.number().step(1).min(0).max(10).default(3).description('自动预取最多注入几条历史片段（0 = 关闭注入但仍保留检索工具）'),
	memoryInjectMaxChars: Schema.number().step(100).min(200).max(6000).default(1200).description('注入块总字数上限（整条取舍，不截断句子）'),
	memoryRecencyHalfLifeDays: Schema.number().step(1).min(1).max(365).default(30).description('时间衰减半衰期（天）：越久远的记录权重越低'),
	memoryChunkMessages: Schema.number().step(1).min(1).max(20).default(4).description('一个 chunk 最多几条消息'),
	memoryChunkMaxChars: Schema.number().step(50).min(100).max(2000).default(400).description('一个 chunk 最多多少字；超长消息按此切段'),
	memoryChunkOverlap: Schema.number().step(1).min(0).max(5).default(1).description('相邻 chunk 重叠几条消息，避免问答对被切断'),
	memoryRetentionDays: Schema.number().step(1).min(1).max(3650).default(365).description('聊天/chunk 保留天数，超期自动清理'),
	memoryMaxMessagesPerChat: Schema.number().step(100).min(100).max(500000).default(50000).description('每个会话保留的消息条数上限'),
	memoryMaxChunksPerChat: Schema.number().step(100).min(100).max(200000).default(20000).description('每个会话保留的 chunk 条数上限'),
	memorySensitiveFilter: Schema.boolean().default(true).description('敏感信息过滤：手机号/证件号/银行卡/住址/凭证默认不写入长期记忆'),
	memoryInjectLog: Schema.boolean().default(true).description('每轮记录注入明细（命中 id、分数、字符数），供 WebUI 与 /memory 排查'),
	memorySkillEnabled: Schema.boolean().default(true).description('启用自演进技能：从成功轮次自动总结可复用流程，并在后续对话里检索/加载'),
	memorySkillAutoLearn: Schema.boolean().default(true).description('自动学习技能（关闭后只能手动编辑/导入）'),
	memorySkillLearnEveryTurns: Schema.number().step(1).min(1).max(100).default(6).description('每多少轮尝试学习一次（带工具调用的成功轮次才计入）'),
	memorySkillLearnMinToolCalls: Schema.number().step(1).min(0).max(10).default(1).description('一轮至少几次工具调用才值得总结（0 = 纯聊天也学）'),
	memorySkillProvider: Schema.string().default('').description('技能学习模型 provider（留空 = 部署默认）；WebUI 里由模型下拉与 model 一并写入'),
	memorySkillModel: Schema.string().default('').description('技能学习模型 id（留空 = 部署默认模型）；WebUI 里与「会话模型设置」同一份模型清单的下拉'),
	memorySkillMaxPerChat: Schema.number().step(5).min(5).max(500).default(100).description('每个会话技能条数上限；超出按使用次数/更新时间淘汰到 archived'),
	memorySkillInjectMaxItems: Schema.number().step(1).min(0).max(10).default(3).description('每轮技能列表最多展示几条（0 = 不注入）'),
	memorySkillInjectMaxChars: Schema.number().step(50).min(100).max(2000).default(400).description('每轮技能列表字数上限'),
	memorySkillAutoActivate: Schema.boolean().default(true).description('自动生成的技能直接 active；关闭则先进 draft 等管理员批准'),
	memorySkillMinConfidence: Schema.number().step(0.05).min(0).max(1).default(0.6).description('自动 active 的最低置信度（低于则进 draft）'),
	memorySkillBodyMaxChars: Schema.number().step(100).min(200).max(8000).default(2000).description('技能正文最大字数（防止上下文污染）'),
	memoryWorkerSearchTimeoutMs: Schema.number().step(500).min(500).max(30000).default(5000).description('worker 检索超时（ms）：超时本轮不注入，不影响回复'),
	memoryWorkerIngestTimeoutMs: Schema.number().step(1000).min(1000).max(120000).default(30000).description('worker 写入超时（ms）'),
	memoryEmbedBatch: Schema.number().step(1).min(1).max(64).default(16).description('embedding 批大小（越大越快，内存占用越高）'),

	mediaEnabled: Schema.boolean().default(true).description('启用收图（下载图片并把本地路径交给 agent）'),
	mediaMaxMB: Schema.number().step(1).min(1).max(100).default(20).description('单张图片下载上限（MB）'),
	pokeReply: Schema.string().default('').description('戳一戳自动回复文本；空 = 不响应'),

	// ── 运行与维护 ──
	messageLog: Schema.boolean().default(true).description('启用消息日志：记录 OneBot 收发与 dsh 回复（内存环形缓冲，WebUI「消息日志与诊断」卡片内嵌视图与 /logs 命令查看）'),
	messageLogMax: Schema.number().step(1).min(50).max(10000).default(500).description('内存日志条数上限（超出丢弃最旧条目）'),
	messageLogToFile: Schema.boolean().default(false).description('消息日志追加落盘到 <dataDir>/message-log.ndjson（NDJSON，超 5MB 轮转），重启后保留'),
	debug: Schema.boolean().default(false).description('调试日志'),

	preset: Schema.string().default('').description('Agent 预设 id；空 = 部署默认（web profile 为 standard）'),
	workspaceMode: Schema.union(['chat', 'home']).default('chat')
		.description('会话默认工作目录：chat=每会话隔离工作区（默认，安全）；home=用户主目录（网关模式，管理员可驱动 agent 操作整台电脑，/cwd 可对单个会话切换）'),
	workspaceRoot: Schema.string().default('').description('[已废弃] 旧「会话数据根」：v0.3 起路径统一为 dataDir，仅在 dataDir 为空时作为数据目录兜底，并会被自动搬进 dataDir；请改用 dataDir'),
	sessionGroupRoot: Schema.string().default('').description('[已废弃] 更旧的「会话分组目录根」：已并入 dataDir，仅在 dataDir 与 workspaceRoot 都为空时兜底'),
	dataDir: Schema.string().default('').description('数据目录（**唯一的路径设置**）：会话目录 sessions/Friend_<QQ号>|Group_<群号>（agent 默认工作目录 + WebUI 左栏分组 + 媒体落盘根）、人格库、会话身份表、定时任务、动态管理员、群成员缓存与消息日志都放在这里，支持开头的 ~；空 = <用户主目录>/dsh-qq-bot-data。dsh 会话的工作目录创建后不可修改，所以改过目录后已存在的会话需 /reset 一次（插件会在 QQ 里提示）。'),
}).volatile() as unknown as Schema<DshQQConfig>;

/**
 * 把运行时枚举到的工具名写进 userTools/blockedTools 的 schema meta：
 * settings describe 每次都序列化活 schema，浏览器半据此把这两个字段
 * 渲染成选择框（见 src/client 的 toolList 控件）。写入是幂等的，宿主在
 * 装载完成后与 tools/change 时调用。
 */
export function attachToolOptions(toolNames: readonly string[]): void {
	const options = [...new Set(toolNames)].sort((a, b) => a.localeCompare(b));
	const dict = (ConfigSchema as unknown as { dict?: Record<string, { meta?: Record<string, unknown> } | undefined> }).dict;
	for (const key of ['userTools', 'blockedTools']) {
		const field = dict?.[key];
		if (field !== undefined) field.meta = { ...field.meta, [TOOL_OPTIONS_META_KEY]: options };
	}
}
