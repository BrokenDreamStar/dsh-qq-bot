/**
 * RAG Worker：唯一写库者 + 本地嵌入/重排运行时。
 *
 * 设计：
 *  - 只依赖 Node 内置模块；`sqlite-vec` / `@huggingface/transformers` 从
 *    `<dataDir>/runtime/<hash>/node_modules` 动态解析，不写插件依赖树；
 *  - runtime/模型缺失时自动降级：node:sqlite + FTS5 仍然可用；
 *  - 所有响应带 request id；主线程按超时/重启处理。
 */

import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../../types.ts';
import { RagDatabase } from './db.ts';
import { takeChunks, type ChunkMessage } from './chunk.ts';
import { coverageOf, finalScore, normalizeScores, rrfFuse, recencyScore } from './fusion.ts';
import { normalizeDownloadProgress, createModelStatus, modelProgress, setModelDownload, setModelLoad } from './progress.ts';
import { tokenizeQuery } from '../text.ts';
import type {
	RagChunkHit,
	RagModelStatus,
	RagRecord,
	RagSkill,
	RagStatus,
	RagWorkerConfig,
	SkillDraft,
} from './types.ts';

if (parentPort === null) throw new Error('rag worker 必须在 worker_threads 中运行');
const port = parentPort;

function post(message: unknown): void {
	try {
		port.postMessage(message);
	} catch {
		// 主线程已退出
	}
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
	post({ event: 'log', level, message });
}

const logger: Logger = {
	info: message => log('info', message),
	warn: message => log('warn', message),
	error: message => log('error', message),
};

interface InitPayload {
	dataDir: string;
	runtimeDir: string;
	modelsDir: string;
	vecPath?: string;
	config: RagWorkerConfig;
}

let db: RagDatabase | undefined;
let config: RagWorkerConfig | undefined;
let runtimeDir = '';
let modelsDir = '';
let embedReady = false;
let rerankReady = false;
let dbError = '';
let models: { embedding: RagModelStatus; reranker: RagModelStatus } = {
	embedding: createModelStatus('', false),
	reranker: createModelStatus('', false),
};
let status: RagStatus = {
	ready: false,
	db: false,
	fts: false,
	vec: false,
	embed: false,
	rerank: false,
	runtime: 'missing',
	model: 'missing',
	models,
	messages: 0,
	chunks: 0,
	skills: 0,
};

const buffers = new Map<string, ChunkMessage[]>();
const embeddingQueue: Array<{ id: number; chatKey: string; text: string }> = [];
let processingEmbeddings = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = any;
let transformers: AnyModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenizer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedModel: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rerankTokenizer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rerankModel: any;

const BGE_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

/**
 * 检查本地缓存是否至少具备可加载的模型文件（配置 + ONNX 权重）。
 * 这不是“正在加载”的替代品：即使文件齐全，页面仍会单独展示加载状态。
 */
function hasModelFiles(modelId: string): boolean {
	if (modelId === '' || modelsDir === '') return false;
	const root = join(modelsDir, modelId);
	if (!existsSync(root)) return false;
	let hasConfig = false;
	let hasWeights = false;
	const walk = (dir: string, depth: number): void => {
		if (depth > 5 || (hasConfig && hasWeights)) return;
		let entries: Array<{ name: string; isDirectory(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), depth + 1);
				continue;
			}
			if (entry.name === 'config.json') hasConfig = true;
			if (entry.name.endsWith('.onnx') || entry.name.endsWith('.onnx_data')) hasWeights = true;
		}
	};
	walk(root, 0);
	return hasConfig && hasWeights;
}

function markCachedModel(model: 'embedding' | 'reranker'): void {
	const current = models[model];
	if (current.download === 'disabled' || current.download === 'ready') return;
	if (hasModelFiles(current.id)) models[model] = setModelDownload(current, 'ready');
}

function chunkOptions(): { maxMessages: number; maxChars: number; overlap: number } {
	return {
		maxMessages: config?.memoryChunkMessages ?? 4,
		maxChars: config?.memoryChunkMaxChars ?? 400,
		overlap: config?.memoryChunkOverlap ?? 1,
	};
}

