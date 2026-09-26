/**
 * 配置页面的表单模型（纯逻辑，不依赖 react，可测）。
 *
 * 对齐 dsh 内置插件卡片的暂存语义：每个分组是一张独立折叠卡片，控件只
 * 暂存用户输入，卡片底部的保存是唯一把暂存变成 settings 文档变更的时机；
 * 字段是否"已覆盖"看 user 层的存在性而非值比较（与默认值相同的覆盖仍是
 * 覆盖）。一次卡内保存把该卡所有暂存合并成一个带 revision fence 的原子
 * mutate；各卡的暂存/保存/失败互相隔离。
 *
 * 注意：secret 字段（accessToken）在 wire 上被宿主剥离，读不到也验不了，
 * 所以它是只写控件：留空 = 不动，显式"清除"手势才 unset。
 */
import type { SettingsDescribeFaceLike, SettingsPathOp, SettingsScope, SnapshotStore } from './types.ts';
import { createSnapshotStore } from './store.ts';
import { readToolOptions } from '../toolOptions.ts';
import { SEARCH_BACKEND_IDS } from '../search/priority.ts';

/** settings 命名空间（= host 侧 installSection 注册名 = settings.section id）。 */
export const SETTINGS_NS = 'dsh-qq-bot';

/** 连接卡片的 id（折叠头部显示"已连接"状态角标，见 components.tsx）。 */
export const CONNECTION_CARD_ID = 'connection';

/** 携带运行时工具选项的两个字段（host 侧 attachToolOptions 写入 schema meta）。 */
const TOOL_LIST_FIELDS = ['userTools', 'blockedTools'] as const;

export type FieldKind =
	| 'string'
	| 'number'
	| 'boolean'
	| 'enum'
	| 'list'
	| 'lineList'
	| 'text'
	| 'secret'
	| 'toolList'
	/**
	 * 顺序列表：值型同 `toolList`（字符串数组），但控件是**可排序列表**——
	 * 每行右侧上移/下移箭头 + 移出按钮，下方是"加入列表"按钮。
	 * 用途：数组顺序本身有语义的短列表（如网页搜索的 `searchOrder`）。
	 */
	| 'orderList'
	/**
	 * 模型下拉：值型是 `provider/model` 规格串（空 = 部署默认模型），选项来自
	 * 宿主 `models/list`（= dsh「设置 → 模型」的同一份运行时清单，与「人格与
	 * 模型」卡片的模型列同源，由组件经 props 注入，不走 schema 元数据）。
	 * **一次选择写两个路径**：`path` 是模型 id，`extraPaths[0]` 是 provider
	 * （见 `planModelWrite`），所以界面上不再需要单独的 provider 输入框。
	 */
	| 'modelSelect';

export interface FieldDef {
	/** 字段态/暂存的稳定键（嵌套字段用点号）。 */
	key: string;
	/** settings 文档写入路径。 */
	path: string[];
	/**
	 * 伴生写入路径（只有 `modelSelect` 用）：控件的一次选择同时写多个配置项。
	 * 约定 `path` = 模型 id（`memoryDistillModel`）、`extraPaths[0]` = provider
	 * （`memoryDistillProvider`）：下拉选中的规格串拆成两段分别写入，暂存仍
	 * 是"一个字段一个值"。
	 */
	extraPaths?: readonly string[][];
	kind: FieldKind;
	/** enum 的可选取值。 */
	options?: readonly string[];
	/**
	 * 卡内子分节标签（locale key）：同一张卡里再按"私聊 / 群聊 / 限速"等
	 * 分块渲染。渲染器只在标签变化处插一次小标题，所以同一张卡里同一个
	 * 标签必须连续出现（不连续会渲染两次）。
	 */
	sub?: string;
}

export interface FieldGroup {
	/** 卡片 id（暂存/保存/失败状态按卡划分）。 */
	id: string;
	/**
	 * 顶层分区标签（locale key）：页面把卡片分成几段，同一分区的卡片必须
	 * 相邻；渲染器在分区变化处插一次分区标题。
	 */
	sectionKey?: string;
	titleKey: string;
	/** 卡片折叠态显示的一句话简介。 */
	descKey: string;
	fields: FieldDef[];
	/**
	 * 该分组的展开体在字段之后追加只读消息日志视图（宿主 RPC 可用时）。
	 * 日志开关与日志查看同卡，不再另起一张卡片。
	 */
	logViewer?: boolean;
	/**
	 * 自定义交互卡片：不走 settings schema，展开体由 RPC 驱动
	 * （人格库 / 人格与模型 / 定时任务）。此类卡片没有 fields，保存栏由面板自持。
	 */
	custom?: 'personas' | 'routes' | 'tasks';
}

function f(key: string, kind: FieldKind, options?: readonly string[]): FieldDef {
	return { key, path: key.split('.'), kind, options };
}

