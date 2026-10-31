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

	// 长期记忆（卡片「长期记忆」；默认关闭）
	/**
	 * 总开关：注入长期记忆卡片 + 记录会话档案 + 注册 qq_recall_memory / qq_memorize 工具。
	 * **默认关闭**：开启后会按会话持久记录消息正文（有保留期与条数上限），需要显式同意。
	 * **热应用**：打开即创建/打开记忆库并注册工具，关闭即关闭存储并摘除工具（库文件保留），
	 * 采集/卡片/预取/交接/蒸馏同理，都不需要重启 dsh。
	 */
	memoryEnabled: boolean;
	/** 画像段字符预算（稳定层：身份/偏好/规则/置顶；超出时按分数丢弃尾部） */
	memoryCardMaxChars: number;
	/** 画像段独立预算（缺省回落到 memoryCardMaxChars） */
	memoryProfileMaxChars: number;
	/** 每轮情景段预算（检索到的记忆 + 原始消息；缺省 1200） */
	memoryEpisodicMaxChars: number;
	/** 单个会话的活跃记忆条数上限（超出按「非置顶 → 低重要度 → 低置信 → 最久未更新」淘汰） */
	memoryMaxFacts: number;
	/** 每轮 qq_memorize 允许的整理失败次数（超出则提示模型本轮停止整理） */
	memoryMaxWriteFailuresPerTurn: number;
	/** 注册 qq_recall_memory 检索工具（关 = 只保留卡片与自动预取） */
	memoryRecallEnabled: boolean;
	/** 单次召回的条数上限 */
	memoryRecallTopK: number;
	/** 单次召回的正文总字数上限 */
	memoryRecallMaxChars: number;
	/** 检索打分的时间衰减半衰期（天） */
	memoryRecallHalfLifeDays: number;
	/** 每轮按用户消息自动召回并注入相关历史（零 LLM，本地 FTS；与世代交接块二选一） */
	memoryPrefetch: boolean;
	/** 预取注入的最低分（低于则本轮不注入） */
	memoryPrefetchMinScore: number;
	/** 预取最多注入的条数 */
	memoryPrefetchMaxItems: number;
	/** 累计多少条新消息触发一次蒸馏（越大越省 token，时效性越差） */
	memoryDistillEvery: number;
	/** 蒸馏的最小新增字数（与条数阈值满足其一即可） */
	memoryDistillMinChars: number;
	/** 空闲多久后兜底蒸馏（ms；0 = 只在世代结束/手动时蒸馏） */
	memoryDistillIdleMs: number;
	/** 蒸馏用模型 provider（空 = 部署默认模型）；由「长期记忆」卡片的模型下拉与 model 一并写入 */
	memoryDistillProvider: string;
	/** 蒸馏用模型 id（空 = 部署默认模型）；WebUI 里是与「人格与模型」同一份清单的下拉 */
	memoryDistillModel: string;
	/** 蒸馏单次输出 token 上限（首轮尝试；不够时会用「空输出重试预算」再来一次） */
	memoryDistillMaxTokens: number;
	/** 空输出重试预算（token；0 = 不重试）：推理模型把预算烧在思考上时，放大预算再试一次 */
	memoryDistillRetryTokens: number;
	/** 单次蒸馏的超时（ms） */
	memoryDistillTimeoutMs: number;
	/** 世代交接块里附带的最后几条原话 */
	memoryHandoffTail: number;
	/** 世代结束（rotate/reset）时等待蒸馏的上限（ms；超时先用 tail 交接） */
	memoryHandoffDistillWaitMs: number;
	/** 会话档案（正文镜像）保留天数 */
	memoryRetentionDays: number;
	/** 每个会话保留的档案条数上限 */
	memoryMaxEventsPerChat: number;
	/** 敏感类别过滤（手机号/住址/证件号/银行卡/健康/感情等；默认开启） */
	memorySensitiveFilter: boolean;
	/** 跨群/私聊共享用户画像（默认关闭：群友的闲聊不应自动变成跨群画像） */
	memoryCrossGroupUserProfile: boolean;
	/** 个人事实/低置信条目先进候选区（默认开启，管理员批准后才进画像） */
	memoryCandidateReview: boolean;
	/** 一般事实/事件的过期天数（默认 90；画像/偏好/规则不过期） */
	memoryFactTtlDays: number;
	/** 用户偏好的过期天数（默认 180） */
	memoryUserPreferenceTtlDays: number;
	/** 删除后的 tombstone 保留天数（默认 30；防止后台抽取复活已删内容） */
	memoryTombstoneDays: number;
	/** 每轮记录注入明细（id/分数/字符数；默认开启） */
	memoryInjectLog: boolean;

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

	// ── 长期记忆（卡片「长期记忆」）──
	memoryEnabled: Schema.boolean().default(false).description('长期记忆总开关（默认关闭）：跨会话记住人物、群规与长期事项。开启后会按会话持久记录消息正文（<数据目录>/memory.db，含保留期与条数上限），并注册 qq_recall_memory / qq_memorize 工具（随开关即时注册/注销，无需重启）。记忆工具默认仅管理员可用，普通用户要用得在「工具权限」卡片加进 userTools'),
	memoryCardMaxChars: Schema.number().step(50).min(200).max(2000).default(600).description('画像段字符预算：每轮随系统提示注入的稳定记忆上限（身份/偏好/规则/置顶；超出时按分数丢弃尾部，卡片末尾会提示还有多少条可用检索工具查看）'),
	memoryProfileMaxChars: Schema.number().step(50).min(200).max(2000).default(400).description('画像段独立预算（留空/0 时回落到「记忆卡片字符预算」）：只放稳定身份、偏好与规则，建议 300–600 字'),
	memoryEpisodicMaxChars: Schema.number().step(100).min(200).max(4000).default(1200).description('每轮情景段预算：把检索到的相关记忆与原始消息注入到当前 user 消息尾部，不污染 system 前缀缓存'),
	memoryMaxFacts: Schema.number().step(5).min(5).max(1000).default(200).description('单个会话的活跃记忆条数上限（超出按「非置顶 → 低重要度 → 低置信 → 最久未更新」淘汰；旧默认 40 偏小）'),
	memoryMaxWriteFailuresPerTurn: Schema.number().step(1).min(0).max(10).default(3).description('每轮允许的记忆整理失败次数：卡片写满时报错让模型自己合并/删除，连续失败超过该值就提示它本轮停止整理（防止反复重试烧 token）'),
	memoryRecallEnabled: Schema.boolean().default(true).description('注册 qq_recall_memory 检索工具：让 agent 主动查"几周前说过什么"（即时生效；每轮的自动预取不受它影响）'),
	memoryRecallTopK: Schema.number().step(1).min(1).max(30).default(8).description('单次检索最多返回多少条历史记录'),
	memoryRecallMaxChars: Schema.number().step(100).min(200).max(6000).default(1500).description('单次检索返回的正文总字数上限（整条取舍，不截断句子）'),
	memoryRecallHalfLifeDays: Schema.number().step(1).min(1).max(365).default(30).description('检索打分的时间衰减半衰期（天）：越久远的记录权重越低'),
	memoryPrefetch: Schema.boolean().default(true).description('每轮按用户消息自动召回相关历史并注入（本地 FTS 检索、零模型调用；覆盖率与分数不达标就不注入）'),
	memoryPrefetchMinScore: Schema.number().step(0.05).min(0).max(1).default(0.35).description('自动预取的最低分（0~1）：低于该分本轮不注入历史片段'),
	memoryPrefetchMaxItems: Schema.number().step(1).min(0).max(10).default(3).description('自动预取最多注入几条历史消息（0 = 关闭注入但仍保留检索工具）'),
	memoryDistillEvery: Schema.number().step(5).min(5).max(1000).default(10).description('累计多少条新消息触发一次记忆蒸馏（默认 10；旧默认 50 在安静群里可能几天都不触发）'),
	memoryDistillMinChars: Schema.number().step(100).min(200).max(20000).default(800).description('蒸馏的最小新增字数（与条数阈值满足其一即触发；默认 800）'),
	memoryDistillIdleMs: Schema.number().step(60000).min(0).max(86400000).default(600000).description('空闲兜底蒸馏间隔（ms）：距上次成功蒸馏超过该时间且有新消息就补一次（会真正 force，不再被条数/字数阈值挡住）；0 = 只在世代结束或 /memory distill 时蒸馏。热应用：60s 心跳实时读取'),
	memoryDistillProvider: Schema.string().default('').description('蒸馏用模型 provider（留空 = 部署默认模型）；WebUI 里不单独出现：由蒸馏模型下拉与 model 一并写入，手改配置同样生效'),
	memoryDistillModel: Schema.string().default('').description('蒸馏用模型 id（留空 = 部署默认模型）；WebUI 里是与「人格与模型」卡片同一份 dsh 模型清单的下拉，选中后同时写 provider 与本项'),
	memoryDistillMaxTokens: Schema.number().step(1).min(128).max(32768).default(800).description('蒸馏首轮尝试的输出 token 上限（上限 32768）。推理模型会把整个预算烧在思考上、一个可见字都不吐：这种情况插件会沿预算阶梯（4 倍递增，见「空输出重试预算」）自动往上试，并把够用/被吃光的预算记住，之后直接从那一档起步'),
	memoryDistillRetryTokens: Schema.number().step(1).min(0).max(32768).default(16000).description('重试预算的**上限**（token；0 = 不重试）：首轮没有可见文本时，沿预算阶梯按 4 倍递增重试到这一档；哪一档成功就记住哪一档，下一轮直接起步（推理模型不必每轮重走阶梯）。推理模型的思考长度常常超过首轮预算，这里给足（默认 16000）才有可见输出。重试的超时按预算比例放宽（最多首轮的 4 倍、上限 120s）'),
	memoryDistillTimeoutMs: Schema.number().step(1000).min(1000).max(120000).default(15000).description('单次蒸馏的超时（ms）：超时即中止本次蒸馏，水位线不推进，下次重试同一区间；空输出重试会按预算比例放宽这个上限（最多 4 倍、最高 120s）'),
	memoryHandoffTail: Schema.number().step(1).min(0).max(50).default(10).description('世代交接块（换了新会话时注入一次）里附带的最后几条原话；0 = 只给摘要'),
	memoryHandoffDistillWaitMs: Schema.number().step(500).min(0).max(30000).default(8000).description('世代结束（轮换/重置）时等待蒸馏完成的上限（ms）：超时就用现有卡片 + 最后几条原话先交接'),
	memoryRetentionDays: Schema.number().step(1).min(1).max(3650).default(90).description('会话档案（消息正文镜像）保留天数，超期自动清理'),
	memoryMaxEventsPerChat: Schema.number().step(100).min(100).max(200000).default(20000).description('每个会话保留的档案条数上限，超出删最旧的'),
	memorySensitiveFilter: Schema.boolean().default(true).description('敏感类别过滤：手机号/住址/证件号/银行卡/健康/感情等默认不写入长期记忆（群友的隐私不该被自动做成画像）'),
	memoryCrossGroupUserProfile: Schema.boolean().default(false).description('[预留] 跨群/私聊共享用户画像：当前版本尚未实现跨群检索，配置仅保留位；不要依赖它'),
	memoryCandidateReview: Schema.boolean().default(false).description('个人事实/不可信来源先进候选区（pending），管理员在 WebUI 批准后才进画像；默认关闭（自动抽取直接生效），开启后更保守但需要人工批准'),
	memoryFactTtlDays: Schema.number().step(1).min(1).max(3650).default(90).description('一般事实/事件的过期天数（默认 90；画像/偏好/规则不过期；检索命中不续期，只有再次确认才续期）'),
	memoryUserPreferenceTtlDays: Schema.number().step(1).min(1).max(3650).default(180).description('用户偏好的过期天数（默认 180）'),
	memoryTombstoneDays: Schema.number().step(1).min(1).max(3650).default(30).description('删除后的 tombstone 保留天数（默认 30；防止后台抽取把已删内容重新记回来）'),
	memoryInjectLog: Schema.boolean().default(true).description('每轮记录注入明细（注入了哪些记忆 id、分数、字符数、是否截断），供 WebUI 诊断与 /memory 排查'),

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
