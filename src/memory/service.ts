/**
 * 长期记忆服务（RAG 版）：主线程门面。
 *
 * 职责：
 *  - 管理 runtime 安装与 RagClient 生命周期（热开关、重启、降级）；
 *  - 把桥/工具传入的读写请求翻译成 worker 协议；
 *  - 渲染注入块 / 工具结果（渲染器在 rag/render.ts，保证不带 QQ 号）；
 *  - 技能学习（LLM 在主线程，存储/向量在 worker）。
 *
 * 失败哲学：记忆不是关键路径。runtime 缺失、模型下载失败、worker 超时都只降级，
 * 不把异常抛回 QQ 消息主链路。
 */

import type { Logger } from '../types.ts';
import { scanSensitive } from './guard.ts';
import type { MemoryLlmView } from './llm.ts';
import { RagClient } from './rag/client.ts';
import { createModelStatus } from './rag/progress.ts';
import { renderChunkBlock, renderRecallBlock, renderSkillList } from './rag/render.ts';
import { ensureRuntime, resolveRuntimePaths, resolveVecPath, type RuntimePaths } from './rag/runtime.ts';
import type { AfterTurnInput, RagProgress, RagRecord, RagSkill, RagStatus, RagWorkerConfig, SkillDraft } from './rag/types.ts';
import { SkillLearner } from './skills/learn.ts';

/** 记忆服务对外暴露的配置视图（由 config.ts 的 DshQQConfig 满足）。 */
export interface MemoryConfigView {
	memoryEnabled: boolean;
	memoryRuntimeAutoInstall: boolean;
	memoryEmbeddingEnabled: boolean;
	memoryEmbeddingDtype: string;
	memoryHfEndpoint: string;
	memoryHfMirror: string;
	memoryRerankEnabled: boolean;
	memoryRerankModel: string;
	memoryRerankTopN: number;
	memoryRerankTimeoutMs: number;
	memoryRecallEnabled: boolean;
	memoryRecallTopK: number;
	memoryRecallMaxChars: number;
	memoryPrefetch: boolean;
	memoryPrefetchMaxItems: number;
	memoryPrefetchMinScore: number;
	memoryInjectMaxChars: number;
	memoryRecencyHalfLifeDays: number;
	memoryChunkMessages: number;
	memoryChunkMaxChars: number;
	memoryChunkOverlap: number;
	memoryRetentionDays: number;
	memoryMaxMessagesPerChat: number;
	memoryMaxChunksPerChat: number;
	memorySensitiveFilter: boolean;
	memoryInjectLog: boolean;
	memorySkillEnabled: boolean;
	memorySkillAutoLearn: boolean;
	memorySkillLearnEveryTurns: number;
	memorySkillLearnMinToolCalls: number;
	memorySkillProvider: string;
	memorySkillModel: string;
	memorySkillMaxPerChat: number;
	memorySkillInjectMaxItems: number;
	memorySkillInjectMaxChars: number;
	memorySkillAutoActivate: boolean;
	memorySkillMinConfidence: number;
	memorySkillBodyMaxChars: number;
	memoryWorkerSearchTimeoutMs: number;
	memoryWorkerIngestTimeoutMs: number;
	memoryEmbedBatch: number;
}

export interface MemoryServiceDeps {
	dataDir: string;
	config: MemoryConfigView;
	logger: Logger;
	/** 诊断痕迹（消息日志/WebUI）。 */
	note?: (event: string, detail: string) => void;
	/** 惰性读取 dsh llm（技能学习用；缺失则学习停用）。 */
	getLlm?: () => MemoryLlmView | undefined;
	/** 部署默认模型。 */
	getDefaultModel?: () => { provider?: string; model?: string } | undefined;
	/** 创建一次性用户消息（dsh-llm 的 createUserMessage）。 */
	createUserMessage: (text: string) => unknown;
	/** 存储/工具状态变化（index.ts 用来同步工具注册）。 */
	onStatusChange?: () => void;
}

const EMPTY_STATUS: RagStatus = {
	ready: false,
	db: false,
	fts: false,
	vec: false,
	embed: false,
	rerank: false,
	runtime: 'missing',
	model: 'missing',
	models: {
		embedding: createModelStatus('', false),
		reranker: createModelStatus('', false),
	},
	messages: 0,
	chunks: 0,
	skills: 0,
};

export class MemoryService {
	private client: RagClient | undefined;
	private starting: Promise<void> | undefined;
	private status: RagStatus = { ...EMPTY_STATUS };
	private installProgress: RagProgress | undefined;
	private readonly learner: SkillLearner;
	private lastPruneAt = 0;

