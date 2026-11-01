/**
 * RAG 持久化层：node:sqlite + FTS5 + 可选 sqlite-vec。
 *
 * 只有 worker 打开这个库；主线程不直接访问，避免 WAL 双写。
 * sqlite-vec 未加载/加载失败时，所有向量方法返回空，FTS 仍然可用。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../../types.ts';
import { contentHash, segmentText, tokenizeQuery } from '../text.ts';
import { migrateLegacyRagSchema, RAG_SCHEMA_SQL, RAG_SCHEMA_VERSION, RAG_VEC_SCHEMA_SQL, type SqliteLike } from './schema.ts';
import type { RagChunkHit, RagRecord, RagSkill, SkillDraft } from './types.ts';

interface SqliteStatement {
	run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
}

interface SqliteDatabase extends SqliteLike {
	prepare(sql: string): SqliteStatement;
	close(): void;
	enableLoadExtension?(allow: boolean): void;
	loadExtension?(path: string, entryPoint?: string): void;
}

interface SqliteModule {
	DatabaseSync: new (
		path: string,
		options?: { allowExtension?: boolean; timeout?: number; readBigInts?: boolean },
	) => SqliteDatabase;
}

export interface RagDatabaseOptions {
	filePath: string;
	logger: Logger;
	/** sqlite-vec 的 dylib/so/dll 路径；undefined = 不启用向量。 */
	vecPath?: string;
	/** 每个 chunk 的维度（bge-small-zh-v1.5 = 512）。 */
	embeddingDim?: number;
}

export interface RagDatabaseOpenResult {
	ok: boolean;
	reason?: string;
	db?: RagDatabase;
}

interface ChunkRow {
	id: number;
	chat_key: string;
	start_seq: number;
	end_seq: number;
	ts: number;
	text: string;
	embed_status: number;
}