/**
 * 卡内子分节：给一组字段标同一个子分节标签，渲染器在标签变化处插一次小
 * 标题。用于把「私聊 / 群聊」这类同功能域下的差异项放进同一张卡——历史
 * 设计把卡片一半按作用域分（私聊配置 / 群聊配置）、一半按功能域分（工具
 * 权限 / 回复形态 / 会话与限速），于是同一个功能被劈到两张卡里，这是配置
 * 页混乱的根因。现在统一按功能域分卡，作用域差异降级为卡内子分节。
 */
function withSub(subKey: string, defs: readonly FieldDef[]): FieldDef[] {
	return defs.map((def) => ({ ...def, sub: subKey }));
}

/**
 * 全部配置项：一张卡 = 一个功能域，页面再按 sectionKey 分成
 * 「接入与安全 / 对话体验 / 运行与维护」三段。每个字段只归一张卡：
 * 保存与放弃以卡片为单位，字段重复会让写入归属含混。
 */
export const FIELD_GROUPS: FieldGroup[] = [
	// ── 接入与安全 ──
	{
		id: CONNECTION_CARD_ID,
		sectionKey: 'sectionAccess',
		titleKey: 'groupConnection',
		descKey: 'groupConnectionDesc',
		fields: [
			f('transport', 'enum', ['forward', 'reverse']),
			f('url', 'string'),
			f('reversePort', 'number'),
			f('reversePath', 'string'),
			f('accessToken', 'secret'),
			f('reconnectDelayMs', 'number'),
			f('httpTimeoutMs', 'number'),
		],
	},
	{
		// 准入与名单同卡：私聊/群聊是一个功能域的两个作用域（卡内分区），
		// 黑白名单与管理员又是同一套判定的输入（拒绝 > 管理员 > 模式，见
		// pipeline/access），所以「访问控制」一张卡装完，不再另起
		// 「黑名单与管理员」卡——同一问题分两处找是配置页混乱的根因。
		// 卡内顺序：准入门（私聊/群聊）→ 名单（拒绝优先，管理员其次）→ 请求策略。
		id: 'access',
		sectionKey: 'sectionAccess',
		titleKey: 'groupAccess',
		descKey: 'groupAccessDesc',
		fields: [
			...withSub('subPrivate', [
				f('privateMode', 'enum', ['allowlist', 'open', 'disabled']),
				f('allowedUsers', 'list'),
			]),
			...withSub('subGroup', [
				f('groupMode', 'enum', ['allowlist', 'open', 'disabled']),
				f('allowedGroups', 'list'),
			]),
			...withSub('subBlockedAdmins', [
				f('blockedUsers', 'list'),
				f('blockedGroups', 'list'),
				f('adminUsers', 'list'),
			]),
			...withSub('subRequests', [f('autoApproveRequests', 'boolean')]),
		],
	},
		{
			// 工具权限属于三层安全里的"工具"层，所以与入口控制同段；
			// quoteMaxChars（引用反查）已移回「回复形态」。
			id: 'tools',
			sectionKey: 'sectionAccess',
			titleKey: 'groupTools',
			descKey: 'groupToolsDesc',
			fields: [
				...withSub('subTiers', [
					f('restrictTools', 'boolean'),
					f('userTools', 'toolList'),
					f('blockedTools', 'toolList'),
				]),
				...withSub('subSendTools', [f('registerSendTools', 'boolean')]),
				...withSub('subTasks', [
					f('tasksEnabled', 'boolean'),
					f('taskMaxPerChat', 'number'),
				]),
			],
		},

		{
			// 网页搜索与工具权限同段：它同样是"给 agent 开一个能力"的配置，
			// 而且它的默认放行策略就挂在工具权限那张卡上（userTools）。
			// 顺序用**可排序列表**（行右侧上下箭头）而不是一行逗号串、也不是
			// 三个下拉：顺序在列表里一眼可见，调整只需点箭头，移出列表 = 不参与。
			// 卡内顺序：开关与顺位 → 各后端的 Key → 可选端点 → 参数。
			id: 'search',
			sectionKey: 'sectionAccess',
			titleKey: 'groupSearch',
			descKey: 'groupSearchDesc',
			fields: [
				...withSub('subSearchChain', [
					f('searchEnabled', 'boolean'),
					f('searchOrder', 'orderList', SEARCH_BACKEND_IDS),
				]),
				...withSub('subSearchKeys', [
					f('exaApiKey', 'secret'),
					f('tavilyApiKey', 'secret'),
				]),
				...withSub('subSearchEndpoint', [
					f('exaBaseUrl', 'string'),
					f('tavilyBaseUrl', 'string'),
				]),
				...withSub('subSearchLimits', [
					f('searchMaxResults', 'number'),
					f('searchMaxQueries', 'number'),
					f('searchTimeoutMs', 'number'),
				]),
			],
		},

	// ── 对话体验 ──
	{
		id: 'wake',
		sectionKey: 'sectionChat',
		titleKey: 'groupWake',
		descKey: 'groupWakeDesc',
		fields: [
			...withSub('subPrivate', [f('privateNeedsWake', 'boolean')]),
			...withSub('subGroup', [
				f('groupMentionOnly', 'boolean'),
				f('wakePrefixes', 'lineList'),
			]),
			// 信息过滤同属"机器人何时回应"这个功能域：与唤醒前缀一样是前缀匹配，
			// 但方向相反（命中即丢弃），所以放在同一张卡里相邻。
			...withSub('subFilter', [f('messageFilter', 'lineList')]),
		],
	},
	{
		id: 'session',
		sectionKey: 'sectionChat',
		titleKey: 'groupSessionLimits',
		descKey: 'groupSessionLimitsDesc',
		fields: [
			...withSub('subSessionScope', [f('groupSession', 'enum', ['shared', 'perUser'])]),
			...withSub('subRateLimit', [
				f('rateLimit.windowMs', 'number'),
				f('rateLimit.max', 'number'),
			]),
			...withSub('subRuntime', [
				f('maxQueue', 'number'),
				f('maxTurnMs', 'number'),
				f('sessionIdleTimeoutMs', 'number'),
			]),
			// 「占用与接管」单独一节的理由：这三个值是一组决策——
			// sessionIdleTimeoutMs=0 让插件永不释放写句柄（界面只能复用），
			// busyStrategy/busyWaitMs 决定真的被界面抢先占用时等还是换。
			...withSub('subBusy', [
				f('busyStrategy', 'enum', ['wait', 'rotate']),
				f('busyWaitMs', 'number'),
			]),
		],
	},
	{
		id: 'reply',
		sectionKey: 'sectionChat',
		titleKey: 'groupReply',
		descKey: 'groupReplyDesc',
		fields: [
			...withSub('subShape', [
				f('replyMaxChars', 'number'),
				f('foldForward', 'boolean'),
				f('foldThreshold', 'number'),
			]),
			...withSub('subQuote', [
				f('replyQuoteOnMention', 'boolean'),
				f('replyWithQuote', 'boolean'),
				f('quoteMaxChars', 'number'),
			]),
			...withSub('subMention', [f('replyWithMention', 'boolean')]),
		],
	},
	{
		// 群成员名单从「群聊配置」杂项里独立出来：它是一个自洽的功能域。
		id: 'roster',
		sectionKey: 'sectionChat',
		titleKey: 'groupRoster',
		descKey: 'groupRosterDesc',
		fields: [
			f('rosterEnabled', 'boolean'),
			f('rosterTtlMs', 'number'),
			f('rosterMaxMembers', 'number'),
		],
	},
	{
		// 聊天记录：agent 主动读取"刚才大家在聊什么"（qq_read_history 工具 +
		// 未被唤醒消息的本地缓冲）。与群成员识别相邻——都是"给 agent 上下文"。
		id: 'history',
		sectionKey: 'sectionChat',
		titleKey: 'groupHistory',
		descKey: 'groupHistoryDesc',
		fields: [
			...withSub('subHistoryRead', [
				f('historyEnabled', 'boolean'),
				f('historyMaxMessages', 'number'),
			]),
			...withSub('subHistorySource', [
				f('historyBufferPerChat', 'number'),
				f('historyRemoteFetch', 'boolean'),
			]),
		],
	},
	{
		// 提问与回答：agent 需要用户拍板时（ask_user_question / 计划确认）把问题
		// 发到 QQ 并接受 QQ 回复作为答案。与「聊天记录」相邻——都是"agent 与用户
		// 之间的上下文往返"，只是方向相反。
		id: 'ask',
		sectionKey: 'sectionChat',
		titleKey: 'groupAsk',
		descKey: 'groupAskDesc',
		fields: [f('askUserEnabled', 'boolean'), f('askUserWaitMs', 'number')],
	},
	{
		// 长期记忆：跨会话记住人物、群规与长期事项（卡片 + 会话档案检索 + 蒸馏）。
		// 默认关闭；开启后会按会话持久记录消息正文（<数据目录>/memory.db）。
		// 记忆工具（qq_recall_memory / qq_memorize）不在 CHAT_TOOLS 里，默认仅管理员可用，
		// 普通用户要用得在「工具权限」卡片加进 userTools。
		id: 'memory',
		sectionKey: 'sectionChat',
		titleKey: 'groupMemory',
		descKey: 'groupMemoryDesc',
		fields: [
			...withSub('subMemoryBasic', [
				f('memoryEnabled', 'boolean'),
				f('memoryCardMaxChars', 'number'),
				f('memoryMaxFacts', 'number'),
				f('memoryMaxWriteFailuresPerTurn', 'number'),
			]),
			...withSub('subMemoryRecall', [
				f('memoryRecallEnabled', 'boolean'),
				f('memoryRecallTopK', 'number'),
				f('memoryRecallMaxChars', 'number'),
				f('memoryRecallHalfLifeDays', 'number'),
			]),
			...withSub('subMemoryPrefetch', [
				f('memoryPrefetch', 'boolean'),
				f('memoryPrefetchMinScore', 'number'),
				f('memoryPrefetchMaxItems', 'number'),
			]),
			...withSub('subMemoryDistill', [
				f('memoryDistillEvery', 'number'),
				f('memoryDistillMinChars', 'number'),
				f('memoryDistillIdleMs', 'number'),
				// 蒸馏模型：与「人格与模型」卡片的模型列**同一份下拉清单**（宿主
				// models/list），选中的 `provider/model` 一次写两个配置项，所以
				// memoryDistillProvider 不再单独占一行（schema 字段保留：手改
				// 配置与老配置照旧生效，见 config.ts）。
				{ ...f('memoryDistillModel', 'modelSelect'), extraPaths: [['memoryDistillProvider']] },
				f('memoryDistillMaxTokens', 'number'),
				f('memoryDistillTimeoutMs', 'number'),
			]),
			...withSub('subMemoryLifecycle', [
				f('memoryHandoffTail', 'number'),
				f('memoryHandoffDistillWaitMs', 'number'),
				f('memoryRetentionDays', 'number'),
				f('memoryMaxEventsPerChat', 'number'),
			]),
		],
	},
	{
		id: 'media',
		sectionKey: 'sectionChat',
		titleKey: 'groupMedia',
		descKey: 'groupMediaDesc',
		fields: [
			...withSub('subImages', [
				f('mediaEnabled', 'boolean'),
				f('mediaMaxMB', 'number'),
			]),
			...withSub('subInteraction', [f('pokeReply', 'string')]),
		],
	},
	{
		// 定时任务列表（RPC 驱动）：任务本身在会话里由 agent 创建/管理，
		// 这里是全局的总览与手动管理入口。
		id: 'tasks',
		sectionKey: 'sectionChat',
		titleKey: 'groupTasks',
		descKey: 'groupTasksDesc',
		custom: 'tasks',
		fields: [],
	},
	{
		id: 'personas',
		sectionKey: 'sectionChat',
		titleKey: 'groupPersonas',
		descKey: 'groupPersonasDesc',
		custom: 'personas',
		fields: [],
	},
	{
		id: 'routes',
		sectionKey: 'sectionChat',
		titleKey: 'groupRoutes',
		descKey: 'groupRoutesDesc',
		custom: 'routes',
		fields: [],
	},

	// ── 运行与维护 ──
	{
		// 日志开关、日志视图与调试开关同卡：都是"出问题时看这里"。
		id: 'logging',
		sectionKey: 'sectionRuntime',
		titleKey: 'groupLogging',
		descKey: 'groupLoggingDesc',
		logViewer: true,
		fields: [
			...withSub('subLogRecord', [
				f('messageLog', 'boolean'),
				f('messageLogMax', 'number'),
				f('messageLogToFile', 'boolean'),
			]),
			...withSub('subDiagnostics', [f('debug', 'boolean')]),
		],
	},
	{
		// workspaceMode 此前只在 schema 里、没有任何渲染入口（界面上改不了，
		// 只能手改配置文件）；这里补回。路径设置只有**一个**（dataDir）：会话目录
		// （<数据目录>/sessions/Friend_|Group_）与人格库/身份表/任务/日志都在它下面，
		// 所以与工作目录模式同分节。
		id: 'agent',
		sectionKey: 'sectionRuntime',
		titleKey: 'groupAgent',
		descKey: 'groupAgentDesc',
		fields: [
			...withSub('subPreset', [f('preset', 'string')]),
			...withSub('subTime', [f('timeAware', 'boolean')]),
			...withSub('subWorkspace', [
				f('workspaceMode', 'enum', ['chat', 'home']),
				f('dataDir', 'string'),
			]),
		],
	},
];

