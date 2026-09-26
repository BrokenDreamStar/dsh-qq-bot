/**
 * 客户端半的最小类型面。
 *
 * dsh 的 slots / client-store / client-ui-slots 等平台模块不随 npm 发布
 * 独立类型，这里按实际用法声明结构类型（与宿主侧 "Like" 策略一致）。
 * settingsScope 契约与 dsh-client-ui-settings 的 d.ts 对齐。
 */

/** settings 命名空间的浏览器侧同步快照（dsh-client-ui-settings 契约）。 */
export interface SettingsScopeSnapshot<T> {
	status: 'loading' | 'ready' | 'unavailable';
	/** 最后一次接受的 section（schema 解析后；secret 字段已被宿主剥离）。 */
	value: T | undefined;
	/** 组合层（cordis.patch.yml / bundle 默认值），字段清除后回到这里。 */
	base: unknown;
	/** 原样 user 层；字段在此"存在"即视为已覆盖。 */
	user: unknown;
	revision: number | undefined;
	writable: boolean;
	mode: 'host' | 'memory';
}

/** settings 写入操作（dsh-settings wire 格式）。 */
export type SettingsPathOp =
	| { op: 'set'; path: string[]; value: unknown }
	| { op: 'unset'; path: string[] };

/** 一个命名空间的响应式写入口（revision fence 与失败恢复由服务内部处理）。 */
export interface SettingsScope<T> {
	getSnapshot(): SettingsScopeSnapshot<T>;
	subscribe(listener: () => void): () => void;
	mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
	set(field: string, value: unknown): Promise<void>;
	unset(field: string): Promise<void>;
}

/** settings describe 视图的最小读面（跨命名空间共享镜像，schema 内省用）。 */
export interface SettingsDescribeFaceLike {
	getSnapshot(): {
		status: 'idle' | 'loading' | 'ready' | 'unavailable';
		view?: { namespaces: readonly { ns: string; schema: unknown }[]; writable: boolean } | undefined;
	};
	subscribe(listener: () => void): () => void;
	/** 首次使用时拉一次全量 describe；已持有答案时是 no-op。 */
	ensure(): Promise<void>;
}

/** 翻译函数（ctx.locale.bind 产物）。 */
export type Translate = (key: string) => string;

/** 渲染器要求的可观察源：useSyncExternalStore 兼容即可。 */
export interface SnapshotStore<T> {
	getSnapshot(): T;
	set(next: T): void;
	subscribe(listener: () => void): () => void;
}

/** 槽位注册声明（dsh-client-ui-slots 的子集）。 */
export interface SlotSpec {
	name: string;
	/** list 槽位的稳定 id（settings.section 必填）。 */
	id?: string;
	/** list 槽位排序（settings.section 越小越靠前）。 */
	order?: number;
	/** keyed 槽位的 entryKey（settings.plugin.item 用 settings 命名空间）。 */
	key?: string;
	/** 列表项文案；函数在渲染时求值（可读 locale）。 */
	label?: string | (() => string);
	/** 声明后组件自动获得该命名空间的 `t`。 */
	locale?: string;
	/** 注入面：hooks 里每一项变成组件的 `use<Name>` 选择器 prop，其余原样。 */
	inject?: () => unknown;
}

export type SlotComponent = (props: Record<string, unknown>) => unknown;

/** 自定义 RPC 的调用结果（宿主 ConnectionRpcResult 的镜像）。 */
export type LogsRpcResult =
	| { ok: true; value: unknown }
	| { ok: false; error: { code: string; message: string } };

/** 宿主 RPC 应答的宽松读面：调用点自行判 ok 再取 value / error。 */
export interface RpcCallResult {
	ok: boolean;
	value?: unknown;
	error?: { code: string; message: string };
}

/** 宿主 /dsh-qq-bot RPC 通道的调用器（client/index.ts 注入到组件 props）。 */
export type RpcCaller = (endpoint: string, payload?: unknown) => Promise<RpcCallResult>;

/** 客户端 connection 服务（dsh-client-connection 提供的 RPC 调用面，旧宿主可能没有）。 */
export interface ClientConnectionLike {
	rpc: {
		call(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<LogsRpcResult>;
	};
}

/** 客户端 cordis 上下文（本插件用到的服务子集）。 */
export interface ClientCtx {
	slots: {
		register(spec: SlotSpec, component: SlotComponent): unknown;
		/** 声明存在后才注册；注册效果挂在本插件 fiber 上（卸载即级联注销）。 */
		inject(name: string, register: () => unknown): unknown;
	};
	locale: {
		register(ns: string, locale: string, dict: Record<string, string>): () => void;
		/** 绑定命名空间的翻译函数（调用时读当前语言；同一命名空间返回稳定引用）。 */
		bind(ns: string): Translate;
	};
	settingsScope: {
		bind<T>(spec: { namespace: string }): SettingsScope<T>;
		/** 跨命名空间 describe 镜像（旧宿主可能没有，调用前判存在）。 */
		describe?(): SettingsDescribeFaceLike;
	};
	/** 宿主 RPC 通道调用（web profile 基线服务；缺失时日志查看降级隐藏）。 */
	connection?: ClientConnectionLike;
	/** cordis effect：注册副作用并收集其返回的清理函数到本 fiber。 */
	effect(fn: () => unknown, label?: string): unknown;
}