	constructor(private readonly deps: MemoryServiceDeps) {
		this.learner = new SkillLearner({
			config: {
				enabled: deps.config.memorySkillEnabled,
				autoLearn: deps.config.memorySkillAutoLearn,
				everyTurns: deps.config.memorySkillLearnEveryTurns,
				minToolCalls: deps.config.memorySkillLearnMinToolCalls,
				provider: deps.config.memorySkillProvider,
				model: deps.config.memorySkillModel,
				autoActivate: deps.config.memorySkillAutoActivate,
				minConfidence: deps.config.memorySkillMinConfidence,
				bodyMaxChars: deps.config.memorySkillBodyMaxChars,
			},
			logger: deps.logger,
			getLlm: () => deps.getLlm?.(),
			getDefaultModel: () => deps.getDefaultModel?.(),
			createUserMessage: deps.createUserMessage,
			upsert: async draft => this.client?.upsertSkill(draft),
			listExisting: async chatKey => this.client?.listSkills(chatKey, true) ?? [],
			isTombstoned: async (chatKey, name, description, whenToUse, body) =>
				this.client?.isSkillTombstoned(chatKey, name, description, whenToUse, body) ?? false,
			...(deps.note !== undefined ? { note: deps.note } : {}),
		});
	}

	get ready(): boolean {
		return this.client?.ready === true && this.status.ready;
	}

	get currentStatus(): RagStatus {
		const progress = this.status.progress ?? this.installProgress;
		return { ...this.status, ...(progress !== undefined ? { progress } : {}) };
	}

	lastSkillError(chatKey: string): string | undefined {
		return this.learner.lastErrorOf(chatKey);
	}