function refreshStatus(): RagStatus {
	const counts = db?.stats() ?? { messages: 0, chunks: 0, skills: 0 };
	const active = config?.memoryEmbeddingEnabled === true ? models.embedding : models.reranker;
	const model =
		active.load === 'ready'
			? 'ready'
			: active.download === 'downloading' || active.load === 'loading'
				? 'downloading'
				: active.download === 'error' || active.load === 'error'
					? 'error'
					: 'missing';
	const lastError = models.embedding.error ?? models.reranker.error ?? (dbError !== '' ? dbError : undefined);
	status = {
		...status,
		ready: db !== undefined,
		db: db !== undefined,
		fts: db !== undefined,
		vec: db?.vectorReady === true,
		embed: models.embedding.load === 'ready',
		rerank: models.reranker.load === 'ready',
		messages: counts.messages,
		chunks: counts.chunks,
		skills: counts.skills,
		model,
		models,
		lastError,
	};
	return status;
}

function sendStatus(): void {
	post({ event: 'status', status: refreshStatus() });
}

function bufferFor(chatKey: string): ChunkMessage[] {
	const existing = buffers.get(chatKey);
	if (existing !== undefined) return existing;
	if (db === undefined) return [];
	const last = db.lastChunkEndSeq(chatKey);
	const rows = db.messagesAfter(chatKey, last, 200);
	const buffer: ChunkMessage[] = rows.map(row => ({
		seq: row.seq,
		ts: row.ts,
		senderName: row.senderName,
		self: row.self,
		text: row.text,
	}));
	buffers.set(chatKey, buffer);
	return buffer;
}

function enqueueEmbedding(id: number, chatKey: string, text: string): void {
	embeddingQueue.push({ id, chatKey, text });
	void processEmbeddings();
}

async function processEmbeddings(): Promise<void> {
	if (processingEmbeddings || !embedReady || db === undefined || config === undefined) return;
	processingEmbeddings = true;
	try {
		while (embeddingQueue.length > 0) {
			const batch = embeddingQueue.splice(0, Math.max(1, config.memoryEmbedBatch));
			try {
				const vectors = await embedTexts(batch.map(item => item.text));
				for (let index = 0; index < batch.length; index += 1) {
					const item = batch[index]!;
					const vector = vectors[index];
					if (vector !== undefined) {
						db.upsertChunkVector(item.id, item.chatKey, vector);
						db.markChunkEmbedded(item.id, 1);
					} else {
						db.markChunkEmbedded(item.id, 2);
					}
				}
			} catch (error) {
				logger.warn(`dsh-qq-bot: 批量嵌入失败：${error instanceof Error ? error.message : String(error)}`);
				for (const item of batch) db.markChunkEmbedded(item.id, 2);
			}
		}
	} finally {
		processingEmbeddings = false;
	}
}

async function backfill(): Promise<void> {
	if (db === undefined) return;
	const pending = db.pendingChunks(128);
	for (const item of pending) enqueueEmbedding(item.id, item.chatKey, item.text);
}

async function importTransformers(): Promise<AnyModule> {
	if (runtimeDir === '') throw new Error('runtime 未安装');
	const require = createRequire(join(runtimeDir, 'package.json'));
	const resolved = require.resolve('@huggingface/transformers');
	const mod = (await import(pathToFileURL(resolved).href)) as AnyModule;
	return mod.default ?? mod;
}

function modelProgressCallback(model: 'embedding' | 'reranker') {
	return (progress: { status?: string; file?: string; name?: string; progress?: number; loaded?: number; total?: number }): void => {
		const normalized = modelProgress(normalizeDownloadProgress(progress), model);
		if (models[model].download !== 'ready') models[model] = setModelDownload(models[model], 'downloading');
		sendStatus();
		post({ event: 'progress', progress: normalized });
	};
}

function modelErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadEmbedding(): Promise<void> {
	if (config === undefined) return;
	const id = config.memoryEmbeddingModel;
	const download = models.embedding.download === 'ready' ? 'ready' : 'downloading';
	models.embedding = { ...setModelDownload(models.embedding, download), id, load: 'loading' };
	sendStatus();
	try {
		const { AutoTokenizer, AutoModel, env } = transformers;
		env.cacheDir = modelsDir;
		env.allowRemoteModels = true;
		env.remoteHost = config.memoryHfEndpoint;
		const progress_callback = modelProgressCallback('embedding');
		const load = async (): Promise<void> => {
			tokenizer = await AutoTokenizer.from_pretrained(id, { progress_callback });
			embedModel = await AutoModel.from_pretrained(id, {
				dtype: config!.memoryEmbeddingDtype || 'int8',
				progress_callback,
			});
		};
		try {
			await load();
		} catch (direct) {
			const message = modelErrorText(direct);
			logger.warn(`dsh-qq-bot: 直连 HF 加载失败，切换镜像重试：${message}`);
			env.remoteHost = config.memoryHfMirror;
			await load();
		}
		embedReady = true;
		models.embedding = setModelLoad(setModelDownload(models.embedding, 'ready'), 'ready');
		logger.info('dsh-qq-bot: embedding 模型已下载并加载');
		sendStatus();
		void backfill();
		void processEmbeddings();
	} catch (error) {
		embedReady = false;
		const message = modelErrorText(error);
		const downloaded = hasModelFiles(id);
		models.embedding = setModelLoad(setModelDownload(models.embedding, downloaded ? 'ready' : 'error', downloaded ? undefined : message), 'error', message);
		logger.warn(`dsh-qq-bot: embedding 模型加载失败，继续 FTS-only：${message}`);
		sendStatus();
	}
}

async function loadReranker(): Promise<void> {
	if (config === undefined) return;
	const id = config.memoryRerankModel;
	const download = models.reranker.download === 'ready' ? 'ready' : 'downloading';
	models.reranker = { ...setModelDownload(models.reranker, download), id, load: 'loading' };
	sendStatus();
	try {
		const { AutoTokenizer, AutoModelForSequenceClassification, env } = transformers;
		env.cacheDir = modelsDir;
		env.remoteHost = config.memoryHfEndpoint;
		const progress_callback = modelProgressCallback('reranker');
		const load = async (): Promise<void> => {
			rerankTokenizer = await AutoTokenizer.from_pretrained(id, { progress_callback });
			rerankModel = await AutoModelForSequenceClassification.from_pretrained(id, {
				dtype: 'int8',
				progress_callback,
			});
		};
		try {
			await load();
		} catch (direct) {
			logger.warn(`dsh-qq-bot: 重排模型直连失败，切换镜像重试：${modelErrorText(direct)}`);
			env.remoteHost = config.memoryHfMirror;
			await load();
		}
		rerankReady = true;
		models.reranker = setModelLoad(setModelDownload(models.reranker, 'ready'), 'ready');
		logger.info('dsh-qq-bot: reranker 模型已下载并加载');
		sendStatus();
	} catch (error) {
		rerankReady = false;
		const message = modelErrorText(error);
		const downloaded = hasModelFiles(id);
		models.reranker = setModelLoad(setModelDownload(models.reranker, downloaded ? 'ready' : 'error', downloaded ? undefined : message), 'error', message);
		logger.warn(`dsh-qq-bot: reranker 加载失败，重排停用：${message}`);
		sendStatus();
	}
}

async function loadModels(): Promise<void> {
	if (config === undefined || db === undefined) return;
	if (!config.memoryEmbeddingEnabled && !config.memoryRerankEnabled) return;
	try {
		transformers = await importTransformers();
	} catch (error) {
		const message = `本地推理运行时不可用：${modelErrorText(error)}`;
		for (const model of ['embedding', 'reranker'] as const) {
			if (models[model].download === 'disabled') continue;
			markCachedModel(model);
			models[model] = setModelLoad(models[model], 'error', message);
		}
		logger.warn(`dsh-qq-bot: ${message}`);
		sendStatus();
		return;
	}
	if (config.memoryEmbeddingEnabled) await loadEmbedding();
	if (config.memoryRerankEnabled) await loadReranker();
}

