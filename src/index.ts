/**
 * dsh-qq-bot — DeepSeek Harness × QQ（napcat / OneBot 11）适配插件。
 *
 * 五层结构：
 *   napcat ⇄ Transport（正向/反向 WS）⇄ OneBot 协议层 ⇄ Pipeline
 *          ⇄ ChatBridge ⇄ dsh agent 服务
 *
 * 复用 dsh 原生的 agent loop / 工具 / 会话持久化；本插件只做
 * QQ 适配与聊天体验层（唤醒、访问控制、媒体、人格、命令、折叠转发）。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, attachToolOptions, type DshQQConfig } from './config.ts';
import { hotApplyConfig, rateLimitSignature } from './configSync.ts';
import { dataDirMigration, legacySessionLeftovers, legacySessionsRoot, migrateLegacyDataFiles, resolveDataDir, resolveSessionsRoot, type DataDirMigration } from './paths.ts';
import { getService, getLogger, type Logger } from './types.ts';
import { CHAT_TOOLS } from './bridge/toolGuard.ts';
import type { AgentRegistry, AgentDefaultModelLike, AgentPresetsLike, ConnectionRpcResultLike, DshServices, HostConnectionLike, LlmServiceLike, SessionPersistenceLike, SessionStore, SettingsServiceLike, ToolRegistryListLike, WebSearchSeamLike, WorkspaceRegistryLike } from './dsh.ts';
import { ForwardTransport } from './transport/forward.ts';
import { ReverseTransport } from './transport/reverse.ts';
import type { OneBotTransport, TransportOptions } from './transport/base.ts';
import { OneBotApi } from './onebot/api.ts';
import { RosterService } from './onebot/roster.ts';
import { ChatHistoryService } from './onebot/history.ts';
import { AccessControl, AdminStore } from './pipeline/access.ts';
import { Dispatcher } from './pipeline/dispatcher.ts';
import { ChatBridgeManager } from './bridge/chat.ts';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { PersonaStore } from './persona/store.ts';
import { handlePersonaRpc, type PersonaRpcDeps } from './persona/rpc.ts';
import { TaskStore, type ScheduledTask } from './tasks/store.ts';
import { TaskScheduler } from './tasks/scheduler.ts';
import { handleTaskRpc, type TaskRpcDeps } from './tasks/rpc.ts';
import { registerWebRpcChannel, type WebServerLike } from './webRpc.ts';
import { registerTools } from './tools/index.ts';
import { registerTaskTools } from './tools/tasks.ts';
import { registerHistoryTool } from './tools/history.ts';
import { registerSearchTool } from './tools/search.ts';
import { registerMemoryTools } from './tools/memory.ts';
import type { AskRequest } from './bridge/ask.ts';
import { createMemoryService } from './memory/index.ts';
import { SearchService } from './search/service.ts';
import { MessageLogService } from './logs/store.ts';
import { LOG_STREAM_PATH, createLogStreamResponse } from './logs/stream.ts';
import { withActionLogging } from './logs/transportLog.ts';

/** 稳定插件名（与 cordis.patch.yml 的插入行 id 一致）。 */
export const name = 'dsh-qq-bot';

/** 依赖的 dsh 核心服务。 */
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'sessions', 'tools'];

/** 插件配置（schemastery schema；Web UI 自动渲染）。 */
export const Config = ConfigSchema;

/** WebUI 配置页的宿主 RPC 通道名（与客户端 client/index.ts 的 LOGS_RPC_CHANNEL 一致）。 */
const RPC_CHANNEL = '/dsh-qq-bot';

/**
 * 旧路径的一次性搬迁与提示（v0.3 起路径统一为 `dataDir`）。
 *
 * - 数据文件：旧数据目录里的已知条目按需复制到统一数据目录（只补缺、不覆盖，
 *   见 paths.ts 的 migrateLegacyDataFiles）；必须在各 store 读盘前调用。
 * - 会话目录：**不搬迁**——dsh 会话的工作目录创建后不可修改，老会话必须 /reset
 *   一次才会落到 `<数据目录>/sessions/`；这里只提示旧目录位置，避免用户以为
 *   自己放在会话目录里的文件丢了。
 */