	async openIfEnabled(): Promise<void> {
		if (!this.deps.config.memoryEnabled) return;
		if (this.starting !== undefined) return this.starting;
		this.starting = this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private workerConfig(): RagWorkerConfig {
		const config = this.deps.config;
		return {
			memoryEmbeddingEnabled: config.memoryEmbeddingEnabled,
			memoryEmbeddingDtype: config.memoryEmbeddingDtype,
			memoryHfEndpoint: config.memoryHfEndpoint,
			memoryHfMirror: config.memoryHfMirror,
			memoryRerankEnabled: config.memoryRerankEnabled,
			memoryRerankModel: config.memoryRerankModel,
			memoryRerankTopN: config.memoryRerankTopN,
			memoryRerankTimeoutMs: config.memoryRerankTimeoutMs,
			memoryRecallTopK: config.memoryRecallTopK,
			memoryRecallMaxChars: config.memoryRecallMaxChars,
			memoryPrefetch: config.memoryPrefetch,
			memoryPrefetchMaxItems: config.memoryPrefetchMaxItems,
			memoryPrefetchMinScore: config.memoryPrefetchMinScore,
			memoryInjectMaxChars: config.memoryInjectMaxChars,
			memoryRecencyHalfLifeDays: config.memoryRecencyHalfLifeDays,
			memoryChunkMessages: config.memoryChunkMessages,
			memoryChunkMaxChars: config.memoryChunkMaxChars,
			memoryChunkOverlap: config.memoryChunkOverlap,
			memoryRetentionDays: config.memoryRetentionDays,
			memoryMaxMessagesPerChat: config.memoryMaxMessagesPerChat,
			memoryMaxChunksPerChat: config.memoryMaxChunksPerChat,
			memorySensitiveFilter: config.memorySensitiveFilter,
			memoryInjectLog: config.memoryInjectLog,
			memorySkillEnabled: config.memorySkillEnabled,
			memorySkillInjectMaxItems: config.memorySkillInjectMaxItems,
			memorySkillInjectMaxChars: config.memorySkillInjectMaxChars,
			memoryEmbedBatch: config.memoryEmbedBatch,
			memoryWorkerSearchTimeoutMs: config.memoryWorkerSearchTimeoutMs,
			memoryWorkerIngestTimeoutMs: config.memoryWorkerIngestTimeoutMs,
		};
	}

	private async start(): Promise<void> {
		const paths = resolveRuntimePaths(this.deps.dataDir);
		await this.startClient(paths);
		if (!paths.installed && this.deps.config.memoryRuntimeAutoInstall) {
			void this.installRuntime(paths);
		}
	}

	private async startClient(paths: RuntimePaths): Promise<void> {
		const vecPath = paths.installed ? resolveVecPath(paths.dir) : undefined;
		const client = new RagClient({
			dataDir: this.deps.dataDir,
			runtimeDir: paths.installed ? paths.dir : '',
			modelsDir: paths.modelsDir,
			...(vecPath !== undefined ? { vecPath } : {}),
			config: this.workerConfig(),
			logger: this.deps.logger,
			onStatus: status => {
				const wasReady = this.status.ready;
				this.status = status;
				if (status.runtime === 'ready' || status.ready) this.installProgress = undefined;
				if (wasReady !== status.ready) this.deps.onStatusChange?.();
			},
			onLog: (level, message) => {
				if (level === 'warn') this.deps.logger.warn(message);
				else if (level === 'error') this.deps.logger.error(message);
				else this.deps.logger.info(message);
			},
			onProgress: progress => {
				this.deps.note?.('memory-progress', progress.message ?? progress.file ?? '');
			},
		});
		this.client = client;
		await client.start();
		this.status = client.currentStatus;
		this.deps.logger.info(
			`dsh-qq-bot: 长期记忆 RAG 已启动（runtime=${paths.installed ? 'ready' : 'missing'}，vec=${this.status.vec ? 'ready' : 'off'}）`,
		);
		this.deps.note?.('memory-start', `runtime=${paths.installed ? 'ready' : 'missing'}，vec=${this.status.vec ? 'ready' : 'off'}`);
	}

	private async installRuntime(paths: RuntimePaths): Promise<void> {
		this.deps.logger.info(`dsh-qq-bot: 开始安装 RAG 运行时（${paths.dir}）`);
		this.installProgress = { kind: 'install', message: '正在安装 RAG 运行时依赖…', at: Date.now() };
		const installed = await ensureRuntime({
			dataDir: this.deps.dataDir,
			logger: this.deps.logger,
			onProgress: progress => {
				this.installProgress = { kind: 'install', message: progress.message, at: Date.now() };
				this.deps.note?.('memory-progress', progress.message);
			},
		});
		if (!installed.installed) {
			this.installProgress = undefined;
			this.deps.note?.('memory-runtime-failed', '运行时安装失败，继续 FTS-only');
			return;
		}
		this.installProgress = undefined;
		const previous = this.client;
		this.client = undefined;
		await previous?.dispose();
		await this.startClient(installed);
	}

	/** 记一条消息（入站或机器人回复）；未启用/敏感内容静默忽略。 */
	record(event: RagRecord): void {
		if (this.client === undefined) return;
		const text = event.text.trim();
		if (text === '') return;
		if (this.deps.config.memorySensitiveFilter) {
			const sensitive = scanSensitive(text);
			if (!sensitive.ok) {
				this.deps.note?.('memory-skip-sensitive', `命中 ${sensitive.findings.join(',')}，未写入长期记忆`);
				return;
			}
		}
		this.client?.record({ ...event, text });
	}

	/** 每轮相关历史预取（零 LLM；未启用/无命中返回空串）。 */
	async prefetch(chatKey: string, query: string): Promise<string> {
		if (!this.ready || !this.deps.config.memoryPrefetch) return '';
		const trimmed = query.trim();
		if (trimmed === '') return '';
		const maxItems = Math.max(1, this.deps.config.memoryPrefetchMaxItems);
		const hits = await this.client?.search(chatKey, trimmed, maxItems * 3) ?? [];
		const filtered = hits
			.filter(hit => hit.score >= this.deps.config.memoryPrefetchMinScore)
			.slice(0, maxItems);
		if (filtered.length === 0) return '';
		const block = renderChunkBlock(filtered, this.deps.config.memoryInjectMaxChars);
		if (this.deps.config.memoryInjectLog) {
			this.deps.note?.(
				'memory-inject',
				`${chatKey}：${filtered.length} 条，分数 ${filtered.map(hit => hit.score.toFixed(3)).join(',')}，${block.length} 字`,
			);
		}
		return block;
	}

	/** 结构化检索（WebUI 检索测试用）。 */
	async search(chatKey: string, query: string, limit = 20): Promise<Awaited<ReturnType<RagClient['search']>>> {
		if (!this.ready) return [];
		return this.client?.search(chatKey, query, limit) ?? [];
	}

	/** `qq_recall_memory` 的实现。 */
	async recall(chatKey: string, query: string, count?: number): Promise<{ text: string; count: number; candidates: number }> {
		if (!this.ready) throw new Error('dsh-qq-bot: 长期记忆当前不可用（未启用或存储未就绪）');
		const limit = Math.max(1, Math.min(this.deps.config.memoryRecallTopK, count ?? this.deps.config.memoryRecallTopK));
		const hits = await this.client?.search(chatKey, query, limit * 3) ?? [];
		const selected = hits.slice(0, limit);
		return {
			text: renderRecallBlock(selected, this.deps.config.memoryRecallMaxChars),
			count: selected.length,
			candidates: hits.length,
		};
	}

	/** 每轮可用技能列表（未启用/无命中返回空串）。 */
	async skills(chatKey: string, query: string): Promise<string> {
		if (!this.ready || !this.deps.config.memorySkillEnabled) return '';
		const skills = await this.client?.searchSkills(chatKey, query, this.deps.config.memorySkillInjectMaxItems) ?? [];
		return renderSkillList(skills, this.deps.config.memorySkillInjectMaxChars);
	}

	/** `qq_use_skill` 的实现。 */
	async useSkill(chatKey: string, name: string): Promise<RagSkill | undefined> {
		if (!this.ready) return undefined;
		return this.client?.getSkill(chatKey, name);
	}

	async recent(chatKey: string, limit = 20): Promise<Awaited<ReturnType<RagClient['recent']>>> {
		if (!this.ready) return [];
		return this.client?.recent(chatKey, limit) ?? [];
	}

	async deleteChunk(chunkId: number): Promise<boolean> {
		return this.client?.deleteChunk(chunkId) ?? false;
	}

	async listSkills(chatKey: string, includeInactive = false): Promise<RagSkill[]> {
		if (!this.ready) return [];
		return this.client?.listSkills(chatKey, includeInactive) ?? [];
	}

	async deleteSkill(chatKey: string, skillId: number, actor: string): Promise<boolean> {
		return this.client?.deleteSkill(chatKey, skillId, actor) ?? false;
	}

	async toggleSkill(skillId: number, status: RagSkill['status']): Promise<boolean> {
		return this.client?.toggleSkill(skillId, status) ?? false;
	}

	async promoteSkill(chatKey: string, skillId: number): Promise<RagSkill | undefined> {
		return this.client?.promoteSkill(chatKey, skillId);
	}

	async saveSkill(draft: SkillDraft): Promise<RagSkill | undefined> {
		return this.client?.upsertSkill(draft);
	}

	/** 一轮结束后尝试学习技能（fire-and-forget）。 */
	afterTurn(input: AfterTurnInput): void {
		if (!this.ready) return;
		void this.learner.maybeLearn(input).catch(error => {
			this.deps.logger.warn(`dsh-qq-bot: 技能学习异常：${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async stats(): Promise<RagStatus> {
		if (this.client === undefined) return this.currentStatus;
		const status = await this.client.stats();
		if (status !== undefined) this.status = status;
		const progress = this.status.progress ?? this.installProgress;
		return { ...this.status, ...(progress !== undefined ? { progress } : {}) };
	}

	async prune(): Promise<number> {
		const removed = await this.client?.prune() ?? 0;
		this.lastPruneAt = Date.now();
		return removed;
	}

	async reindex(chatKey?: string): Promise<number> {
		return this.client?.reindex(chatKey) ?? 0;
	}

	/** 手动安装/重装 runtime（WebUI 按钮 / `/memory setup`）。 */
	async setup(): Promise<{ installed: boolean; runtimeDir: string }> {
		const installed = await ensureRuntime({
			dataDir: this.deps.dataDir,
			logger: this.deps.logger,
			onProgress: progress => this.deps.note?.('memory-progress', progress.message),
		});
		if (installed.installed) {
			const previous = this.client;
			this.client = undefined;
			await previous?.dispose();
			await this.startClient(installed);
		}
		return { installed: installed.installed, runtimeDir: installed.dir };
	}

	/** 配置热应用：开关/模型/检索参数变化后重启 worker（防抖由调用方保证）。 */
	reconfigure(): void {
		if (!this.deps.config.memoryEnabled) {
			void this.stop();
			return;
		}
		void this.restart();
	}

	private async restart(): Promise<void> {
		const previous = this.client;
		this.client = undefined;
		await previous?.dispose();
		await this.start();
	}

	private async stop(): Promise<void> {
		const previous = this.client;
		this.client = undefined;
		this.status = { ...EMPTY_STATUS };
		this.deps.onStatusChange?.();
		await previous?.dispose();
	}

	/** 定期 prune（由 index.ts 的心跳调用；每 6 小时最多一次）。 */
	async sweep(): Promise<void> {
		if (!this.ready) return;
		if (Date.now() - this.lastPruneAt < 6 * 3600_000) return;
		await this.prune();
	}

	async dispose(): Promise<void> {
		await this.stop();
	}
}

export type { MemoryLlmView, RagRecord, RagSkill, RagStatus, SkillDraft, AfterTurnInput };
