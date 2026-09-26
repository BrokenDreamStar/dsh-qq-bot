/**
 * dsh 核心服务的最小类型面。
 *
 * 有官方类型的直接用 @deepseek-ai/dsh-agent / dsh-session 导出的类型；
 * 还没进发布包的服务（agentPresets、llm、agentDefaultModel）按实际用法
 * 声明最小结构（与 tencent-connect 官方插件的 "Like" 类型策略一致），
 * dsh 升级时只需改这一个文件。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AgentRegistry, AgentHandle, Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import type { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import type { Logger } from './types.ts';

export type { AgentRegistry, AgentHandle, Agent, AgentOptions, SessionStore, SessionId };

/** agentPresets 服务的最小接口（dsh 内核服务，未随 npm 包发布类型）。 */
export interface AgentPresetsLike {
	/** 在 agentCtx 上挂载预设（工具集、prompt 等）；失败应中止 agent 创建。 */
	mount(agentCtx: Context, presetId?: string): Promise<void>;
	resolve?(presetId?: string): Promise<{ id: string; broken?: string }>;
	list?(): Promise<readonly { id: string; name?: string; description?: string }[]>;
}

/** 部署默认模型选择服务。 */
export interface AgentDefaultModelLike {
	currentSelection(): AgentOptions;
}

/** provider 条目：旧版 dsh 返回 route key 字符串，0.1.5 起返回 {id, name} 对象。 */
export type LlmProviderEntry = string | { id: string; name?: string };

/** ctx.llm 服务（模型枚举 + 一次性调用；可选）。 */
export interface LlmServiceLike {
	listProviders(): readonly LlmProviderEntry[];
	listModels(providerId: string): Promise<readonly { id: string; name?: string }[]>;
	/**
	 * 一次性模型调用（长期记忆的蒸馏用它）。
	 *
	 * dsh 的注释明确支持"手搓 messages 的一次性请求"（*a hand-built one-shot
	 * passes any list*），所以蒸馏**不需要新建 agent**，也就不产生多余的 dsh
	 * 会话文件、不占写句柄。旧宿主没有这个方法时自动蒸馏停用。
	 */
	stream?(options: {
		provider: string;
		model: string;
		system?: string;
		messages: unknown[];
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): AsyncIterable<{ type: string; text?: string }>;
}

/** provider 条目归一为 route key（兼容两版 dsh）。 */
export function providerId(entry: LlmProviderEntry): string {
	return typeof entry === 'string' ? entry : entry.id;
}

/** settings.onChange / installSection hooks 的最小接口（见 dsh-settings）。 */
export interface SettingsSectionHooksLike<T> {
	/** 注册时与每次设置提交后调用：传入返回最新解析配置的 getter。 */
	setSource(current: () => T): void;
	/** 注册时与每次该命名空间 committed change 后调用（无参数）。 */
	onChange(): void;
}

/** ctx.settings 服务（WebUI 配置节注册；可选，dsh 0.1.2-rc.1 起提供）。 */
export interface SettingsServiceLike {
	/**
	 * 把插件的 schemastery 配置注册为 WebUI 可编辑的 settings 命名空间。
	 * entry 为当前生效配置（作为 base 层）；用户层写入存 settings.yaml，
	 * 宿主不会重启插件，热应用靠 hooks。
	 */
	installSection<T>(owner: Context, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooksLike<T>): void;
	/**
	 * 用户层定向写入（`{op:'set'|'unset', path}` 有序应用），仅用户层、不碰 base。
	 * 用于旧字段的一次性迁移；旧宿主可能没有该方法，调用方必须判空降级。
	 */
	mutate?(
		ns: string,
		ops: ReadonlyArray<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>,
		expectedRevision?: number,
	): Promise<unknown>;
}

/** ctx.workspaceRegistry 服务的最小接口（dsh 内核服务，未随 npm 包发布类型）。 */
export interface WorkspaceRegistryLike {
	/** 按目录创建或复用工作区（目录必须已存在）；分组名默认取目录 basename。 */
	create(path: string, title?: string): Promise<WorkspaceLike>;
	/** 按目录解析已注册的工作区；未注册返回 undefined。 */
	resolveByPath?(path: string): Promise<WorkspaceLike | undefined>;
	list?(): WorkspaceLike[];
}

/** 工作区实体的最小接口（分组展示 + 会话归属）。 */
export interface WorkspaceLike {
	readonly path: string;
	readonly title: string;
	/** 把会话挂到该工作区下（要求会话 header.cwd 与工作区目录一致）。 */
	attachSession(sessionId: SessionId): Promise<void>;
}

/** ctx.tools 的最小读面（枚举全局可见工具名，供 WebUI 工具选择框；见 dsh-tools）。 */
export interface ToolRegistryListLike {
	/** 全局视图的可见工具 schema；scope 缺省 = 不带 agent 作用域的全局层。 */
	schemas(scope?: unknown): readonly { name: string; description?: string }[];
}

/** 一条网页搜索结果来源（dsh-web 的 WebSearchSource 形状）。 */
export interface WebSearchSourceLike {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
}

/** 一次网页搜索的结果（dsh-web 的 WebSearchResult 形状）。 */
export interface WebSearchResultLike {
	content?: string;
	sources: readonly WebSearchSourceLike[];
	truncated: boolean;
}

/**
 * ctx.web 的最小**搜索**面（dsh-web 的能力缝，宿主 bundle 的 `web` 行提供）。
 *
 * 只用到"执行一次搜索"这一面：qq_web_search 的 `dsh` 兜底后端直接走它，等价于
 * 内置 web_search 工具的后端。**provider 选择属于宿主配置**（`web.searchProvider`，
 * 本部署固定为 deepseek-official），本插件不注册提供者、也不参与选择——所以这条
 * 兜底用到的就是宿主当前生效的那个后端。
 */
export interface WebSearchSeamLike {
	search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<WebSearchResultLike>;
}

/** 自定义 RPC 端点处理结果（dsh-client-connection 的 ConnectionRpcResult 形状）。 */
export type ConnectionRpcResultLike = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details?: object } };