const FIELDS_BY_KEY = new Map(FIELD_GROUPS.flatMap((group) => group.fields).map((def) => [def.key, def]));
/** 字段 → 所属卡片 id。 */
const GROUP_OF_FIELD = new Map(FIELD_GROUPS.flatMap((group) => group.fields.map((def) => [def.key, group.id])));

/** 单个控件渲染所需状态。 */
export interface FieldState {
	kind: FieldKind;
	/** 文本类控件的显示文本（secret 恒空串）。 */
	text: string;
	/** boolean 控件的开关态。 */
	checked: boolean;
	options?: readonly string[];
	/** toolList 控件的草稿条目（未暂存 = 当前生效值）。 */
	values?: readonly string[];
	/** 保存后 user 层是否会留下覆盖。 */
	overridden: boolean;
	/** 草稿无法解析（阻止保存）。 */
	invalid: boolean;
	/** secret 的"清除已存 Token"手势已暂存。 */
	clearStaged: boolean;
}

/** 一张卡片的 shell 状态（对齐内置 PluginCard 的 state）。 */
export interface CardShell {
	dirty: boolean;
	invalid: boolean;
	saving: boolean;
	failed: boolean;
	/** 刚保存成功（渲染一次"已保存"回执；再次编辑或放弃即清除）。 */
	saved: boolean;
}