function migrateLegacyData(env: { homeDir: string; cwd: string }, config: DshQQConfig, logger: Logger): void {
	const plan: DataDirMigration = dataDirMigration(config, env);
	const result = migrateLegacyDataFiles(plan);
	if (result.ran && result.copied.length > 0) {
		logger.info(
			`dsh-qq-bot: 已把旧数据目录 ${plan.copyFrom} 的数据搬到统一数据目录 ${plan.copyTo}（${result.copied.join('、')}）；旧目录保留，确认无误后可自行清理`,
		);
	}
	for (const failure of result.errors) {
		logger.warn(`dsh-qq-bot: 旧数据 ${failure.entry} 搬迁失败（不影响启动，可手动复制）：${failure.message}`);
	}
	const sessionsRoot = resolveSessionsRoot(config, env);
	const leftovers = legacySessionLeftovers(config, env);
	if (leftovers.length > 0) {
		const shown = leftovers.slice(0, 3).join('、');
		logger.warn(
			`dsh-qq-bot: 旧会话目录 ${legacySessionsRoot(config, env)} 下还有 ${leftovers.length} 个旧会话目录（${shown}${leftovers.length > 3 ? ' 等' : ''}）已不再使用：会话目录现在是 ${sessionsRoot}，其中的文件可手动移动过去；老会话需发送 /reset 一次才会落到新目录`,
		);
	}
}