function normalizeVector(vector: Float32Array): Float32Array {
	let sum = 0;
	for (const value of vector) sum += value * value;
	const norm = Math.sqrt(sum);
	if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
	return vector;
}

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
	if (!embedReady || tokenizer === undefined || embedModel === undefined || texts.length === 0) return [];
	const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: 512 });
	const outputs = await embedModel(inputs);
	const hidden = outputs.last_hidden_state;
	const dims = hidden.dims as number[];
	const data = hidden.data as Float32Array;
	const dim = dims[dims.length - 1]!;
	const seq = dims[dims.length - 2]!;
	const batch = dims[0]!;
	const vectors: Float32Array[] = [];
	for (let b = 0; b < batch; b += 1) {
		const offset = b * seq * dim;
		const vector = new Float32Array(dim);
		for (let d = 0; d < dim; d += 1) vector[d] = data[offset + d]!;
		vectors.push(normalizeVector(vector));
	}
	return vectors;
}

async function embedQuery(query: string): Promise<Float32Array | undefined> {
	const vectors = await embedTexts([`${BGE_QUERY_PREFIX}${query}`]);
	return vectors[0];
}

function sigmoid(value: number): number {
	return 1 / (1 + Math.exp(-value));
}

async function rerankScores(query: string, documents: string[]): Promise<number[]> {
	if (!rerankReady || rerankTokenizer === undefined || rerankModel === undefined || documents.length === 0) return [];
	const inputs = await rerankTokenizer(new Array(documents.length).fill(query), {
		text_pair: documents,
		padding: true,
		truncation: true,
		max_length: 512,
	});
	const outputs = await rerankModel(inputs);
	const logits = outputs.logits;
	const data = logits.data as Float32Array;
	return Array.from(data).map(value => sigmoid(value));
}

