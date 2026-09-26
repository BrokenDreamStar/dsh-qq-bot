/**
 * 记忆模块的对外装配面。
 *
 * `MemoryLike` 是**桥与工具真正依赖的最小接口**（与 dsh.ts 的 "Like" 策略一致）：
 * 这样 `bridge/chat.ts`、`pipeline/dispatcher.ts`、`tools/memory.ts` 都不需要
 * import 具体的 MemoryService 实现，单测里注入假实现也更容易。
 */
import type { Logger } from '../types.ts';
import { MemoryService, type MemoryConfigView } from './service.ts';
import { openMemoryDatabase } from './store.ts';

export interface MemoryLike {
	/** 是否可用（总开关打开且存储就绪）。 */
	readonly ready: boolean;
	/** 记一条消息（入站或机器人自己的回复）；未启用时静默忽略。 */
	record(event: {
		chatKey: string;
		generation: string;
		ts?: number;
		senderId: string;
		senderName: string;
		self?: boolean;
		kind?: 'chat' | 'reply';
		text: string;
		msgId?: string;
	}): number | undefined;
	/** 卡片 section 文本（世代内冻结；无卡片时为空串）。 */
	cardSection(chatKey: string): string;
	/** 能力提示 section 文本（工具没注册时为空串）。 */
	guidanceSection(available: boolean): string;
	/** 解除卡片冻结（世代切换时调用）。 */
	unfreeze(chatKey: string): void;
	/** 新世代第一轮：产出一次性交接块（无内容时为空串）。 */
	takeHandoff(chatKey: string, sessionId: string): Promise<string>;
	/** 每轮相关历史预取（零 LLM；不需要时为空串）。 */
	prefetch(chatKey: string, query: string): string;
	/** 世代结束（rotate/reset 前）：尽力蒸馏。 */
	onGenerationEnd(chatKey: string, options?: { force?: boolean }): Promise<void>;
	/** 每轮开始时清空写入失败计数。 */
	resetTurnWriteFailures(chatKey: string): void;
	/** 立即蒸馏（同一会话串行；返回是否真的落库了修改）。 */
	distill(chatKey: string, options?: { force?: boolean }): Promise<boolean>;
	/** 最近一次蒸馏失败的原因（`/memory distill` 直接回给用户；没失败过返回 undefined）。 */
	lastDistillError?(chatKey: string): string | undefined;
	/** 该会话的事实/档案条数（/memory 与诊断用）。 */
	chatStats(chatKey: string): { facts: number; events: number };
	/** `qq_recall_memory` 的实现。 */
	recall(chatKey: string, query: string, count?: number): { text: string; count: number; candidates: number };
	/** `qq_memorize` 的实现。 */
	memorize(input: {
		chatKey: string;
		action: 'add' | 'replace' | 'remove';
		content?: string;
		oldText?: string;
	}): { ok: true; text: string } | { ok: false; error: string; usage?: { label: string; entries: string[] } };
	/** 配置热应用（卡片缓存失效 + 按总开关打开/关闭存储）。 */
	reconfigure(): void;
	stats(): { enabled: boolean; chats: number; facts: number; events: number; rev: number };
	dispose(): void;
}

export type { MemoryConfigView };

export interface CreateMemoryOptions {
	/** 数据目录（库文件落在 `<dataDir>/memory.db`）。 */
	dataDir: string;
	config: MemoryConfigView;
	logger: Logger;
	/** 会话称呼（群 888 / 好友 12345）。 */
	labelOf: (chatKey: string) => string;
	/** 惰性读取的 dsh llm 服务（蒸馏用；缺失则自动蒸馏停用）。 */
	getLlm?: () => { stream?: unknown } | undefined;
	/** 部署默认模型（蒸馏未显式配置模型时用它）。 */
	getDefaultModel?: () => { provider?: string; model?: string } | undefined;
	/** 构造 dsh-llm 的一次性用户消息（避免本模块直接依赖 dsh-llm）。 */
	createUserMessage: (text: string) => unknown;
	/** 存储就绪状态变化（打开 / 关闭 / 打开失败）后的回调：调用方同步工具注册。 */
	onStorageChange?: () => void;
	/** 诊断痕迹的出口（接到消息日志：WebUI 卡片 + NDJSON），见 MemoryServiceDeps.note。 */
	note?: (event: string, detail: string) => void;
}

/** 创建并初始化记忆服务（总开关关着时返回一个「什么都不做」的服务实例）。 */
export async function createMemoryService(options: CreateMemoryOptions): Promise<MemoryService> {
	const service = new MemoryService({
		config: options.config,
		logger: options.logger,
		// 存储随总开关热开热关：关着启动不建库，WebUI 打开后按需创建。
		openStore: () =>
			openMemoryDatabase({
				filePath: `${options.dataDir}/memory.db`,
				logger: options.logger,
				maxEventsPerChat: options.config.memoryMaxEventsPerChat,
				retentionDays: options.config.memoryRetentionDays,
			}),
		...(options.onStorageChange !== undefined ? { onStorageChange: options.onStorageChange } : {}),
		...(options.note !== undefined ? { note: options.note } : {}),
		getLlm: options.getLlm as never,
		getDefaultModel: options.getDefaultModel,
		labelOf: options.labelOf,
		createUserMessage: options.createUserMessage as never,
		// 空闲兜底蒸馏：默认 10 分钟一次（0 = 不启用）。
		idleSweepMs: Math.max(0, Math.trunc(options.config.memoryDistillIdleMs)),
	});
	await service.openIfEnabled();
	return service;
}

export type { MemoryService };
