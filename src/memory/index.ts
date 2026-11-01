/**
 * 记忆模块的对外装配面。
 *
 * `MemoryLike` 是桥/工具/命令真正依赖的最小接口；单测可注入假实现。
 * 具体实现是 `MemoryService`（RAG worker 门面）。
 */

import type { Logger } from '../types.ts';
import type { MemoryLlmView } from './llm.ts';
import { MemoryService, type MemoryConfigView } from './service.ts';
import type { AfterTurnInput, RagRecord, RagSkill, RagStatus, SkillDraft } from './rag/types.ts';

export interface MemoryLike {
	/** 是否可用（总开关打开且 worker 已就绪）。 */
	readonly ready: boolean;
	/** 当前状态（WebUI/命令用）。 */
	readonly currentStatus?: RagStatus;
	/** 记一条消息；未启用时静默忽略。 */
	record(event: RagRecord): void;
	/** 每轮相关历史预取（无命中返回空串）。 */
	prefetch(chatKey: string, query: string): Promise<string>;
	/** `qq_recall_memory` 的实现。 */
	recall(chatKey: string, query: string, count?: number): Promise<{ text: string; count: number; candidates: number }>;
	/** 每轮可用技能列表（无命中返回空串）。 */
	skills(chatKey: string, query: string): Promise<string>;
	/** `qq_use_skill` 的实现。 */
	useSkill(chatKey: string, name: string): Promise<RagSkill | undefined>;
	listSkills?(chatKey: string, includeInactive?: boolean): Promise<RagSkill[]>;
	recent?(chatKey: string, limit?: number): Promise<Array<{ id: number; chatKey: string; startSeq: number; endSeq: number; ts: number; text: string; score: number; rrf: number }>>;
	deleteChunk?(chunkId: number): Promise<boolean>;
	setup?(): Promise<{ installed: boolean; runtimeDir: string }>;
	deleteSkill?(chatKey: string, skillId: number, actor: string): Promise<boolean>;
	toggleSkill?(skillId: number, status: RagSkill['status']): Promise<boolean>;
	promoteSkill?(chatKey: string, skillId: number): Promise<RagSkill | undefined>;
	saveSkill?(draft: SkillDraft): Promise<RagSkill | undefined>;
	/** 一轮结束后尝试学习技能（fire-and-forget）。 */
	afterTurn?(input: AfterTurnInput): void;
	/** 最近一次技能学习失败原因。 */
	lastSkillError?(chatKey: string): string | undefined;
	stats?(): Promise<RagStatus>;
	prune?(): Promise<number>;
	reindex?(chatKey?: string): Promise<number>;
	/** 配置热应用。 */
	reconfigure(): void;
	dispose(): Promise<void>;
}

export type { MemoryConfigView, MemoryLlmView, RagRecord, RagSkill, RagStatus, SkillDraft, AfterTurnInput };

export interface CreateMemoryOptions {
	/** 数据目录（库文件 `<dataDir>/memory.db`，runtime/models 也在其下）。 */
	dataDir: string;
	config: MemoryConfigView;
	logger: Logger;
	/** 诊断痕迹出口（消息日志）。 */
	note?: (event: string, detail: string) => void;
	/** 惰性读取的 dsh llm 服务（技能学习用；缺失则学习停用）。 */
	getLlm?: () => MemoryLlmView | undefined;
	/** 部署默认模型。 */
	getDefaultModel?: () => { provider?: string; model?: string } | undefined;
	/** 构造 dsh-llm 的一次性用户消息（避免本模块直接依赖 dsh-llm）。 */
	createUserMessage: (text: string) => unknown;
	/** 存储就绪状态变化（打开/关闭/失败）后的回调：调用方同步工具注册。 */
	onStatusChange?: () => void;
}

/** 创建并初始化记忆服务（总开关关着时返回一个「什么都不做」的实例）。 */
export async function createMemoryService(options: CreateMemoryOptions): Promise<MemoryService> {
	const service = new MemoryService({
		dataDir: options.dataDir,
		config: options.config,
		logger: options.logger,
		...(options.note !== undefined ? { note: options.note } : {}),
		...(options.getLlm !== undefined ? { getLlm: options.getLlm } : {}),
		...(options.getDefaultModel !== undefined ? { getDefaultModel: options.getDefaultModel } : {}),
		createUserMessage: options.createUserMessage,
		...(options.onStatusChange !== undefined ? { onStatusChange: options.onStatusChange } : {}),
	});
	await service.openIfEnabled();
	return service;
}

export type { MemoryService };