/** connection.fetch 的精确 Fetch 路由声明（路径必须以 /api/ 开头）。 */
export interface HostConnectionFetchRouteLike {
	/** 绝对路径（含 /api 前缀），如 '/api/dsh-qq-bot/logs/stream'。 */
	path: string;
	methods: readonly string[];
	requestBody: 'buffered' | 'streaming';
	fetch: (request: Request) => Promise<Response>;
}

/**
 * ctx.connection 的最小写面（WebUI 宿主↔插件 RPC / Fetch 通道；可选）。
 *
 * 注意：**不用 `connection.rpc.handle()`**——它内部用 `owner.webServer` 挂路由，
 * 会在 cordis shadow 代理下抛 `cannot get property "webServer" without inject`，
 * 路由静默不注册（客户端 POST 落到前端静态兜底 → HTTP 405）。插件的
 * `/dsh-qq-bot` 通道改由 `webRpc.ts` 直接在 webServer 上注册 prefix 路由。
 */
export interface HostConnectionLike {
	/** Host/Origin 栅栏 + 浏览器鉴权：返回 401/403 拒绝，undefined 放行。 */
	requestRejection(request: unknown): number | undefined;
	/**
	 * 精确 Fetch 路由（流式响应，如 SSE；dsh 0.1.5 起提供）。
	 * 缺失 = 旧宿主，日志视图降级为轮询。
	 */
	fetch?: {
		/** 注册一条精确 Fetch 路由；返回注销函数。 */
		register(route: HostConnectionFetchRouteLike): () => Promise<void>;
	};
}

/**
 * 会话持久化服务的最小接口（`ctx.sessionPersistence`）。
 *
 * 只用到 `open(id, 'write')`：**只申请写句柄、不注册 agent**，用来探测
 * "界面是否已经释放了这个会话"（见 bridge/chat.ts 的 probeResume）。
 * 真正的 resume 仍然走 `agents.resume`，因为 agent 必须由 dsh-agent-loop
 * 组装；这里只是把"句柄是否空闲"这件事与 agent 注册表解耦。
 */
export interface SessionPersistenceLike {
	/** 打开句柄；`write` 且句柄已被占用时抛 SessionAlreadyOwnedError。 */
	open(id: SessionId, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<{ close(): Promise<void> }>;
}

/** 插件依赖的全部 dsh 服务。 */
export interface DshServices {
	logger: Logger;
	agents: AgentRegistry;
	sessions: SessionStore;
	agentDefaultModel: AgentDefaultModelLike;
	agentPresets?: AgentPresetsLike;
	llm?: LlmServiceLike;
	/**
	 * 会话持久化服务（可选，惰性读取：可能晚于本插件装载）。
	 * 缺失 = 旧宿主，写句柄探测退化为直接重试 resume。
	 */
	getPersistence?: () => SessionPersistenceLike | undefined;
	/** 等待 dsh 插件装载完成（loader 服务）。 */
	ready: Promise<unknown>;
}