async function searchChunks(chatKey: string, query: string, limit: number): Promise<{ hits: RagChunkHit[]; candidates: number }> {
	if (db === undefined || config === undefined) return { hits: [], candidates: 0 };
	const fts = db.searchChunksFts(chatKey, query, 50);
	let vec: Array<{ id: number; distance: number }> = [];
	if (embedReady) {
		try {
			const vector = await embedQuery(query);
			if (vector !== undefined) vec = db.searchChunksVec(chatKey, vector, 50);
		} catch (error) {
			logger.warn(`dsh-qq-bot: 查询向量失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const fused = normalizeScores(
		rrfFuse([fts.map(item => ({ id: item.id })), vec.map(item => ({ id: item.id }))]),
	);
	const chunks = db.chunksByIds([...fused.keys()]);
	const tokens = tokenizeQuery(query);
	const now = Date.now();
	const bm25ById = new Map(fts.map(item => [item.id, item.bm25]));
	const distanceById = new Map(vec.map(item => [item.id, item.distance]));
	const hits: RagChunkHit[] = chunks.map(chunk => {
		const rrf = fused.get(chunk.id) ?? 0;
		const recency = recencyScore(chunk.ts, now, config!.memoryRecencyHalfLifeDays);
		const coverage = coverageOf(tokens, chunk.text);
		const bm25 = bm25ById.get(chunk.id);
		const distance = distanceById.get(chunk.id);
		return {
			...chunk,
			rrf,
			score: finalScore({ rrf, recency, coverage }),
			...(bm25 !== undefined ? { bm25 } : {}),
			...(distance !== undefined ? { distance } : {}),
		};
	});
	if (config.memoryRerankEnabled && rerankReady && hits.length > 0) {
		const top = hits.slice(0, Math.min(config.memoryRerankTopN, 50));
		try {
			const scores = await Promise.race([
				rerankScores(query, top.map(hit => hit.text)),
				new Promise<number[]>(resolve => setTimeout(() => resolve([]), config!.memoryRerankTimeoutMs)),
			]);
			if (scores.length === top.length) {
				for (let index = 0; index < top.length; index += 1) {
					const hit = top[index]!;
					const rerank = scores[index]!;
					hit.rerank = rerank;
					hit.score = finalScore({ rrf: hit.rrf, recency: recencyScore(hit.ts, now, config!.memoryRecencyHalfLifeDays), coverage: 0, rerank });
				}
			}
		} catch (error) {
			logger.warn(`dsh-qq-bot: 重排失败，使用融合分：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	hits.sort((a, b) => b.score - a.score);
	return { hits: hits.slice(0, Math.max(1, limit)), candidates: hits.length };
}

async function searchSkills(chatKey: string, query: string, limit: number): Promise<RagSkill[]> {
	if (db === undefined) return [];
	const fts = db.searchSkillsFts(chatKey, query, 10);
	let vec: Array<{ id: number; distance: number }> = [];
	if (embedReady) {
		try {
			const vector = await embedQuery(query);
			if (vector !== undefined) vec = db.searchSkillsVec(chatKey, vector, 10);
		} catch {
			// ignore
		}
	}
	const fused = normalizeScores(
		rrfFuse([fts.map(item => ({ id: item.id })), vec.map(item => ({ id: item.id }))]),
	);
	const all = db.listSkills(chatKey);
	const byId = new Map(all.map(skill => [skill.id, skill]));
	const ranked = [...fused.entries()]
		.map(([id, score]) => ({ skill: byId.get(id), score }))
		.filter((item): item is { skill: RagSkill; score: number } => item.skill !== undefined)
		.sort((a, b) => b.score - a.score || b.skill.useCount - a.skill.useCount)
		.slice(0, Math.max(1, limit));
	if (ranked.length > 0) return ranked.map(item => item.skill);
	return all.slice(0, Math.max(1, limit));
}

async function upsertSkill(draft: SkillDraft): Promise<RagSkill | undefined> {
	if (db === undefined) return undefined;
	const saved = db.upsertSkill(draft);
	if (saved !== undefined && embedReady) {
		try {
			const vectors = await embedTexts([`${saved.name}\n${saved.description}\n${saved.whenToUse}`]);
			if (vectors[0] !== undefined) db.upsertSkillVector(saved.id, vectors[0]);
		} catch {
			// 向量失败不影响技能落库
		}
	}
	return saved;
}

async function handleInit(payload: InitPayload): Promise<void> {
	config = payload.config;
	runtimeDir = payload.runtimeDir;
	modelsDir = payload.modelsDir;
	models = {
		embedding: createModelStatus(config.memoryEmbeddingModel, config.memoryEmbeddingEnabled),
		reranker: createModelStatus(config.memoryRerankModel, config.memoryRerankEnabled),
	};
	if (config.memoryEmbeddingEnabled) markCachedModel('embedding');
	if (config.memoryRerankEnabled) markCachedModel('reranker');
	status.runtime = runtimeDir !== '' ? 'ready' : 'missing';
	status.runtimeDir = runtimeDir;
	status.modelDir = modelsDir;
	const result = await RagDatabase.open({
		filePath: join(payload.dataDir, 'memory.db'),
		logger,
		...(payload.vecPath !== undefined ? { vecPath: payload.vecPath } : {}),
		embeddingDim: 512,
	});
	if (!result.ok || result.db === undefined) {
		dbError = result.reason ?? '打开数据库失败';
		status = { ...status, ready: false, db: false, models, lastError: dbError };
		logger.error(`dsh-qq-bot: RAG 数据库打开失败：${result.reason ?? '未知'}`);
		sendStatus();
		return;
	}
	db = result.db;
	dbError = '';
	sendStatus();
	// 仅启用重排时也必须进入模型加载；旧逻辑只看 embedding，会永远停在 missing。
	if (config.memoryEmbeddingEnabled || config.memoryRerankEnabled) void loadModels();
}

async function handleRecord(record: RagRecord): Promise<void> {
	if (db === undefined || config === undefined) return;
	const buffer = bufferFor(record.chatKey);
	const seq = db.insertMessage(record);
	if (seq === undefined) return;
	buffer.push({
		seq,
		ts: record.ts,
		senderName: record.senderName,
		self: record.self,
		text: record.text,
	});
	const { drafts, rest } = takeChunks(record.chatKey, buffer, chunkOptions(), false);
	buffers.set(record.chatKey, rest);
	for (const draft of drafts) {
		const id = db.insertChunk({
			chatKey: record.chatKey,
			startSeq: draft.startSeq,
			endSeq: draft.endSeq,
			ts: draft.ts,
			text: draft.text,
			msgCount: draft.msgCount,
			hash: draft.hash,
		});
		if (id !== undefined) enqueueEmbedding(id, record.chatKey, draft.text);
	}
}

async function handleRequest(request: Record<string, unknown>): Promise<void> {
	const id = typeof request.id === 'number' ? request.id : 0;
	const method = typeof request.method === 'string' ? request.method : '';
	try {
		if (method === 'init') {
			await handleInit(request as unknown as InitPayload);
			post({ id, ok: true, value: refreshStatus() });
			return;
		}
		if (method === 'record') {
			await handleRecord(request.event as RagRecord);
			post({ id, ok: true, value: { recorded: true } });
			return;
		}
		if (method === 'search') {
			const result = await searchChunks(String(request.chatKey ?? ''), String(request.query ?? ''), Number(request.limit ?? 20));
			post({ id, ok: true, value: result });
			return;
		}
		if (method === 'recent') {
			post({ id, ok: true, value: { hits: db?.recentChunks(String(request.chatKey ?? ''), Number(request.limit ?? 20)) ?? [] } });
			return;
		}
		if (method === 'chunks/delete') {
			const deleted = db?.deleteChunk(Number(request.chunkId ?? 0)) ?? false;
			post({ id, ok: true, value: { deleted } });
			return;
		}
		if (method === 'skills/search') {
			const skills = await searchSkills(String(request.chatKey ?? ''), String(request.query ?? ''), Number(request.limit ?? 3));
			post({ id, ok: true, value: { skills } });
			return;
		}
		if (method === 'skills/upsert') {
			const saved = await upsertSkill(request.skill as SkillDraft);
			post({ id, ok: true, value: { skill: saved ?? null } });
			return;
		}
		if (method === 'skills/get') {
			const skill = db?.getSkill(String(request.chatKey ?? ''), String(request.name ?? ''));
			if (skill !== undefined) db?.touchSkill(skill.id);
			post({ id, ok: true, value: { skill: skill ?? null } });
			return;
		}
		if (method === 'skills/list') {
			post({ id, ok: true, value: { skills: db?.listSkills(String(request.chatKey ?? ''), request.includeInactive === true) ?? [] } });
			return;
		}
		if (method === 'skills/delete') {
			const deleted = db?.deleteSkill(String(request.chatKey ?? ''), Number(request.skillId ?? 0), String(request.actor ?? 'admin')) ?? false;
			post({ id, ok: true, value: { deleted } });
			return;
		}
		if (method === 'skills/toggle') {
			const changed = db?.setSkillStatus(Number(request.skillId ?? 0), request.status as RagSkill['status']) ?? false;
			post({ id, ok: true, value: { changed } });
			return;
		}
		if (method === 'skills/tombstoned') {
			const hit =
				db?.isSkillTombstoned(
					String(request.chatKey ?? ''),
					String(request.name ?? ''),
					String(request.description ?? ''),
					String(request.whenToUse ?? ''),
					String(request.body ?? ''),
				) ?? false;
			post({ id, ok: true, value: { hit } });
			return;
		}
		if (method === 'skills/promote') {
			const skill = db?.promoteSkill(String(request.chatKey ?? ''), Number(request.skillId ?? 0));
			post({ id, ok: true, value: { skill: skill ?? null } });
			return;
		}
		if (method === 'stats') {
			post({ id, ok: true, value: refreshStatus() });
			return;
		}
		if (method === 'prune') {
			const removed = db?.prune(Date.now(), config?.memoryRetentionDays ?? 365, config?.memoryMaxMessagesPerChat ?? 50_000, config?.memoryMaxChunksPerChat ?? 20_000) ?? 0;
			sendStatus();
			post({ id, ok: true, value: { removed } });
			return;
		}
		if (method === 'reindex') {
			const chatKey = typeof request.chatKey === 'string' && request.chatKey !== '' ? request.chatKey : undefined;
			const removed = db?.reindex(chatKey) ?? 0;
			if (chatKey !== undefined) buffers.delete(chatKey);
			else buffers.clear();
			sendStatus();
			post({ id, ok: true, value: { removed } });
			return;
		}
		if (method === 'shutdown') {
			db?.close();
			db = undefined;
			post({ id, ok: true, value: { shutdown: true } });
			setTimeout(() => process.exit(0), 10);
			return;
		}
		post({ id, ok: false, error: `未知方法：${method}` });
	} catch (error) {
		post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

port.on('message', (message: unknown) => {
	if (message === null || typeof message !== 'object') return;
	void handleRequest(message as Record<string, unknown>);
});

sendStatus();