/** 挂载插件（dsh/Cordis 入口约定）。 */
export async function apply(ctx: Context, config: DshQQConfig): Promise<void> {
	const logger = getLogger(ctx);

	const agents = getService<AgentRegistry>(ctx, 'agents');
	const sessions = getService<SessionStore>(ctx, 'sessions');
	const agentDefaultModel = getService<AgentDefaultModelLike>(ctx, 'agentDefaultModel');
	const agentPresets = getService<AgentPresetsLike>(ctx, 'agentPresets');
	const llm = getService<LlmServiceLike>(ctx, 'llm');
	const loader = getService<{ await(): Promise<unknown> }>(ctx, 'loader');
	if (agents === undefined || sessions === undefined || agentDefaultModel === undefined) {
		throw new Error('dsh-qq-bot: 缺少核心服务（agents / sessions / agentDefaultModel）');
	}
	const services: DshServices = {
		logger,
		agents,
		sessions,
		agentDefaultModel,
		agentPresets,
		llm,
		getPersistence: () => sessionPersistence,
		ready: loader?.await() ?? Promise.resolve(),
	};

	// 唯一的路径设置：数据目录（会话目录 sessions/ + 人格库 + 身份表 + 任务 +
	// 动态管理员 + 群成员缓存 + 消息日志全在它下面）。旧键仍是读取兜底，见 paths.ts。
	const pathEnv = { homeDir: homedir(), cwd: process.cwd() };
	const dataDir = resolveDataDir(config, pathEnv);
	try {
		mkdirSync(dataDir, { recursive: true });
	} catch (error) {
		throw new Error(`dsh-qq-bot: 数据目录不可写 ${dataDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	// 旧部署的数据文件搬迁（旧数据目录 → 统一数据目录）：**必须在各 store 读盘前**完成，
	// 否则 store 会先写出一份空文件，搬迁因"目标已存在"被跳过 → 人格库/会话身份表丢失。
	migrateLegacyData(pathEnv, config, logger);
	const admins = new AdminStore(config, dataDir, logger);
	await admins.load();
	const store = new PersonaStore(dataDir, logger);
	store.init();
	// 定时任务库（tasks.json）：agent 工具 / WebUI / /tasks 命令共用的持久层。
	const taskStore = new TaskStore(dataDir, logger);
	taskStore.init();

	// 消息日志：OneBot 收发 + dsh 回复（WebUI「消息日志与诊断」卡片内嵌视图与 /logs 命令查看）。
	const logs = new MessageLogService({ logger, dataDir });
	logs.reconfigure(config);

	// 传输层 + API + 会话桥。工厂化是为了 WebUI 改连接参数后可整体重建。
	const selfId = { current: '' };

	function createTransport(cfg: DshQQConfig): OneBotTransport {
		const options: TransportOptions = {
			accessToken: cfg.accessToken,
			reconnectDelayMs: cfg.reconnectDelayMs,
			logger,
			onEvent: (event) => dispatcher.handle(event),
			onStatus: (status) => {
				if (status.connected) void refreshSelfId();
			},
		};
		const inner = cfg.transport === 'reverse'
			? new ReverseTransport(cfg.reversePort, cfg.reversePath, options)
			: new ForwardTransport(cfg.url, options);
		// 出站 action 日志在 transport 上拦，transport 重建后包装自动跟随。
		return withActionLogging(inner, logs);
	}

	let transport = createTransport(config);
	const api = new OneBotApi(transport, logger);
	const roster = new RosterService({
		api,
		config,
		logger,
		dataDir,
		getSelfId: () => selfId.current,
	});
	// 聊天记录：本地缓冲（进程内，不落盘）+ 远端历史接口。agent 用
	// qq_read_history 主动读取，群聊里"刚才大家在聊什么"因此可查。
	const history = new ChatHistoryService({
		api,
		config,
		logger,
		getSelfId: () => selfId.current,
		nameOf: (groupId, userId) => roster.cachedName(groupId, userId),
	});
	// 工作区注册表：WebUI 左栏的会话分组按工作区归属决定。该服务可能晚于本
	// 插件装载，所以用 inject 捕获 + 惰性读取，不能在构造时快照。
	let workspaceRegistry: WorkspaceRegistryLike | undefined;
	(ctx as { inject(services: readonly string[], cb: (c: Context) => void): void }).inject(['workspaceRegistry'], (workspaceCtx) => {
		workspaceRegistry = getService<WorkspaceRegistryLike>(workspaceCtx, 'workspaceRegistry');
	});
	// 会话持久化服务：只用来探测"界面是否已释放这个会话的写句柄"（见
	// bridge/chat.ts 的 probeResume）。同样是可选服务 + 惰性读取：旧宿主
	// 没有它时探测退化为多试一次 resume，不影响其它逻辑。
	let sessionPersistence: SessionPersistenceLike | undefined;
	(ctx as { inject(services: readonly string[], cb: (c: Context) => void): void }).inject(['sessionPersistence'], (persistenceCtx) => {
		sessionPersistence = getService<SessionPersistenceLike>(persistenceCtx, 'sessionPersistence');
	});
	// 宿主 ctx.web（dsh 的联网能力缝）：qq_web_search 的 `dsh` 兜底档直接走它
	// （等价于内置 web_search 工具的后端）。同样是可选服务，用 inject 捕获 +
	// 惰性 getter——TUI profile 或旧宿主没有它，那一档在链上自动跳过。
	let webSeam: WebSearchSeamLike | undefined;
	(ctx as { inject(services: readonly string[], cb: (c: Context) => void): void }).inject(['web'], (webCtx) => {
		webSeam = getService<WebSearchSeamLike>(webCtx, 'web');
	});
	// 网页搜索：优先级链（exa → tavily → dsh 内置）+ 失败顺延，配置实时读取。
	const search = new SearchService({
		config,
		logger,
		logs,
		getWeb: () => webSeam,
	});
	// 长期记忆：默认关闭；开启时打开 <dataDir>/memory.db（node:sqlite + FTS5）。
	// 蒸馏走 ctx.llm 的一次性请求（不建 agent），llm 是可选服务，惰性读取。
	let llmSeam: { stream?: unknown } | undefined;
	(ctx as { inject(services: readonly string[], cb: (c: Context) => void): void }).inject(['llm'], (llmCtx) => {
		llmSeam = getService<{ stream?: unknown }>(llmCtx, 'llm');
	});
	const memory = await createMemoryService({
		dataDir,
		config,
		logger,
		// 记忆卡片/检索/蒸馏里的会话称呼**不带号码**：这些文本会进模型上下文，
		// 号码一旦出现就会被写进回复（见 AGENTS.md「模型可见文本里不许出现 QQ 号」）。
		labelOf: (chatKey) => (chatKey.startsWith('u-') ? '与对方的私聊' : '本群'),
		getLlm: () => llmSeam,
		getDefaultModel: () => services.agentDefaultModel.currentSelection(),
		createUserMessage: (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
		// 存储随总开关热开热关：状态一变就同步工具注册（见 syncMemoryTools）。
		onStorageChange: () => {
			syncMemoryTools();
		},
		// 记忆的关键状态与失败原因进消息日志（WebUI「消息日志与诊断」卡片 + NDJSON）：
		// dsh 自己的 logger 在部分部署里不落盘，没有这条通道就查不出"为什么记忆不更新"。
		note: (event, detail) => {
			logs.record({ dir: 'sys', scope: 'dsh', event, senderName: '长期记忆', text: detail });
		},
	});

	// 定时任务工具是否注册成功（apply 时决定；桥据此决定是否注入任务能力提示）。
	let taskToolsReady = false;
	// 聊天记录工具是否注册成功（同上，决定 system prompt 是否提示可读聊天记录）。
	let historyToolReady = false;
	// 长期记忆工具是否注册成功（同上，决定 system prompt 是否提示记忆能力）。
	let memoryToolReady = false;
	/** 记忆工具的注销函数（总开关关掉 / 存储不可用时调用）。 */
	let memoryToolsDispose: (() => void) | undefined;
	// 网页搜索工具是否注册成功（同上，决定 system prompt 是否提示用 qq_web_search）。
	let searchToolReady = false;
	const manager = new ChatBridgeManager(config, {
		api,
		services,
		store,
		roster,
		admins,
		logger,
		logs,
		getWorkspaces: () => workspaceRegistry,
		dataDir,
		getSelfId: () => selfId.current,
		memory,
		tasksAvailable: () => taskToolsReady,
		historyAvailable: () => historyToolReady,
		searchHint: () => (searchToolReady ? search.hintSection() : ''),
		memoryAvailable: () => memoryToolReady,
	});

	async function refreshSelfId(): Promise<void> {
		const info = await api.getLoginInfo();
		if (info !== undefined && selfId.current !== info.user_id) {
			selfId.current = info.user_id;
			logger.info(`dsh-qq-bot: 机器人身份 ${info.nickname}(${info.user_id})`);
		}
	}

	const access = new AccessControl(config, admins);
	const dispatcher = new Dispatcher({
		config,
		logger,
		api,
		manager,
		admins,
		access,
		store,
		roster,
		history,
		memory,
		services,
		logs,
		tasks: taskStore,
		runTask: (task) => void fireTask(task),
		getSelfId: () => selfId.current,
		setSelfId: (id) => {
			selfId.current = id;
		},
	});

	// 定时任务触发管线：把到期的任务送到对应会话桥（bridgeForChatKey 按
	// 任务存储的 chatKey 复原会话身份，perUser 群键也成立）。入会话串行
	// 队列，回复走常规出站管线；队列满 = 本轮跳过（下个周期照常触发）。
	async function fireTask(task: ScheduledTask): Promise<void> {
		const bridge = manager.bridgeForChatKey(task.chatKey);
		if (bridge === undefined) {
			logger.warn(`dsh-qq-bot: 定时任务 ${task.id} 的会话键 ${task.chatKey} 无法识别，跳过触发`);
			return;
		}
		if (!bridge.enqueue(() => bridge.handleScheduledTask(task))) {
			logger.warn(`dsh-qq-bot: 定时任务 ${task.id} 触发时 ${bridge.label} 队列已满，本轮跳过`);
		}
	}

	const scheduler = new TaskScheduler({ store: taskStore, logger, fire: fireTask });
	// 任务增删改（工具 / WebUI / 命令）后重算触发点；接线放在调度器创建后，
	// 之前 store 的任何变更都发生在 init 读盘阶段。
	taskStore.onChange = () => scheduler.refresh();
	if (config.tasksEnabled) scheduler.start();

	// 主动消息工具（qq_send / qq_send_image / qq_recall）与定时任务工具。
	if (config.registerSendTools) {
		try {
			registerTools(ctx, services, manager, config);
		} catch (error) {
			logger.warn(`dsh-qq-bot: 工具注册失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (config.tasksEnabled) {
		try {
			registerTaskTools(ctx, services, manager, taskStore, config);
			taskToolsReady = true;
		} catch (error) {
			logger.warn(`dsh-qq-bot: 定时任务工具注册失败（本插件的任务能力提示与工具不可用）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// 聊天记录读取工具（qq_read_history）：记录本身即时生效，工具注册需重启 dsh。
	if (config.historyEnabled) {
		try {
			registerHistoryTool(ctx, services, manager, history, config);
			historyToolReady = true;
		} catch (error) {
			logger.warn(`dsh-qq-bot: 聊天记录工具注册失败（qq_read_history 不可用）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// 网页搜索工具（qq_web_search）：按配置的优先级链顺延（chain / Key / 超时
	// 都热应用，工具注册需重启 dsh）。
	if (config.searchEnabled) {
		try {
			registerSearchTool(ctx, services, manager, search, config);
			searchToolReady = true;
			logger.info(`dsh-qq-bot: 网页搜索优先级链 ${search.chainDescription()}`);
		} catch (error) {
			logger.warn(`dsh-qq-bot: 网页搜索工具注册失败（qq_web_search 不可用）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 长期记忆工具（qq_recall_memory / qq_memorize）：默认仅管理员可用——它们
	// **不在** CHAT_TOOLS 里，普通用户要用得显式加进 userTools（与 qq_web_search 同）。
	// 工具随总开关与存储状态实时注册/注销：WebUI 打开开关（存储随之打开）后
	// 立刻可用，关掉开关即摘掉，不需要重启 dsh。
	function syncMemoryTools(): void {
		const wanted = config.memoryEnabled && memory.ready;
		if (wanted === memoryToolReady) return;
		if (wanted) {
			try {
				memoryToolsDispose = registerMemoryTools(ctx, services, manager, memory, config);
				memoryToolReady = true;
				logger.info(
					`dsh-qq-bot: 长期记忆已启用（卡片 ${config.memoryCardMaxChars} 字，蒸馏每 ${config.memoryDistillEvery} 条/空闲 ${Math.round(config.memoryDistillIdleMs / 60000)} 分钟；qq_recall_memory / qq_memorize 已注册）`,
				);
			} catch (error) {
				logger.warn(`dsh-qq-bot: 长期记忆工具注册失败（qq_recall_memory / qq_memorize 不可用）: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
		const dispose = memoryToolsDispose;
		memoryToolsDispose = undefined;
		memoryToolReady = false;
		if (dispose === undefined) {
			logger.warn('dsh-qq-bot: 长期记忆已停用，但当前宿主不支持运行时摘除工具（重启 dsh 后才会从清单消失；期间调用会以「记忆不可用」被拒绝）');
			return;
		}
		try {
			dispose();
		} catch (error) {
			logger.warn(`dsh-qq-bot: 长期记忆工具注销失败（重启 dsh 可彻底移除）: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		logger.info('dsh-qq-bot: 长期记忆已停用，记忆工具已从运行时清单摘除（库文件保留）');
	}
	syncMemoryTools();

	// 工具清单 → 配置 schema 元数据：WebUI 里 userTools/blockedTools 据此渲染
	// 成选择框。装载完成后枚举一次，之后随 tools/change 刷新；describe 每次
	// 读活 schema，浏览器下次拉取即拿到最新清单。
	const toolsList = (ctx as unknown as { tools?: ToolRegistryListLike }).tools;
	function refreshToolOptions(): void {
		if (typeof toolsList?.schemas !== 'function') return;
		try {
			const names = new Set<string>(CHAT_TOOLS);
			for (const schema of toolsList.schemas()) names.add(schema.name);
			attachToolOptions([...names]);
		} catch (error) {
			logger.warn(`dsh-qq-bot: 工具清单枚举失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	refreshToolOptions();
	void services.ready.then(refreshToolOptions, () => {});
	(ctx as unknown as { on(event: string, listener: () => void): void }).on('tools/change', refreshToolOptions);

	transport.start();
	manager.startEvictor();
	// 抢在浏览器之前占住写句柄（见 ChatBridgeManager.warmup）：dsh 界面 promote
	// 一个会话后就再也不释放，插件重启/热重载后这段空窗是它唯一能输的时刻。
	void manager.warmup().catch((error: unknown) => {
		logger.warn(`dsh-qq-bot: 启动预热异常：${error instanceof Error ? error.message : String(error)}`);
	});
	logger.info(`dsh-qq-bot: 已启动（transport=${config.transport}，白名单模式 ${config.privateMode}/${config.groupMode}）`);

	// agent 提问（ask_user_question / 计划确认等走 `ctx.userQuestions` 缝的工具）：
	// 缝上派发 `user-questions/request` 瀑布等人回答，而内置应答器只有 WebUI 的
	// 浏览器端——QQ 用户看不到问题，整轮一直等到单轮超时。这里把请求转给会话桥
	// （bridge/asker.ts）发到 QQ，并把用户的下一条消息作为答案回填。
	//
	// **必须 prepend**：瀑布是"外层先答"，不抢先的话，那个 QQ 会话一旦开在
	// dsh 界面里就会被浏览器端领走，QQ 侧只剩干等。抢先不等于独占——桥内部
	// 把请求同时放给下游并与之赛跑，两边谁先给出答案就用谁（见 ChatBridge.askFromQQ）。
	// 非 QQ 会话（agent 反查不到桥）原样 next()，对其它入口零影响。
	(ctx as unknown as { on(name: string, listener: (request: AskRequest, next: () => Promise<unknown>) => unknown, options?: { prepend?: boolean }): unknown }).on(
		'user-questions/request',
		(request: AskRequest, next: () => Promise<unknown>): unknown => {
			const agent = request.agent;
			if (agent === undefined) return next();
			const bridge = manager.bridgeBySessionId(String(agent.id));
			if (bridge === undefined) return next();
			return bridge.askFromQQ(request, next);
		},
		{ prepend: true },
	);

	// WebUI 的宿主 RPC（connection / webServer 缺失 = 旧宿主或非 web profile）：
	// 日志查看 + 日志实时流 + 人格库与「人格与模型」表格 + 定时任务列表（见
	// persona/rpc.ts 与 tasks/rpc.ts）。
	// 两个服务都可能晚于本插件装载，所以用 inject 懒挂载而不是在 apply 里快照。
	// 通道**不走 connection.rpc.handle**（该 API 在 cordis shadow 代理下拿不到
	// webServer，路由静默不注册 → 客户端 405），改为 webRpc.ts 直接挂 prefix 路由。
	(ctx as { inject(services: readonly string[], cb: (c: Context) => void): void }).inject(
		['connection', 'webServer'],
		(channelCtx) => {
			const connection = getService<HostConnectionLike>(channelCtx, 'connection');
			const webServer = getService<WebServerLike>(channelCtx, 'webServer');
			if (connection === undefined || typeof connection.requestRejection !== 'function' || webServer === undefined || typeof webServer.register !== 'function') {
				logger.warn('dsh-qq-bot: 缺少 connection / webServer，WebUI 配置页的 RPC（日志、人格库、人格与模型）不可用');
				return;
			}
			const personaRpc: PersonaRpcDeps = {
				store,
				getLlm: () => getService<LlmServiceLike>(ctx, 'llm'),
				getDefaultModel: () => agentDefaultModel.currentSelection(),
				refreshBridges: () => manager.rebuildAll(),
				logger,
			};
			// 定时任务卡片的数据面：单任务操作（agent 会并发建任务，不做整表替换）。
			const taskRpc: TaskRpcDeps = {
				store: taskStore,
				nextRunOf: (id) => scheduler.nextRunOf(id),
				perChatLimit: () => config.taskMaxPerChat,
				runTask: (task) => void fireTask(task),
				logger,
			};
			const handleEndpoint = async (endpoint: string, payload: unknown): Promise<ConnectionRpcResultLike> => {
				try {
					const handled = await handleTaskRpc(endpoint, payload, taskRpc);
					if (handled !== undefined) return handled;
					const personaHandled = await handlePersonaRpc(endpoint, payload, personaRpc);
					if (personaHandled !== undefined) return personaHandled;
					// 连接卡片头部的"已连接"角标（客户端每 4s 轮询一次）：
					// transport 是 let，重建后闭包读到的始终是最新实例。
					if (endpoint === 'status/connection') {
						return { ok: true, value: { connected: transport.connected } };
					}
					if (endpoint === 'logs/recent') {
						const query = (payload ?? {}) as { limit?: unknown; chatId?: unknown; dir?: unknown };
						const limit = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.min(Math.max(Math.trunc(query.limit), 1), 1000) : undefined;
						const chatId = typeof query.chatId === 'string' && query.chatId !== '' ? query.chatId : undefined;
						const dir = query.dir === 'in' || query.dir === 'out' || query.dir === 'sys' ? query.dir : undefined;
						return { ok: true, value: { entries: logs.recent({ limit, chatId, dir }) } };
					}
					if (endpoint === 'logs/clear') {
						logs.clear();
						return { ok: true, value: { cleared: true } };
					}
					return { ok: false, error: { code: 'not-found', message: `未知端点 ${endpoint}` } };
				} catch (error) {
					return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } };
				}
			};
			try {
				(channelCtx as unknown as { effect(fn: () => unknown, label?: string): unknown }).effect(
					() => registerWebRpcChannel({ webServer, connection, channel: RPC_CHANNEL, handler: handleEndpoint, logger }),
					'dsh-qq-bot: WebUI RPC 通道',
				);
				logger.info(`dsh-qq-bot: WebUI RPC 通道已注册（${RPC_CHANNEL}）`);
			} catch (error) {
				logger.error(`dsh-qq-bot: WebUI RPC 通道注册失败：${error instanceof Error ? error.message : String(error)}`);
			}
			// 日志实时流（SSE）：客户端 EventSource 长连接，新条目零延迟推送。
			// 旧宿主没有 connection.fetch 时注册跳过，WebUI 自动退回轮询。
			const fetchRegistry = connection.fetch;
			if (fetchRegistry === undefined || typeof fetchRegistry.register !== 'function') return;
			(channelCtx as unknown as { effect(fn: () => unknown, label?: string): unknown }).effect(
				() =>
					fetchRegistry.register({
						path: LOG_STREAM_PATH,
						methods: ['GET'],
						requestBody: 'buffered',
						fetch: (request) => Promise.resolve(createLogStreamResponse(logs, request)),
					}),
				'dsh-qq-bot: 消息日志实时流',
			);
		},
	);

	/** 连接参数变化时重建 transport 并挂回现有管线（api/roster/bridge 复用）。 */
	function rebuildTransport(): void {
		transport.stop();
		transport = createTransport(config);
		api.attach(transport);
		transport.start();
		logger.info(`dsh-qq-bot: 传输层已重建（transport=${config.transport}）`);
	}

	// WebUI 配置节：settings 服务存在时注册（dsh >= 0.1.2-rc.1）。WebUI 修改后
	// 宿主只回调 hooks、不重启插件，热应用逻辑见 configSync；服务缺失则没有
	// 配置界面，插件功能不受影响。
	(ctx as { inject(services: readonly string[], cb: (c: Context) => void): void }).inject(['settings'], (settingsCtx) => {
		const settings = getService<SettingsServiceLike>(settingsCtx, 'settings');
		if (settings === undefined) return;
		let current: () => DshQQConfig = () => config;
		// base 层必须传组合配置的快照：live config 会被热应用原地合并，
		// 若直接传引用，"恢复默认"会回到热改后的值而非组合层原值。
		const compositionConfig = structuredClone(config);
		// 统一路径的一次性写回（v0.3 起 workspaceRoot / sessionGroupRoot 并入
		// dataDir）：把旧根搬进新键，页面才会显示真实的根。只 set 不 unset 旧键
		// （回退旧版本仍可用）；写失败/旧宿主无写接口都不影响运行——读取侧
		// resolveDataDir 仍按旧键兜底。数据文件搬迁已在 apply 开头完成。
		let legacyPathsMigrated = false;
		const migrateLegacyPaths = (latest: DshQQConfig): void => {
			if (legacyPathsMigrated) return;
			const plan = dataDirMigration(latest, pathEnv);
			if (plan.ops.length === 0) return;
			legacyPathsMigrated = true;
			const mutate = settings.mutate;
			if (typeof mutate !== 'function') return;
			void Promise.resolve(mutate.call(settings, name, plan.ops))
				.then(() => logger.info('dsh-qq-bot: 已把旧会话根/数据目录迁移为统一的 dataDir，数据目录不变'))
				.catch((error: unknown) =>
					logger.warn(
						`dsh-qq-bot: 数据目录迁移写入失败（不影响运行，仍按旧值兜底）：${error instanceof Error ? error.message : String(error)}`,
					),
				);
		};
		settings.installSection(ctx, name, ConfigSchema, compositionConfig, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				const latest = current();
				if (latest === undefined) return;
				const prevRateLimit = rateLimitSignature(config.rateLimit);
				const needRebuild = hotApplyConfig(config, latest);
				if (rateLimitSignature(config.rateLimit) !== prevRateLimit) dispatcher.reconfigureRateLimit(config);
				logs.reconfigure(config);
				// 聊天记录：开关/上限即时生效（缓冲调小立即裁剪）；工具注册仍需重启。
				history.reconfigure();
				// 长期记忆：卡片缓存失效 + 按新的保留期裁剪一次；总开关变化会顺带
				// 打开/关闭存储，存储状态一变就同步记忆工具（见 onStorageChange）。
				memory.reconfigure();
				// 空闲回收：`sessionIdleTimeoutMs` 改成 0 = 插件会话永不回收，
				// 定时器要跟着启停（否则关掉的回收器还会继续跑）。
				manager.reconfigureEviction();
				if (needRebuild) rebuildTransport();
				// 定时任务触发器热启停（工具注册仍需重启；提示文案已注明）。
				if (config.tasksEnabled && !scheduler.running) {
					scheduler.start();
					logger.info('dsh-qq-bot: 定时任务触发器已随配置更新启动');
				} else if (!config.tasksEnabled && scheduler.running) {
					scheduler.stop();
					logger.info('dsh-qq-bot: 定时任务触发器已随配置更新停止（已有任务保留）');
				}
				migrateLegacyPaths(latest);
				logger.info('dsh-qq-bot: 检测到 WebUI 配置更新，已热应用');
			},
		});
	});
	if (config.privateMode === 'allowlist' && config.allowedUsers.length === 0 && config.adminUsers.length === 0) {
		logger.warn('dsh-qq-bot: 私聊 allowlist 为空 = 拒绝所有私聊。请配置 allowedUsers 或 adminUsers。');
	}
	if (config.groupMode === 'allowlist' && config.allowedGroups.length === 0 && config.adminUsers.length === 0) {
		logger.warn('dsh-qq-bot: 群聊 allowlist 为空 = 拒绝所有群聊。请配置 allowedGroups 或 adminUsers。');
	}

	// dispose 是 Cordis 运行时生命周期事件（dsh 插件通用做法），未进基础类型声明。
	(ctx as unknown as { on(event: string, listener: () => void): void }).on('dispose', () => {
		scheduler.stop();
		transport.stop();
		void manager.disposeAll().catch((error: unknown) => {
			logger.warn(`dsh-qq-bot: 会话销毁异常: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
}