/** 页面整体状态。 */
export interface CardState {
	available: boolean;
	writable: boolean;
	/** 每张卡片的 shell（key = FIELD_GROUPS[].id）。 */
	cards: Record<string, CardShell>;
	fields: Record<string, FieldState>;
}

type Staged = { text: string; value?: unknown; clear: boolean };

interface SavePlan {
	ops: SettingsPathOp[];
	dirty: boolean;
	invalid: boolean;
	/** 写入后按 user 层验证是否落盘（secret 无法验证，跳过）。 */
	verify: Array<(user: unknown) => boolean>;
}

export function getPath(obj: unknown, path: string[]): unknown {
	let current: unknown = obj;
	for (const segment of path) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

export function hasPath(obj: unknown, path: string[]): boolean {
	const parent = getPath(obj, path.slice(0, -1));
	if (parent === null || typeof parent !== 'object') return false;
	return Object.hasOwn(parent as Record<string, unknown>, path[path.length - 1]!);
}

/**
 * 模型下拉（`modelSelect`）的值型：`provider/model` 规格串（与「人格与模型」
 * 卡片的模型列、宿主 `models/list` 的 `spec` 一致）。两条纯函数是它的全部
 * 解析规则——provider 永远不含斜杠，而模型 id 可能含（如 openrouter 的
 * `anthropic/claude-…`），所以只按**第一个**斜杠切分。
 */
export function splitModelSpec(spec: string): { provider: string; model: string } {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf('/');
	if (slash <= 0 || slash === trimmed.length - 1) return { provider: '', model: '' };
	return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** 两段 → 规格串；任一段为空都算"未指定模型"，返回空串（= 部署默认）。 */
export function joinModelSpec(provider: string, model: string): string {
	return provider !== '' && model !== '' ? `${provider}/${model}` : '';
}

/** 把 section 值格式化成控件显示文本。 */
export function formatField(def: FieldDef, value: unknown): string {
	if (def.kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
	if (def.kind === 'boolean') return '';
	if (def.kind === 'list') return Array.isArray(value) ? value.map(String).join('\n') : '';
	// lineList 与 list 同值型（字符串数组），只是控件是单行输入。
	if (def.kind === 'lineList') return Array.isArray(value) ? value.map(String).join('\n') : '';
	if (def.kind === 'secret') return '';
	// toolList / orderList 无文本形态；仅在控件回退为文本框时用于显示当前条目。
	if (def.kind === 'toolList' || def.kind === 'orderList') return Array.isArray(value) ? value.map(String).join('\n') : '';
	// modelSelect 的单值是模型 id（不是规格串）：控件真值由 modelSpec() 从
	// 模型与 provider **两个**路径合成，这里只兜底单值场景。
	if (def.kind === 'modelSelect') return typeof value === 'string' ? value : '';
	return typeof value === 'string' ? value : '';
}

/** 把草稿文本解析成写入操作；返回 undefined = 无法解析（invalid）。 */
export function parseField(def: FieldDef, text: string): { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined {
	// orderList 没有文本形态：草稿是数组，写入/清空由 plan() 与 fieldState() 直接处理。
	if (def.kind === 'orderList') return undefined;
	if (def.kind === 'number') {
		const trimmed = text.trim();
		if (trimmed === '') return { kind: 'clear' };
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
	}
	if (def.kind === 'list') {
		if (text.trim() === '') return { kind: 'clear' };
		return { kind: 'set', value: text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') };
	}
	if (def.kind === 'lineList') {
		if (text.trim() === '') return { kind: 'clear' };
		// 单行输入：换行（粘贴多行时）与逗号都算分隔符，半角/全角逗号都认；
		// 单个 "#" 这类前缀不含逗号，所以常见写法（"# , //"）能与值本身区分开。
		return {
			kind: 'set',
			value: text
				.split(/[\r\n,，]/)
				.map((entry) => entry.trim())
				.filter((entry) => entry !== ''),
		};
	}
	if (def.kind === 'enum') {
		return def.options?.includes(text) === true ? { kind: 'set', value: text } : undefined;
	}
	const trimmed = text.trim();
	return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
}

/** 暂存式表单：桥接 settings scope 与各卡片的暂存/保存。 */
export class DshQQCardController {
	private readonly staged = new Map<string, Staged>();
	private readonly savingCards = new Set<string>();
	private readonly failedCards = new Set<string>();
	/** 刚保存成功的卡片（保存回执，见 CardShell.saved）。 */
	private readonly savedCards = new Set<string>();
	private readonly store: SnapshotStore<CardState>;

	constructor(
		private readonly scope: SettingsScope<Record<string, unknown>>,
		/** 跨命名空间 describe 镜像：读取宿主注入的工具选项（旧宿主缺省）。 */
		private readonly describe?: SettingsDescribeFaceLike,
	) {
		this.store = createSnapshotStore(this.projection());
		scope.subscribe(() => this.publish());
		if (describe !== undefined) {
			void describe.ensure().catch(() => {});
			describe.subscribe(() => this.publish());
		}
	}

	/** 渲染器注入面：快照选择器 hook（useDshQQCard）+ 表单动作（save/discard 按卡）。 */
	inject(): Record<string, unknown> {
		return {
			hooks: { dshQQCard: this.store },
			edit: (key: string, text: string) => {
				this.stage(key, { text, clear: false });
			},
			stageValue: (key: string, value: unknown) => {
				this.stage(key, { text: String(value), value, clear: false });
			},
			stageList: (key: string, items: readonly string[]) => {
				this.stage(key, { text: '', value: [...items], clear: false });
			},
			stageClear: (key: string) => {
				this.stage(key, { text: '', clear: true });
			},
			resetField: (key: string) => {
				const def = this.def(key);
				// modelSelect 的"当前值"是 provider + model 合成的规格串（见 modelSpec）；
				// 其余字段单值直接格式化。
				const baseText = def.kind === 'modelSelect' ? this.modelSpec(def, 'base') : formatField(def, getPath(this.snapshot().base, def.path));
				this.stage(key, { text: baseText, clear: true });
			},
			save: (cardId: string) => {
				void this.save(cardId);
			},
			discard: (cardId: string) => {
				this.discard(cardId);
			},
		};
	}

	private def(key: string): FieldDef {
		const def = FIELDS_BY_KEY.get(key);
		if (def === undefined) throw new Error(`dsh-qq-bot page has no field ${key}`);
		return def;
	}

	private snapshot() {
		return this.scope.getSnapshot();
	}

	private stage(key: string, staged: Staged): void {
		this.staged.set(key, staged);
		const cardId = GROUP_OF_FIELD.get(key);
		if (cardId !== undefined) {
			this.failedCards.delete(cardId);
			// 编辑即撤销上一次的"已保存"回执（避免旧回执与新草稿同时出现）。
			this.savedCards.delete(cardId);
		}
		this.publish();
	}

	private sectionValue(def: FieldDef): unknown {
		return getPath(this.snapshot().value, def.path);
	}

	private overridden(key: string): boolean {
		const def = this.def(key);
		if (hasPath(this.snapshot().user, def.path)) return true;
		// modelSelect 的两个路径都算覆盖（provider 由同一次选择写入）。
		const providerPath = def.extraPaths?.[0];
		return providerPath !== undefined && hasPath(this.snapshot().user, providerPath);
	}

	/** 某一层（value / base）里的 provider/model 原样两段。 */
	private modelPair(def: FieldDef, layer: 'value' | 'base'): { provider: string; model: string } {
		const root = this.snapshot()[layer];
		const model = getPath(root, def.path);
		const providerPath = def.extraPaths?.[0];
		const provider = providerPath === undefined ? undefined : getPath(root, providerPath);
		return {
			provider: typeof provider === 'string' ? provider.trim() : '',
			model: typeof model === 'string' ? model.trim() : '',
		};
	}

	/** 某一层里的规格串（任一段为空 = 未指定，返回空串 = 部署默认模型）。 */
	private modelSpec(def: FieldDef, layer: 'value' | 'base'): string {
		const pair = this.modelPair(def, layer);
		return joinModelSpec(pair.provider, pair.model);
	}

	/**
	 * 模型下拉的写入计划：目标规格串拆成 provider / model 两段，各自与**当前
	 * 生效值**逐段比较后写入（相同不动，目标为空 = 退回组合层）。暂存的是整个
	 * 规格串，所以这里也是唯一把一次选择展开成多个 settings 路径的地方。
	 */
	private planModelWrite(def: FieldDef, spec: string, ops: SettingsPathOp[], verify: Array<(user: unknown) => boolean>): void {
		const current = this.modelPair(def, 'value');
		const target = splitModelSpec(spec);
		if (target.provider === current.provider && target.model === current.model) return;
		// 规格串相同但分段不同（手改配置里 provider 自身含 `/`）：按当前分段处理，
		// 避免"重选当前项"把配置改写成另一种拆法。
		if (spec !== '' && spec === joinModelSpec(current.provider, current.model)) return;
		const value = this.snapshot().value;
		const user = this.snapshot().user;
		const writes: Array<[string[], string]> = [[def.path, target.model]];
		const providerPath = def.extraPaths?.[0];
		if (providerPath !== undefined) writes.push([providerPath, target.provider]);
		for (const [path, next] of writes) {
			if (next === '') {
				// 未指定 = 回到组合层；本来就没有覆盖时不产生写入。
				if (!hasPath(user, path)) continue;
				ops.push({ op: 'unset', path });
				verify.push((layer) => !hasPath(layer, path));
				continue;
			}
			if (getPath(value, path) === next) continue;
			ops.push({ op: 'set', path, value: next });
			verify.push((layer) => getPath(layer, path) === next);
		}
	}

	/** 把（某张卡内的）暂存解析成一次原子写入的计划。 */
	private plan(cardId?: string): SavePlan {
		const ops: SettingsPathOp[] = [];
		const verify: Array<(user: unknown) => boolean> = [];
		let invalid = false;
		for (const [key, staged] of this.staged) {
			if (cardId !== undefined && GROUP_OF_FIELD.get(key) !== cardId) continue;
			const def = this.def(key);
			const current = this.sectionValue(def);
			// modelSelect 必须在通用 clear 分支之前：一次选择要写两个路径，
			// resetField 的恢复手势也要把两个路径一起退回组合层。
			if (def.kind === 'modelSelect') {
				const spec = staged.clear ? '' : typeof staged.value === 'string' ? staged.value : staged.text;
				this.planModelWrite(def, spec.trim(), ops, verify);
				continue;
			}
			if (staged.clear) {
				if (hasPath(this.snapshot().user, def.path)) {
					ops.push({ op: 'unset', path: def.path });
					verify.push((user) => !hasPath(user, def.path));
				}
				continue;
			}
			if (def.kind === 'secret') {
				const text = staged.text.trim();
				if (text !== '') {
					ops.push({ op: 'set', path: def.path, value: text });
					// secret 在 wire 上被剥离，无法读回验证。
				}
				continue;
			}
			if (def.kind === 'boolean') {
				const value = staged.value === true;
				if (value === (current === true)) continue;
				ops.push({ op: 'set', path: def.path, value });
				verify.push((user) => getPath(user, def.path) === value);
				continue;
			}
			if (def.kind === 'toolList' || def.kind === 'orderList') {
				const next = Array.isArray(staged.value) ? staged.value.map(String) : undefined;
				if (next === undefined) {
					invalid = true;
					continue;
				}
				if (next.length === 0) {
					// 清空 = unset（回到组合层）；组合层本就没有覆盖时不产生写入。
					if (!hasPath(this.snapshot().user, def.path)) continue;
					ops.push({ op: 'unset', path: def.path });
					verify.push((user) => !hasPath(user, def.path));
					continue;
				}
				const currentList = Array.isArray(current) ? current.map(String) : undefined;
				if (JSON.stringify(currentList) === JSON.stringify(next)) continue;
				ops.push({ op: 'set', path: def.path, value: next });
				verify.push((user) => JSON.stringify(getPath(user, def.path)) === JSON.stringify(next));
				continue;
			}
			if (staged.text === formatField(def, current)) continue;
			const parsed = parseField(def, staged.text);
			if (parsed === undefined) {
				invalid = true;
				continue;
			}
			if (parsed.kind === 'clear') {
				ops.push({ op: 'unset', path: def.path });
				verify.push((user) => !hasPath(user, def.path));
			} else {
				ops.push({ op: 'set', path: def.path, value: parsed.value });
				verify.push((user) => JSON.stringify(getPath(user, def.path)) === JSON.stringify(parsed.value));
			}
		}
		return { ops, dirty: ops.length > 0, invalid, verify };
	}

	private fieldState(key: string, dynamicOptions?: readonly string[]): FieldState {
		const def = this.def(key);
		const staged = this.staged.get(key);
		const options = dynamicOptions ?? def.options;
		if (staged === undefined) {
			const current = this.sectionValue(def);
			return {
				kind: def.kind,
				// modelSelect 的显示值是 provider + model 合成的规格串。
				text: def.kind === 'modelSelect' ? this.modelSpec(def, 'value') : formatField(def, current),
				checked: current === true,
				options,
				values: (def.kind === 'toolList' || def.kind === 'orderList') && Array.isArray(current) ? current.map(String) : undefined,
				overridden: this.overridden(key),
				invalid: false,
				clearStaged: false,
			};
		}
		if (def.kind === 'secret') {
			return {
				kind: def.kind,
				text: staged.clear ? '' : staged.text,
				checked: false,
				options,
				overridden: false,
				invalid: false,
				clearStaged: staged.clear,
			};
		}
		if (def.kind === 'boolean') {
			return {
				kind: def.kind,
				text: '',
				checked: staged.clear ? this.sectionValue(def) === true : staged.value === true,
				options,
				overridden: !staged.clear,
				invalid: false,
				clearStaged: false,
			};
		}
		if (def.kind === 'modelSelect') {
			// 文本形态是规格串；重选当前项不产生写入（planModelWrite 逐段比较）。
			// overridden 与其它字段同义：保存后该字段是否会在 user 层留下覆盖。
			const target = splitModelSpec(typeof staged.value === 'string' ? staged.value : staged.text);
			return {
				kind: def.kind,
				text: staged.text,
				checked: false,
				options,
				overridden: !staged.clear && target.provider !== '' && target.model !== '',
				invalid: false,
				clearStaged: false,
			};
		}
		if (def.kind === 'toolList' || def.kind === 'orderList') {
			const current = this.sectionValue(def);
			const live = Array.isArray(current) ? current.map(String) : [];
			return {
				kind: def.kind,
				text: '',
				checked: false,
				options,
				values: staged.clear ? live : Array.isArray(staged.value) ? staged.value.map(String) : live,
				overridden: !staged.clear,
				invalid: false,
				clearStaged: false,
			};
		}
		const write = staged.clear ? ({ kind: 'clear' } as const) : parseField(def, staged.text);
		return {
			kind: def.kind,
			text: staged.text,
			checked: false,
			options,
			overridden: !staged.clear && write?.kind === 'set',
			invalid: !staged.clear && write === undefined,
			clearStaged: false,
		};
	}

	private shellOf(cardId: string): CardShell {
		const plan = this.plan(cardId);
		return {
			dirty: plan.dirty,
			invalid: plan.invalid,
			saving: this.savingCards.has(cardId),
			failed: this.failedCards.has(cardId),
			saved: this.savedCards.has(cardId),
		};
	}

	/**
	 * 宿主注入的工具选项（字段 key → 工具名列表）：从 describe 镜像的
	 * 序列化 schema 里读 schema meta。宿主装载完成前或旧宿主没有该元数据
	 * 时返回空，控件回退为文本框。
	 */
	private toolOptions(): ReadonlyMap<string, readonly string[]> {
		const result = new Map<string, readonly string[]>();
		if (this.describe === undefined) return result;
		const view = this.describe.getSnapshot().view;
		const ns = view?.namespaces.find((entry) => entry.ns === SETTINGS_NS);
		if (ns === undefined) return result;
		for (const key of TOOL_LIST_FIELDS) {
			const options = readToolOptions(ns.schema, key);
			if (options !== undefined) result.set(key, options);
		}
		return result;
	}

	private projection(): CardState {
		const snapshot = this.snapshot();
		const toolOptions = this.toolOptions();
		const fields: Record<string, FieldState> = {};
		for (const group of FIELD_GROUPS) {
			for (const def of group.fields) {
				fields[def.key] = this.fieldState(def.key, toolOptions.get(def.key));
			}
		}
		const cards: Record<string, CardShell> = {};
		for (const group of FIELD_GROUPS) {
			cards[group.id] = this.shellOf(group.id);
		}
		return {
			available: snapshot.status === 'ready',
			writable: snapshot.writable,
			cards,
			fields,
		};
	}

	/** 保存一张卡片的全部暂存；落盘失败保留草稿供修改。 */
	private async save(cardId: string): Promise<void> {
		const plan = this.plan(cardId);
		if (this.savingCards.has(cardId) || !plan.dirty || plan.invalid) return;
		this.savingCards.add(cardId);
		this.failedCards.delete(cardId);
		this.publish();
		let landed = true;
		try {
			await this.scope.mutate(plan.ops);
			const user = this.snapshot().user;
			landed = plan.verify.every((check) => check(user));
		} catch {
			landed = false;
		}
		if (landed) {
			for (const key of [...this.staged.keys()]) {
				if (GROUP_OF_FIELD.get(key) === cardId) this.staged.delete(key);
			}
			// 保存回执：卡片**保持展开**（展开态由页面/组件持有，见 components.tsx
			// 与 client/cards.ts），只把"已保存并即时生效"显示在底部，用户接着改
			// 下一项即可，不需要重新点开卡片。
			this.savedCards.add(cardId);
		}
		this.savingCards.delete(cardId);
		if (!landed) this.failedCards.add(cardId);
		this.publish();
	}

	/** 放弃一张卡片的暂存。 */
	private discard(cardId: string): void {
		let changed = this.failedCards.delete(cardId);
		changed = this.savedCards.delete(cardId) || changed;
		for (const [key] of [...this.staged]) {
			if (GROUP_OF_FIELD.get(key) === cardId) {
				this.staged.delete(key);
				changed = true;
			}
		}
		if (changed) this.publish();
	}

	private publish(): void {
		this.store.set(this.projection());
	}
}