interface SkillRow {
	id: number;
	chat_key: string;
	scope: string;
	name: string;
	description: string;
	when_to_use: string;
	body: string;
	tags: string;
	tools: string;
	status: string;
	version: number;
	confidence: number;
	source_from: number | null;
	source_to: number | null;
	use_count: number;
	last_used_at: number | null;
	created_at: number;
	updated_at: number;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'bigint' ? Number(value) : fallback;
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function rowToChunk(row: unknown): ChunkRow {
	const record = (row ?? {}) as Record<string, unknown>;
	return {
		id: asNumber(record.id),
		chat_key: asString(record.chat_key),
		start_seq: asNumber(record.start_seq),
		end_seq: asNumber(record.end_seq),
		ts: asNumber(record.ts),
		text: asString(record.text),
		embed_status: asNumber(record.embed_status),
	};
}

function rowToSkill(row: unknown): RagSkill {
	const record = (row ?? {}) as Record<string, unknown>;
	const scope = record.scope === 'global' ? 'global' : 'chat';
	const status = ['draft', 'active', 'disabled', 'archived'].includes(String(record.status))
		? (String(record.status) as RagSkill['status'])
		: 'active';
	return {
		id: asNumber(record.id),
		chatKey: asString(record.chat_key),
		scope,
		name: asString(record.name),
		description: asString(record.description),
		whenToUse: asString(record.when_to_use),
		body: asString(record.body),
		tags: asString(record.tags),
		tools: asString(record.tools),
		status,
		version: asNumber(record.version, 1),
		confidence: asNumber(record.confidence, 0.7),
		sourceFrom: record.source_from === null || record.source_from === undefined ? undefined : asNumber(record.source_from),
		sourceTo: record.source_to === null || record.source_to === undefined ? undefined : asNumber(record.source_to),
		useCount: asNumber(record.use_count),
		lastUsedAt: record.last_used_at === null || record.last_used_at === undefined ? undefined : asNumber(record.last_used_at),
		createdAt: asNumber(record.created_at),
		updatedAt: asNumber(record.updated_at),
	};
}

function vectorBlob(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function buildMatchExpression(tokens: readonly string[]): string {
	return tokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

export class RagDatabase {
	private vecReady = false;
	private vecPartitioned = false;
	private closed = false;

	private constructor(
		private readonly db: SqliteDatabase,
		private readonly logger: Logger,
		private readonly embeddingDim: number,
	) {}

	static async open(options: RagDatabaseOptions): Promise<RagDatabaseOpenResult> {
		let module: SqliteModule;
		try {
			module = (await import('node:sqlite')) as unknown as SqliteModule;
		} catch (error) {
			return { ok: false, reason: `当前 Node 没有 node:sqlite：${error instanceof Error ? error.message : String(error)}` };
		}
		try {
			mkdirSync(dirname(options.filePath), { recursive: true });
		} catch (error) {
			return { ok: false, reason: `无法创建数据目录：${error instanceof Error ? error.message : String(error)}` };
		}
		let db: SqliteDatabase;
		try {
			db = new module.DatabaseSync(options.filePath, { allowExtension: true, timeout: 5000 });
		} catch (error) {
			return { ok: false, reason: `打开 ${options.filePath} 失败：${error instanceof Error ? error.message : String(error)}` };
		}
		try {
			db.exec('PRAGMA journal_mode = WAL');
			db.exec('PRAGMA synchronous = NORMAL');
			db.exec('PRAGMA foreign_keys = ON');
			const migration = migrateLegacyRagSchema(db);
			if (migration.droppedProfileTables.length > 0 || migration.renamedEvents) {
				options.logger.info(
					`dsh-qq-bot: RAG 迁移完成（drop=${migration.droppedProfileTables.join(',') || 'none'}，renameEvents=${migration.renamedEvents}）`,
				);
			}
			db.exec(RAG_SCHEMA_SQL);
			db.prepare('INSERT OR REPLACE INTO rag_meta(key, value) VALUES (?, ?)').run('schema_version', RAG_SCHEMA_VERSION);
			const database = new RagDatabase(db, options.logger, Math.max(1, options.embeddingDim ?? 512));
			database.vecReady = database.tryLoadVec(options.vecPath);
			if (database.vecReady) database.ensureVecSchema();
			db.prepare('INSERT OR REPLACE INTO rag_meta(key, value) VALUES (?, ?)').run('vec_ready', database.vecReady ? '1' : '0');
			return { ok: true, db: database };
		} catch (error) {
			try {
				db.close();
			} catch {
				// ignore
			}
			return { ok: false, reason: `初始化 RAG 表失败：${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private tryLoadVec(vecPath: string | undefined): boolean {
		if (!vecPath) return false;
		if (typeof this.db.enableLoadExtension !== 'function' || typeof this.db.loadExtension !== 'function') {
			this.logger.warn('dsh-qq-bot: node:sqlite 没有 loadExtension，向量检索停用（FTS 仍可用）');
			return false;
		}
		try {
			this.db.enableLoadExtension(true);
			this.db.loadExtension(vecPath);
			this.logger.info(`dsh-qq-bot: sqlite-vec 已加载（${vecPath}）`);
			return true;
		} catch (first) {
			// 某些平台 loadExtension 会自动补后缀；再试一次去掉后缀的路径。
			const stripped = vecPath.replace(/\.(dylib|so|dll)$/i, '');
			if (stripped !== vecPath) {
				try {
					this.db.loadExtension(stripped);
					this.logger.info(`dsh-qq-bot: sqlite-vec 已加载（${stripped}）`);
					return true;
				} catch {
					// fall through
				}
			}
			this.logger.warn(
				`dsh-qq-bot: sqlite-vec 加载失败，向量检索停用（FTS 仍可用）：${first instanceof Error ? first.message : String(first)}`,
			);
			return false;
		}
	}

	private ensureVecSchema(): void {
		try {
			this.db.exec(RAG_VEC_SCHEMA_SQL);
			this.vecPartitioned = true;
		} catch (error) {
			// 老版本 sqlite-vec 可能不支持 partition key：退化为全局 KNN + SQL 过滤。
			try {
				this.db.exec(`
					CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunk_vec USING vec0(
						chunk_id INTEGER PRIMARY KEY,
						embedding float[${this.embeddingDim}] distance_metric=cosine
					);
					CREATE VIRTUAL TABLE IF NOT EXISTS rag_skill_vec USING vec0(
						skill_id INTEGER PRIMARY KEY,
						embedding float[${this.embeddingDim}] distance_metric=cosine
					);
				`);
				this.vecPartitioned = false;
				this.logger.warn(
					`dsh-qq-bot: sqlite-vec 不支持 partition key，退化为全局 KNN + chatKey 过滤：${error instanceof Error ? error.message : String(error)}`,
				);
			} catch (second) {
				this.vecReady = false;
				this.logger.warn(
					`dsh-qq-bot: 向量表创建失败，向量检索停用：${second instanceof Error ? second.message : String(second)}`,
				);
			}
		}
	}

	get vectorReady(): boolean {
		return this.vecReady;
	}

	/** 插入一条消息，返回自增 seq；重复 msg_id 返回 undefined。 */
	insertMessage(record: RagRecord): number | undefined {
		const now = Date.now();
		try {
			const result = this.db
				.prepare(
					`INSERT INTO rag_messages(chat_key, session_id, ts, sender_id, sender_name, self, kind, text, text_seg, msg_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					record.chatKey,
					record.sessionId,
					record.ts,
					record.senderId ?? null,
					record.senderName,
					record.self ? 1 : 0,
					record.kind,
					record.text,
					segmentText(record.text),
					record.msgId ?? null,
					now,
				);
			return asNumber(result.lastInsertRowid);
		} catch (error) {
			// 唯一索引冲突 = 重复消息；其它错误只记日志。
			const message = error instanceof Error ? error.message : String(error);
			if (!/UNIQUE|constraint/i.test(message)) {
				this.logger.warn(`dsh-qq-bot: RAG 写入消息失败：${message}`);
			}
			return undefined;
		}
	}

	insertChunk(input: {
		chatKey: string;
		startSeq: number;
		endSeq: number;
		ts: number;
		text: string;
		msgCount: number;
		hash: string;
	}): number | undefined {
		try {
			const result = this.db
				.prepare(
					`INSERT INTO rag_chunks(chat_key, start_seq, end_seq, ts, text, text_seg, hash, msg_count, embed_status, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
				)
				.run(
					input.chatKey,
					input.startSeq,
					input.endSeq,
					input.ts,
					input.text,
					segmentText(input.text),
					input.hash,
					input.msgCount,
					Date.now(),
				);
			return asNumber(result.lastInsertRowid);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/UNIQUE|constraint/i.test(message)) {
				this.logger.warn(`dsh-qq-bot: RAG 写入 chunk 失败：${message}`);
			}
			return undefined;
		}
	}

	searchChunksFts(chatKey: string, query: string, limit: number): Array<{ id: number; bm25: number }> {
		const tokens = tokenizeQuery(query);
		if (tokens.length === 0) return [];
		const match = buildMatchExpression(tokens);
		try {
			const rows = this.db
				.prepare(
					`SELECT c.id AS id, bm25(rag_chunks_fts) AS bm25
					 FROM rag_chunks_fts JOIN rag_chunks c ON c.id = rag_chunks_fts.rowid
					 WHERE rag_chunks_fts MATCH ? AND c.chat_key = ?
					 ORDER BY bm25 LIMIT ?`,
				)
				.all(match, chatKey, Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
			return rows.map(row => ({ id: asNumber(row.id), bm25: asNumber(row.bm25) })).filter(row => row.id > 0);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: RAG FTS 查询失败：${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	searchChunksVec(chatKey: string, vector: Float32Array, limit: number): Array<{ id: number; distance: number }> {
		if (!this.vecReady) return [];
		const k = Math.max(1, Math.trunc(limit));
		try {
			const blob = vectorBlob(vector);
			if (this.vecPartitioned) {
				const rows = this.db
					.prepare(
						`SELECT chunk_id, distance FROM rag_chunk_vec
						 WHERE chat_key = ? AND embedding MATCH ? AND k = ?
						 ORDER BY distance`,
					)
					.all(chatKey, blob, BigInt(k)) as Array<Record<string, unknown>>;
				return rows.map(row => ({ id: asNumber(row.chunk_id), distance: asNumber(row.distance) })).filter(row => row.id > 0);
			}
			const rows = this.db
				.prepare(
					`SELECT v.chunk_id AS chunk_id, v.distance AS distance
					 FROM rag_chunk_vec v JOIN rag_chunks c ON c.id = v.chunk_id
					 WHERE v.embedding MATCH ? AND k = ? AND c.chat_key = ?
					 ORDER BY v.distance`,
				)
				.all(blob, BigInt(k * 4), chatKey) as Array<Record<string, unknown>>;
			return rows.map(row => ({ id: asNumber(row.chunk_id), distance: asNumber(row.distance) })).filter(row => row.id > 0);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: RAG 向量查询失败：${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	chunksByIds(ids: readonly number[]): RagChunkHit[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => '?').join(',');
		try {
			const rows = this.db
				.prepare(
					`SELECT id, chat_key, start_seq, end_seq, ts, text, embed_status
					 FROM rag_chunks WHERE id IN (${placeholders})`,
				)
				.all(...ids) as unknown[];
			const byId = new Map<number, ChunkRow>();
			for (const row of rows) {
				const chunk = rowToChunk(row);
				byId.set(chunk.id, chunk);
			}
			return ids
				.map(id => byId.get(id))
				.filter((chunk): chunk is ChunkRow => chunk !== undefined)
				.map(chunk => ({
					id: chunk.id,
					chatKey: chunk.chat_key,
					startSeq: chunk.start_seq,
					endSeq: chunk.end_seq,
					ts: chunk.ts,
					text: chunk.text,
					score: 0,
					rrf: 0,
				}));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: RAG 读取 chunk 失败：${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	deleteChunk(id: number): boolean {
		try {
			if (this.vecReady) this.db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_id = ?').run(id);
			const result = this.db.prepare('DELETE FROM rag_chunks WHERE id = ?').run(id);
			return asNumber(result.changes) > 0;
		} catch {
			return false;
		}
	}

	recentChunks(chatKey: string, limit: number): RagChunkHit[] {
		try {
			const rows = this.db
				.prepare(
					`SELECT id, chat_key, start_seq, end_seq, ts, text, embed_status
					 FROM rag_chunks WHERE chat_key = ? ORDER BY id DESC LIMIT ?`,
				)
				.all(chatKey, Math.max(1, Math.trunc(limit))) as unknown[];
			return rows.map(row => {
				const chunk = rowToChunk(row);
				return {
					id: chunk.id,
					chatKey: chunk.chat_key,
					startSeq: chunk.start_seq,
					endSeq: chunk.end_seq,
					ts: chunk.ts,
					text: chunk.text,
					score: 0,
					rrf: 0,
				};
			});
		} catch {
			return [];
		}
	}

	pendingChunks(limit: number): Array<{ id: number; chatKey: string; text: string; attempts: number }> {
		try {
			const rows = this.db
				.prepare(
					`SELECT id, chat_key, text, embed_attempts FROM rag_chunks
					 WHERE embed_status = 0 AND embed_attempts < 3
					 ORDER BY id LIMIT ?`,
				)
				.all(Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
			return rows.map(row => ({
				id: asNumber(row.id),
				chatKey: asString(row.chat_key),
				text: asString(row.text),
				attempts: asNumber(row.embed_attempts),
			}));
		} catch {
			return [];
		}
	}

	markChunkEmbedded(id: number, status: 1 | 2): void {
		try {
			this.db.prepare('UPDATE rag_chunks SET embed_status = ?, embed_attempts = embed_attempts + 1 WHERE id = ?').run(status, id);
		} catch {
			// ignore
		}
	}

	upsertChunkVector(chunkId: number, chatKey: string, vector: Float32Array): void {
		if (!this.vecReady) return;
		try {
			const blob = vectorBlob(vector);
			if (this.vecPartitioned) {
				this.db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_id = ?').run(chunkId);
				this.db.prepare('INSERT INTO rag_chunk_vec(chat_key, chunk_id, embedding) VALUES (?, ?, ?)').run(chatKey, BigInt(chunkId), blob);
			} else {
				this.db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_id = ?').run(chunkId);
				this.db.prepare('INSERT INTO rag_chunk_vec(chunk_id, embedding) VALUES (?, ?)').run(BigInt(chunkId), blob);
			}
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 写入 chunk 向量失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	chatKeys(): string[] {
		try {
			const rows = this.db.prepare('SELECT DISTINCT chat_key FROM rag_messages').all() as Array<{ chat_key?: unknown }>;
			return rows.map(row => asString(row.chat_key)).filter(key => key !== '');
		} catch {
			return [];
		}
	}

	lastChunkEndSeq(chatKey: string): number {
		try {
			const row = this.db.prepare('SELECT MAX(end_seq) AS maxSeq FROM rag_chunks WHERE chat_key = ?').get(chatKey) as
				| { maxSeq?: unknown }
				| undefined;
			return asNumber(row?.maxSeq, 0);
		} catch {
			return 0;
		}
	}

	messagesAfter(chatKey: string, afterSeq: number, limit: number): Array<{
		seq: number;
		ts: number;
		senderName: string;
		self: boolean;
		text: string;
	}> {
		try {
			const rows = this.db
				.prepare(
					`SELECT seq, ts, sender_name, self, text FROM rag_messages
					 WHERE chat_key = ? AND seq > ? ORDER BY seq LIMIT ?`,
				)
				.all(chatKey, afterSeq, Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
			return rows.map(row => ({
				seq: asNumber(row.seq),
				ts: asNumber(row.ts),
				senderName: asString(row.sender_name),
				self: asNumber(row.self) === 1,
				text: asString(row.text),
			}));
		} catch {
			return [];
		}
	}

	upsertSkill(draft: SkillDraft, now = Date.now()): RagSkill | undefined {
		const chatKey = draft.scope === 'global' ? '' : draft.chatKey;
		const scope = draft.scope === 'global' ? 'global' : 'chat';
		const hash = contentHash(`${chatKey}\u0000${draft.name}\u0000${draft.description}\u0000${draft.whenToUse}\u0000${draft.body}`);
		try {
			const existing = this.db.prepare('SELECT * FROM rag_skills WHERE chat_key = ? AND name = ?').get(chatKey, draft.name) as
				| SkillRow
				| undefined;
			if (existing !== undefined) {
				this.db
					.prepare(
						`UPDATE rag_skills SET description = ?, when_to_use = ?, body = ?, tags = ?, tools = ?,
						 status = ?, confidence = ?, version = version + 1, content_hash = ?,
						 name_seg = ?, description_seg = ?, when_seg = ?, body_seg = ?, updated_at = ?
						 WHERE id = ?`,
					)
					.run(
						draft.description,
						draft.whenToUse,
						draft.body,
						draft.tags ?? '',
						draft.tools ?? '',
						draft.status ?? existing.status,
						draft.confidence ?? existing.confidence,
						hash,
						segmentText(draft.name),
						segmentText(draft.description),
						segmentText(draft.whenToUse),
						segmentText(draft.body),
						now,
						existing.id,
					);
				return this.getSkillById(existing.id);
			}
			const result = this.db
				.prepare(
					`INSERT INTO rag_skills(chat_key, scope, name, description, when_to_use, body, tags, tools, status, version, confidence,
					 source_from, source_to, use_count, content_hash, name_seg, description_seg, when_seg, body_seg, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					chatKey,
					scope,
					draft.name,
					draft.description,
					draft.whenToUse,
					draft.body,
					draft.tags ?? '',
					draft.tools ?? '',
					draft.status ?? 'active',
					draft.confidence ?? 0.7,
					draft.sourceFrom ?? null,
					draft.sourceTo ?? null,
					hash,
					segmentText(draft.name),
					segmentText(draft.description),
					segmentText(draft.whenToUse),
					segmentText(draft.body),
					now,
					now,
				);
			return this.getSkillById(asNumber(result.lastInsertRowid));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 写入技能失败：${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	getSkillById(id: number): RagSkill | undefined {
		try {
			const row = this.db.prepare('SELECT * FROM rag_skills WHERE id = ?').get(id) as SkillRow | undefined;
			return row === undefined ? undefined : rowToSkill(row);
		} catch {
			return undefined;
		}
	}

	getSkill(chatKey: string, name: string): RagSkill | undefined {
		try {
			const row = this.db
				.prepare("SELECT * FROM rag_skills WHERE name = ? AND (chat_key = ? OR scope = 'global') AND status = 'active' ORDER BY scope = 'chat' DESC LIMIT 1")
				.get(name, chatKey) as SkillRow | undefined;
			return row === undefined ? undefined : rowToSkill(row);
		} catch {
			return undefined;
		}
	}

	listSkills(chatKey: string, includeInactive = false): RagSkill[] {
		try {
			const rows = this.db
				.prepare(
					`SELECT * FROM rag_skills
					 WHERE (chat_key = ? OR scope = 'global') ${includeInactive ? '' : "AND status = 'active'"}
					 ORDER BY status = 'active' DESC, use_count DESC, updated_at DESC`,
				)
				.all(chatKey) as SkillRow[];
			return rows.map(rowToSkill);
		} catch {
			return [];
		}
	}

	searchSkillsFts(chatKey: string, query: string, limit: number): Array<{ id: number; bm25: number }> {
		const tokens = tokenizeQuery(query);
		if (tokens.length === 0) return [];
		try {
			const rows = this.db
				.prepare(
					`SELECT s.id AS id, bm25(rag_skills_fts) AS bm25
					 FROM rag_skills_fts JOIN rag_skills s ON s.id = rag_skills_fts.rowid
					 WHERE rag_skills_fts MATCH ? AND (s.chat_key = ? OR s.scope = 'global') AND s.status = 'active'
					 ORDER BY bm25 LIMIT ?`,
				)
				.all(buildMatchExpression(tokens), chatKey, Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
			return rows.map(row => ({ id: asNumber(row.id), bm25: asNumber(row.bm25) })).filter(row => row.id > 0);
		} catch {
			return [];
		}
	}

	searchSkillsVec(chatKey: string, vector: Float32Array, limit: number): Array<{ id: number; distance: number }> {
		if (!this.vecReady) return [];
		try {
			const rows = this.db
				.prepare(
					`SELECT v.skill_id AS id, v.distance AS distance
					 FROM rag_skill_vec v JOIN rag_skills s ON s.id = v.skill_id
					 WHERE v.embedding MATCH ? AND k = ? AND (s.chat_key = ? OR s.scope = 'global') AND s.status = 'active'
					 ORDER BY v.distance`,
				)
				.all(vectorBlob(vector), BigInt(Math.max(1, Math.trunc(limit)) * 4), chatKey) as Array<Record<string, unknown>>;
			return rows.map(row => ({ id: asNumber(row.id), distance: asNumber(row.distance) })).filter(row => row.id > 0);
		} catch {
			return [];
		}
	}

	upsertSkillVector(skillId: number, vector: Float32Array): void {
		if (!this.vecReady) return;
		try {
			this.db.prepare('DELETE FROM rag_skill_vec WHERE skill_id = ?').run(skillId);
			this.db.prepare('INSERT INTO rag_skill_vec(skill_id, embedding) VALUES (?, ?)').run(BigInt(skillId), vectorBlob(vector));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 写入技能向量失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	touchSkill(id: number, now = Date.now()): void {
		try {
			this.db.prepare('UPDATE rag_skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(now, id);
		} catch {
			// ignore
		}
	}

	setSkillStatus(id: number, status: RagSkill['status']): boolean {
		try {
			const result = this.db.prepare('UPDATE rag_skills SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
			return asNumber(result.changes) > 0;
		} catch {
			return false;
		}
	}

	/** 把会话技能复制为全局技能（同名全局技能已存在则覆盖）。 */
	promoteSkill(chatKey: string, id: number): RagSkill | undefined {
		try {
			const row = this.db.prepare('SELECT * FROM rag_skills WHERE id = ? AND chat_key = ?').get(id, chatKey) as SkillRow | undefined;
			if (row === undefined) return undefined;
			const existing = this.db.prepare("SELECT id FROM rag_skills WHERE chat_key = '' AND name = ?").get(row.name) as
				| { id?: unknown }
				| undefined;
			const now = Date.now();
			if (existing !== undefined) {
				this.db
					.prepare(
						`UPDATE rag_skills SET description = ?, when_to_use = ?, body = ?, tags = ?, tools = ?,
						 status = 'active', confidence = ?, updated_at = ?, name_seg = ?, description_seg = ?, when_seg = ?, body_seg = ?
						 WHERE id = ?`,
					)
					.run(
						row.description,
						row.when_to_use,
						row.body,
						row.tags,
						row.tools,
						row.confidence,
						now,
						segmentText(row.name),
						segmentText(row.description),
						segmentText(row.when_to_use),
						segmentText(row.body),
						asNumber(existing.id),
					);
				return this.getSkillById(asNumber(existing.id));
			}
			const result = this.db
				.prepare(
					`INSERT INTO rag_skills(chat_key, scope, name, description, when_to_use, body, tags, tools, status, version, confidence,
					 source_from, source_to, use_count, content_hash, name_seg, description_seg, when_seg, body_seg, created_at, updated_at)
					 VALUES ('', 'global', ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					row.name,
					row.description,
					row.when_to_use,
					row.body,
					row.tags,
					row.tools,
					row.confidence,
					row.source_from,
					row.source_to,
					contentHash(`${row.name}\u0000${row.description}\u0000${row.when_to_use}\u0000${row.body}`),
					segmentText(row.name),
					segmentText(row.description),
					segmentText(row.when_to_use),
					segmentText(row.body),
					now,
					now,
				);
			return this.getSkillById(asNumber(result.lastInsertRowid));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 提升技能失败：${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	deleteSkill(chatKey: string, id: number, actor: string): boolean {
		try {
			const row = this.db.prepare('SELECT * FROM rag_skills WHERE id = ? AND (chat_key = ? OR scope = ?)').get(id, chatKey, 'global') as
				| SkillRow
				| undefined;
			if (row === undefined) return false;
			if (this.vecReady) this.db.prepare('DELETE FROM rag_skill_vec WHERE skill_id = ?').run(id);
			this.db.prepare('DELETE FROM rag_skills WHERE id = ?').run(id);
			const hash = contentHash(`${row.chat_key}\u0000${row.name}\u0000${row.description}\u0000${row.when_to_use}\u0000${row.body}`);
			this.db
				.prepare('INSERT OR REPLACE INTO rag_skill_tombstones(content_hash, chat_key, deleted_at, deleted_by) VALUES (?, ?, ?, ?)')
				.run(hash, row.chat_key, Date.now(), actor);
			return true;
		} catch {
			return false;
		}
	}

	isSkillTombstoned(chatKey: string, name: string, description: string, whenToUse: string, body: string): boolean {
		try {
			const hash = contentHash(`${chatKey}\u0000${name}\u0000${description}\u0000${whenToUse}\u0000${body}`);
			const row = this.db.prepare('SELECT 1 AS hit FROM rag_skill_tombstones WHERE content_hash = ?').get(hash) as
				| { hit?: number }
				| undefined;
			return row?.hit === 1;
		} catch {
			return false;
		}
	}

	stats(): { messages: number; chunks: number; skills: number } {
		try {
			const messages = asNumber((this.db.prepare('SELECT COUNT(*) AS n FROM rag_messages').get() as { n?: unknown })?.n);
			const chunks = asNumber((this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as { n?: unknown })?.n);
			const skills = asNumber((this.db.prepare('SELECT COUNT(*) AS n FROM rag_skills').get() as { n?: unknown })?.n);
			return { messages, chunks, skills };
		} catch {
			return { messages: 0, chunks: 0, skills: 0 };
		}
	}

	prune(now: number, retentionDays: number, maxMessagesPerChat: number, maxChunksPerChat: number): number {
		let removed = 0;
		const cutoff = now - Math.max(1, retentionDays) * 86_400_000;
		try {
			const chunks = this.db.prepare('DELETE FROM rag_chunks WHERE ts < ?').run(cutoff);
			removed += asNumber(chunks.changes);
			const messages = this.db.prepare('DELETE FROM rag_messages WHERE ts < ?').run(cutoff);
			removed += asNumber(messages.changes);
			// 孤儿向量
			if (this.vecReady) {
				try {
					this.db.exec('DELETE FROM rag_chunk_vec WHERE chunk_id NOT IN (SELECT id FROM rag_chunks)');
					this.db.exec('DELETE FROM rag_skill_vec WHERE skill_id NOT IN (SELECT id FROM rag_skills)');
				} catch {
					// ignore
				}
			}
			const chats = this.db.prepare('SELECT DISTINCT chat_key FROM rag_messages').all() as Array<{ chat_key?: unknown }>;
			for (const chat of chats) {
				const chatKey = asString(chat.chat_key);
				const count = asNumber(
					(this.db.prepare('SELECT COUNT(*) AS n FROM rag_messages WHERE chat_key = ?').get(chatKey) as { n?: unknown })?.n,
				);
				if (count > maxMessagesPerChat) {
					const result = this.db
						.prepare(
							`DELETE FROM rag_messages WHERE seq IN (
								SELECT seq FROM rag_messages WHERE chat_key = ? ORDER BY seq ASC LIMIT ?
							)`,
						)
						.run(chatKey, count - maxMessagesPerChat);
					removed += asNumber(result.changes);
				}
				const chunkCount = asNumber(
					(this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE chat_key = ?').get(chatKey) as { n?: unknown })?.n,
				);
				if (chunkCount > maxChunksPerChat) {
					const result = this.db
						.prepare(
							`DELETE FROM rag_chunks WHERE id IN (
								SELECT id FROM rag_chunks WHERE chat_key = ? ORDER BY id ASC LIMIT ?
							)`,
						)
						.run(chatKey, chunkCount - maxChunksPerChat);
					removed += asNumber(result.changes);
				}
			}
			return removed;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: RAG prune 失败：${error instanceof Error ? error.message : String(error)}`);
			return removed;
		}
	}

	reindex(chatKey?: string): number {
		try {
			if (chatKey !== undefined) {
				const ids = this.db.prepare('SELECT id FROM rag_chunks WHERE chat_key = ?').all(chatKey) as Array<{ id?: unknown }>;
				for (const row of ids) {
					const id = asNumber(row.id);
					if (this.vecReady) this.db.prepare('DELETE FROM rag_chunk_vec WHERE chunk_id = ?').run(id);
				}
				const result = this.db.prepare('DELETE FROM rag_chunks WHERE chat_key = ?').run(chatKey);
				return asNumber(result.changes);
			}
			if (this.vecReady) {
				this.db.exec('DELETE FROM rag_chunk_vec');
			}
			const result = this.db.prepare('DELETE FROM rag_chunks').run();
			return asNumber(result.changes);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: RAG reindex 失败：${error instanceof Error ? error.message : String(error)}`);
			return 0;
		}
	}

	audit(chatKey: string, itemId: number | null, action: string, actor: string, before: string | null, after: string | null): void {
		try {
			this.db
				.prepare('INSERT INTO rag_audit(chat_key, item_id, action, actor, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(chatKey, itemId, action, actor, before, after, Date.now());
		} catch {
			// ignore
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} catch {
			// ignore
		}
	}
}
