/**
 * 本地 RAG 长期记忆的共享类型（宿主半专用，不进 client bundle）。
 *
 * 设计边界：
 *  - 只存聊天原文与 chunk，不做画像、不做事实卡、不做蒸馏；
 *  - 模型可见文本只用昵称，QQ 号只留在内部字段；
 *  - worker 是唯一写库者，主线程只通过消息协议读写。
 */

/** 写入侧的一条聊天消息。 */
export interface RagRecord {
	chatKey: string;
	sessionId: string;
	/** epoch ms */
	ts: number;
	/** 仅内部去重/审计；渲染永远不用。 */
	senderId?: string;
	/** 模型可见的昵称。 */
	senderName: string;
	self: boolean;
	kind: 'chat' | 'reply';
	text: string;
	msgId?: string;
}

/** 一个检索命中的 chunk。 */
export interface RagChunkHit {
	id: number;
	chatKey: string;
	startSeq: number;
	endSeq: number;
	ts: number;
	text: string;
	/** 最终融合分（0~1）。 */
	score: number;
	/** RRF 归一化分（0~1）。 */
	rrf: number;
	/** FTS bm25 原始分（越小越相关；没命中 FTS 时 undefined）。 */
	bm25?: number;
	/** 向量距离（越小越近；没命中向量时 undefined）。 */
	distance?: number;
	/** 重排分（0~1；未启用/未命中时 undefined）。 */
	rerank?: number;
}

/** 技能记录。 */
export interface RagSkill {
	id: number;
	chatKey: string;
	scope: 'chat' | 'global';
	name: string;
	description: string;
	whenToUse: string;
	body: string;
	tags: string;
	tools: string;
	status: 'draft' | 'active' | 'disabled' | 'archived';
	version: number;
	confidence: number;
	sourceFrom?: number;
	sourceTo?: number;
	useCount: number;
	lastUsedAt?: number;
	createdAt: number;
	updatedAt: number;
}

/** 技能草稿（生成/编辑共用）。 */
export interface SkillDraft {
	chatKey: string;
	scope?: 'chat' | 'global';
	name: string;
	description: string;
	whenToUse: string;
	body: string;
	tags?: string;
	tools?: string;
	status?: 'draft' | 'active' | 'disabled' | 'archived';
	confidence?: number;
	sourceFrom?: number;
	sourceTo?: number;
}

/** 下载/安装/嵌入进度（WebUI 进度条用）。 */
export interface RagProgress {
	kind: 'install' | 'download' | 'embed' | 'rerank';
	message?: string;
	file?: string;
	/** 进度所属模型；安装/嵌入时缺省。 */
	model?: 'embedding' | 'reranker';
	/** 0~100；拿不到时 undefined（WebUI 显示不确定进度）。 */
	percent?: number;
	loaded?: number;
	total?: number;
	at: number;
}

export type RagDownloadState = 'disabled' | 'missing' | 'downloading' | 'ready' | 'error';
export type RagLoadState = 'disabled' | 'missing' | 'loading' | 'ready' | 'error';

/** 单个本地模型的两阶段状态：文件下载与运行时加载互不混淆。 */
export interface RagModelStatus {
	id: string;
	download: RagDownloadState;
	load: RagLoadState;
	error?: string;
}

/** 运行时/模型/数据库状态（WebUI 与日志用）。 */
export interface RagStatus {
	ready: boolean;
	db: boolean;
	fts: boolean;
	vec: boolean;
	embed: boolean;
	rerank: boolean;
	runtime: 'missing' | 'installing' | 'ready' | 'error';
	/** 旧版聚合字段，保留兼容；新页面读取 models。 */
	model: 'missing' | 'downloading' | 'ready' | 'error';
	/** 向量与重排模型各自独立的文件/加载状态。 */
	models: {
		embedding: RagModelStatus;
		reranker: RagModelStatus;
	};
	messages: number;
	chunks: number;
	skills: number;
	lastError?: string;
	/** 运行时目录（仅宿主面展示，不发给模型）。 */
	runtimeDir?: string;
	modelDir?: string;
	/** 当前下载/安装进度；空闲时 undefined。 */
	progress?: RagProgress;
}

/** 检索结果（工具/命令用）。 */
export interface RagRecallResult {
	text: string;
	count: number;
	candidates: number;
}

/** 一轮结束后交给技能学习器的上下文。 */
export interface AfterTurnInput {
	chatKey: string;
	sessionId: string;
	userText: string;
	assistantText: string;
	toolCalls: Array<{ name: string; argsPreview?: string }>;
	ok: boolean;
}

/** worker 初始化配置（只传 RAG 相关字段）。 */
export interface RagWorkerConfig {
	memoryEmbeddingEnabled: boolean;
	memoryEmbeddingModel: string;
	memoryEmbeddingDtype: string;
	memoryHfEndpoint: string;
	memoryHfMirror: string;
	memoryRerankEnabled: boolean;
	memoryRerankModel: string;
	memoryRerankTopN: number;
	memoryRerankTimeoutMs: number;
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
	memorySkillInjectMaxItems: number;
	memorySkillInjectMaxChars: number;
	memoryEmbedBatch: number;
	memoryWorkerSearchTimeoutMs: number;
	memoryWorkerIngestTimeoutMs: number;
}
