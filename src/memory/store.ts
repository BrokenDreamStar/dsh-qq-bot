/**
 * 长期记忆的持久化：**唯一的存储实现**（`node:sqlite` + FTS5），不提供降级后端。
 *
 * 库文件：`<数据目录>/memory.db`。不可用时（Node 22.x 未加 --experimental-sqlite /
 * 宿主捆绑的 Node 无 SQLite / 库文件打不开）由 `openMemoryDatabase()` 返回失败，
 * service 层据此把整个功能标记为不可用并 warn 一条明确诊断 —— 不做第二套 JSON 后端，
 * 因为两套后端意味着两套行为差异与两倍的测试面（见 docs/memory-design.md §11.2）。
 *
 * 表：
 *  - `memory_events` + `memory_events_fts`（FTS5，触发器同步）：会话档案正文镜像。
 *    正文在插件侧有界保留（保留期 / 每会话条数上限），因为 dsh 没有"读历史会话日志"
 *    的公开 API（SessionStore 只有 live 会话），所以检索必须依赖这份镜像。
 *  - `memory_facts`：卡片条目。`(chat_key, subject, predicate)` 唯一索引 ——
 *    同主体同关系的新事实**取代**旧的（而不是并存），矛盾消解不需要额外 LLM 调用。
 *  - `memory_meta`：水位线（`watermark:<chatKey>`）与世代标记（`session:<chatKey>`）。
 *
 * 所有写操作都在事务里，失败只记日志、绝不抛给消息主链路（记忆不是关键路径）。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../types.ts';
import { normalizeFactText, sanitizeMemoryText, scanForThreats, describeFindings } from './guard.ts';
import {
	MAX_EVENT_CHARS,
	MAX_FACT_OBJECT_CHARS,
	MAX_FACT_SUBJECT_CHARS,
	type MemoryEvent,
	type MemoryFact,
	type MemoryStats,
	type DistillOp,
	PREDICATES,
} from './types.ts';

/** 打开数据库的结果（失败时给出人类可读原因）。 */
export type OpenResult =
	| { ok: true; store: MemoryStore }
	| { ok: false; reason: string };

/** `node:sqlite` 的最小类型面（该模块在 @types/node 里随版本变化，这里按用到的收窄）。 */
interface SqliteStatement {
	run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

export interface MemoryStoreOptions {
	/** 库文件绝对路径（`<dataDir>/memory.db`）。 */
	filePath: string;
	logger: Logger;
	/** 每会话最多保留的事件条数（裁剪用）。 */
	maxEventsPerChat: number;
	/** 事件保留天数（裁剪用）。 */
	retentionDays: number;
}

const META_WATERMARK = 'watermark:';
const META_SESSION = 'session:';
/** 已经给过世代交接的 sessionId（保证每个世代只交接一次）。 */
const META_HANDED = 'handed:';

/**
 * 打开（必要时创建）记忆库。
 *
 * @returns 成功时带 store；失败时 `reason` 直接进 warn 日志（要能一眼看出是
 *   Node 版本问题还是路径问题）。
 */
export async function openMemoryDatabase(options: MemoryStoreOptions): Promise<OpenResult> {
	let module: SqliteModule;
	try {
		module = (await import('node:sqlite')) as unknown as SqliteModule;
	} catch (error) {
		return {
			ok: false,
			reason: `当前 Node 运行时没有 node:sqlite（需要 Node ≥ 23.4，或 Node 22.x 加 --experimental-sqlite）：${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	try {
		mkdirSync(dirname(options.filePath), { recursive: true });
	} catch (error) {
		return { ok: false, reason: `无法创建数据目录：${error instanceof Error ? error.message : String(error)}` };
	}
	let db: SqliteDatabase;
	try {
		db = new module.DatabaseSync(options.filePath);
	} catch (error) {
		return { ok: false, reason: `打开 ${options.filePath} 失败：${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('PRAGMA synchronous = NORMAL');
		db.exec(
			[
				`CREATE TABLE IF NOT EXISTS memory_events (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					chat_key TEXT NOT NULL,
					generation TEXT NOT NULL,
					ts INTEGER NOT NULL,
					sender_id TEXT NOT NULL,
					sender_name TEXT NOT NULL,
					self INTEGER NOT NULL,
					kind TEXT NOT NULL,
					text TEXT NOT NULL,
					msg_id TEXT
				)`,
				'CREATE INDEX IF NOT EXISTS memory_events_scope ON memory_events(chat_key, seq)',
				'CREATE INDEX IF NOT EXISTS memory_events_generation ON memory_events(chat_key, generation, seq)',
				`CREATE VIRTUAL TABLE IF NOT EXISTS memory_events_fts USING fts5(
					text,
					content='memory_events',
					content_rowid='seq',
					tokenize='unicode61 remove_diacritics 2'
				)`,
				`CREATE TRIGGER IF NOT EXISTS memory_events_ai AFTER INSERT ON memory_events BEGIN
					INSERT INTO memory_events_fts(rowid, text) VALUES (new.seq, new.text);
				END`,
				`CREATE TRIGGER IF NOT EXISTS memory_events_ad AFTER DELETE ON memory_events BEGIN
					INSERT INTO memory_events_fts(memory_events_fts, rowid, text) VALUES('delete', old.seq, old.text);
				END`,
				`CREATE TRIGGER IF NOT EXISTS memory_events_au AFTER UPDATE ON memory_events BEGIN
					INSERT INTO memory_events_fts(memory_events_fts, rowid, text) VALUES('delete', old.seq, old.text);
					INSERT INTO memory_events_fts(rowid, text) VALUES (new.seq, new.text);
				END`,
				`CREATE TABLE IF NOT EXISTS memory_facts (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					chat_key TEXT NOT NULL,
					subject TEXT NOT NULL,
					predicate TEXT NOT NULL,
					object TEXT NOT NULL,
					confidence REAL NOT NULL DEFAULT 0.7,
					source_from INTEGER NOT NULL DEFAULT 0,
					source_to INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					access_count INTEGER NOT NULL DEFAULT 0,
					last_access_at INTEGER NOT NULL DEFAULT 0,
					pinned INTEGER NOT NULL DEFAULT 0,
					superseded_by INTEGER
				)`,
				'CREATE UNIQUE INDEX IF NOT EXISTS memory_facts_key ON memory_facts(chat_key, subject, predicate)',
				'CREATE INDEX IF NOT EXISTS memory_facts_scope ON memory_facts(chat_key, superseded_by)',
				`CREATE TABLE IF NOT EXISTS memory_meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				)`,
			].join(';\n'),
		);
	} catch (error) {
		try {
			db.close();
		} catch {
			// 打不开就已经失败，关闭失败无所谓。
		}
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `初始化记忆表失败（FTS5 不可用？）：${message}` };
	}
	const store = new MemoryStore(db, options);
	store.prune();
	return { ok: true, store };
}

export class MemoryStore {
	private closed = false;
	/** 每个 chatKey 的卡片版本号（变更即自增；service 据此失效卡片缓存）。 */
	private readonly revisions = new Map<string, number>();

	constructor(
		private readonly db: SqliteDatabase,
		private readonly options: MemoryStoreOptions,
	) {}

	private get logger(): Logger {
		return this.options.logger;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} catch {
			// 关闭失败不影响退出。
		}
	}

	private tx<T>(label: string, run: () => T): T | undefined {
		try {
			this.db.exec('BEGIN');
			const value = run();
			this.db.exec('COMMIT');
			return value;
		} catch (error) {
			try {
				this.db.exec('ROLLBACK');
			} catch {
				// 回滚失败说明事务已经断了，下面照常记日志。
			}
			this.logger.warn(`dsh-qq-bot: 记忆库写入失败（${label}）: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	// ── 事件（会话档案） ──────────────────────────────────────

	/**
	 * 追加一条事件。文本先清洗再截断；同一 chatKey 的 messageId 重复时跳过。
	 *
	 * @returns 新事件的 seq；重复或失败返回 undefined。
	 */
	insertEvent(event: Omit<MemoryEvent, 'seq'>): number | undefined {
		const text = normalizeFactText(event.text, MAX_EVENT_CHARS);
		if (text === undefined) return undefined;
		return this.tx('insertEvent', () => {
			if (event.msgId !== undefined && event.msgId !== '') {
				const existing = this.db
					.prepare('SELECT seq FROM memory_events WHERE chat_key = ? AND msg_id = ? LIMIT 1')
					.get(event.chatKey, event.msgId);
				if (existing !== undefined) return undefined;
			}
			const result = this.db
				.prepare(
					`INSERT INTO memory_events (chat_key, generation, ts, sender_id, sender_name, self, kind, text, msg_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					event.chatKey,
					event.generation,
					Math.trunc(event.ts),
					event.senderId,
					event.senderName,
					event.self ? 1 : 0,
					event.kind,
					text,
					event.msgId ?? null,
				);
			return Number(result.lastInsertRowid);
		});
	}

	/**
	 * FTS5 检索。
	 *
	 * @param match - `buildMatchExpression()` 产出的 MATCH 表达式（已清洗，可安全拼接）。
	 * @returns 命中事件 + BM25 原始分（SQLite 给负数，越小越相关）。
	 */
	searchEvents(chatKey: string, match: string, limit: number): Array<{ event: MemoryEvent; bm25: number }> {
		try {
			const rows = this.db
				.prepare(
					`SELECT e.seq, e.chat_key, e.generation, e.ts, e.sender_id, e.sender_name, e.self, e.kind, e.text, e.msg_id,
					        bm25(memory_events_fts) AS score
					 FROM memory_events_fts
					 JOIN memory_events e ON e.seq = memory_events_fts.rowid
					 WHERE memory_events_fts MATCH ? AND e.chat_key = ?
					 ORDER BY score
					 LIMIT ?`,
				)
				.all(match, chatKey, Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
			return rows.map((row) => ({
				event: rowToEvent(row),
				bm25: Number(row.score ?? 0),
			}));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 记忆检索失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/**
	 * 还有未蒸馏事件的会话键（空闲兜底扫描用）。
	 *
	 * 扫描**不能**只看内存里"见过的会话"：进程重启后那个集合是空的，
	 * 于是安静但有未蒸馏事件的会话永远不会被兜底（踩过）。
	 */
	pendingChats(): string[] {
		try {
			const rows = this.db
				.prepare('SELECT chat_key AS chat_key, MAX(seq) AS hi FROM memory_events GROUP BY chat_key')
				.all() as Array<Record<string, unknown>>;
			const result: string[] = [];
			for (const row of rows) {
				if (typeof row.chat_key !== 'string') continue;
				const hi = Number(row.hi ?? 0);
				if (Number.isFinite(hi) && hi > this.watermark(row.chat_key)) result.push(row.chat_key);
			}
			return result;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取待蒸馏会话失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 某会话最近的事件（旧 → 新，最多 count 条）。 */
	recentEvents(chatKey: string, count: number, generation?: string): MemoryEvent[] {
		try {
			const rows =
				generation === undefined
					? (this.db
							.prepare('SELECT * FROM memory_events WHERE chat_key = ? ORDER BY seq DESC LIMIT ?')
							.all(chatKey, Math.max(0, Math.trunc(count))) as Array<Record<string, unknown>>)
					: (this.db
							.prepare('SELECT * FROM memory_events WHERE chat_key = ? AND generation <> ? ORDER BY seq DESC LIMIT ?')
							.all(chatKey, generation, Math.max(0, Math.trunc(count))) as Array<Record<string, unknown>>);
			return rows.map(rowToEvent).reverse();
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取记忆事件失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 某世代之后的事件（水位线之后的增量，旧 → 新）。 */
	eventsAfter(chatKey: string, afterSeq: number, limit = 500): MemoryEvent[] {
		try {
			const rows = this.db
				.prepare('SELECT * FROM memory_events WHERE chat_key = ? AND seq > ? ORDER BY seq LIMIT ?')
				.all(chatKey, Math.max(0, Math.trunc(afterSeq)), Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
			return rows.map(rowToEvent);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取记忆增量失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/**
	 * 上一条事件的 seq（没有则 0）——用作"上世代最后活跃时间"的锚点。
	 * `generation` 给定时排除该世代（世代交接要的是**上一段**对话的最后一条）。
	 */
	lastEvent(chatKey: string, generation?: string): MemoryEvent | undefined {
		try {
			const row =
				generation === undefined
					? this.db.prepare('SELECT * FROM memory_events WHERE chat_key = ? ORDER BY seq DESC LIMIT 1').get(chatKey)
					: this.db
							.prepare('SELECT * FROM memory_events WHERE chat_key = ? AND generation <> ? ORDER BY seq DESC LIMIT 1')
							.get(chatKey, generation);
			return row === undefined ? undefined : rowToEvent(row as Record<string, unknown>);
		} catch {
			return undefined;
		}
	}

	// ── 元数据（水位线 / 世代标记） ─────────────────────────────

	getMeta(key: string): string | undefined {
		try {
			const row = this.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value?: unknown } | undefined;
			return typeof row?.value === 'string' ? row.value : undefined;
		} catch {
			return undefined;
		}
	}

	setMeta(key: string, value: string): void {
		this.tx('setMeta', () => {
			this.db
				.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
				.run(key, value);
		});
	}

	watermark(chatKey: string): number {
		const raw = this.getMeta(`${META_WATERMARK}${chatKey}`);
		const value = raw === undefined ? 0 : Number(raw);
		return Number.isFinite(value) ? value : 0;
	}

	setWatermark(chatKey: string, seq: number): void {
		this.setMeta(`${META_WATERMARK}${chatKey}`, String(Math.max(0, Math.trunc(seq))));
	}

	/** 上一次记录的会话 id（世代交接用于判断"换了新世代"）。 */
	lastSessionId(chatKey: string): string | undefined {
		return this.getMeta(`${META_SESSION}${chatKey}`);
	}

	setLastSessionId(chatKey: string, sessionId: string): void {
		this.setMeta(`${META_SESSION}${chatKey}`, sessionId);
	}

	/** 已经给过交接的世代 id（见 service.takeHandoff 的幂等语义）。 */
	handedGeneration(chatKey: string): string | undefined {
		return this.getMeta(`${META_HANDED}${chatKey}`);
	}

	setHandedGeneration(chatKey: string, sessionId: string): void {
		this.setMeta(`${META_HANDED}${chatKey}`, sessionId);
	}

	// ── 事实（卡片） ──────────────────────────────────────────

	/** 某会话的全部事实（含已被取代的，调用方自行过滤）。 */
	facts(chatKey: string): MemoryFact[] {
		try {
			const rows = this.db.prepare('SELECT * FROM memory_facts WHERE chat_key = ? ORDER BY id').all(chatKey) as Array<
				Record<string, unknown>
			>;
			return rows.map(rowToFact);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取记忆卡片失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 该会话事实条数与事件条数（统计用）。 */
	chatStats(chatKey: string): { facts: number; events: number } {
		try {
			const facts = this.db
				.prepare('SELECT COUNT(*) AS n FROM memory_facts WHERE chat_key = ? AND superseded_by IS NULL')
				.get(chatKey) as { n?: unknown };
			const events = this.db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE chat_key = ?').get(chatKey) as {
				n?: unknown;
			};
			return { facts: Number(facts.n ?? 0), events: Number(events.n ?? 0) };
		} catch {
			return { facts: 0, events: 0 };
		}
	}

	/** 卡片版本号：每次写事实后自增（service 的卡片缓存按它失效）。 */
	rev(chatKey: string): number {
		return this.revisions.get(chatKey) ?? 0;
	}

	private bump(chatKey: string): void {
		this.revisions.set(chatKey, (this.revisions.get(chatKey) ?? 0) + 1);
	}

	/**
	 * 新增一条事实（同 `(subject,predicate)` 已存在则改写它）。
	 *
	 * @returns 落库后的 id；被威胁扫描拒绝返回 `{ error }`。
	 */
	addFact(input: {
		chatKey: string;
		subject: string;
		predicate: string;
		object: string;
		confidence?: number;
		sourceFrom?: number;
		sourceTo?: number;
		pinned?: boolean;
	}): { id: number } | { error: string } {
		const verdict = scanForThreats(`${input.subject} ${input.predicate} ${input.object}`);
		if (!verdict.ok) return { error: `内容命中安全扫描（${describeFindings(verdict.findings)}），已拒绝写入` };
		const subject = normalizeFactText(input.subject, MAX_FACT_SUBJECT_CHARS);
		const object = normalizeFactText(input.object, MAX_FACT_OBJECT_CHARS);
		const predicate = normalizePredicate(input.predicate);
		if (subject === undefined || object === undefined || predicate === undefined) {
			return { error: '条目形状非法（subject/object 为空或 predicate 不在白名单）' };
		}
		const now = Date.now();
		const id = this.tx('addFact', () => {
			// 注意：唯一索引是 (chat_key, subject, predicate)，**不区分是否已被取代**，
			// 所以命中时只能原地改写（并复位 superseded_by），不能插入新行 ——
			// 否则会撞 unique 约束、整个写入失败。
			const existing = this.db
				.prepare('SELECT id FROM memory_facts WHERE chat_key = ? AND subject = ? AND predicate = ?')
				.get(input.chatKey, subject, predicate) as { id?: unknown } | undefined;
			if (existing !== undefined && typeof existing.id === 'number') {
				this.db
					.prepare(
						'UPDATE memory_facts SET object = ?, confidence = ?, updated_at = ?, source_to = ?, superseded_by = NULL WHERE id = ?',
					)
					.run(object, clamp01(input.confidence ?? 0.8), now, Math.trunc(input.sourceTo ?? 0), existing.id);
				return existing.id;
			}
			const result = this.db
				.prepare(
					`INSERT INTO memory_facts (chat_key, subject, predicate, object, confidence, source_from, source_to, created_at, updated_at, access_count, last_access_at, pinned, superseded_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL)`,
				)
				.run(
					input.chatKey,
					subject,
					predicate,
					object,
					clamp01(input.confidence ?? 0.8),
					Math.trunc(input.sourceFrom ?? 0),
					Math.trunc(input.sourceTo ?? 0),
					now,
					now,
					input.pinned === true ? 1 : 0,
				);
			return Number(result.lastInsertRowid);
		});
		if (id === undefined) return { error: '写入失败（详见日志）' };
		this.bump(input.chatKey);
		return { id };
	}

	/** 改写某条事实的 object（工具与蒸馏共用）。 */
	updateFact(chatKey: string, id: number, object: string): { ok: true } | { error: string } {
		const verdict = scanForThreats(object);
		if (!verdict.ok) return { error: `内容命中安全扫描（${describeFindings(verdict.findings)}），已拒绝写入` };
		const normalized = normalizeFactText(object, MAX_FACT_OBJECT_CHARS);
		if (normalized === undefined) return { error: '内容不能为空' };
		const changed = this.tx('updateFact', () => {
			const result = this.db
				.prepare('UPDATE memory_facts SET object = ?, updated_at = ? WHERE id = ? AND chat_key = ? AND superseded_by IS NULL')
				.run(normalized, Date.now(), id, chatKey);
			return Number(result.changes);
		});
		if (changed === undefined || changed === 0) return { error: `没有找到 id=${id} 的可改写条目` };
		this.bump(chatKey);
		return { ok: true };
	}

	/** 软删除（标记被取代）；`supersededBy` 传 0 表示"手动删除"。 */
	supersedeFact(chatKey: string, id: number, supersededBy = 0): boolean {
		const changed = this.tx('supersedeFact', () => {
			const result = this.db
				.prepare('UPDATE memory_facts SET superseded_by = ?, updated_at = ? WHERE id = ? AND chat_key = ? AND superseded_by IS NULL')
				.run(Math.trunc(supersededBy), Date.now(), id, chatKey);
			return Number(result.changes);
		});
		if (changed === undefined || changed === 0) return false;
		this.bump(chatKey);
		return true;
	}

	setPinned(chatKey: string, id: number, pinned: boolean): boolean {
		const changed = this.tx('setPinned', () => {
			const result = this.db
				.prepare('UPDATE memory_facts SET pinned = ?, updated_at = ? WHERE id = ? AND chat_key = ? AND superseded_by IS NULL')
				.run(pinned ? 1 : 0, Date.now(), id, chatKey);
			return Number(result.changes);
		});
		if (changed === undefined || changed === 0) return false;
		this.bump(chatKey);
		return true;
	}

	/** 记录一次命中（检索后异步调用，用于命中频率奖励）。 */
	touchFacts(ids: readonly number[]): void {
		if (ids.length === 0) return;
		const now = Date.now();
		this.tx('touchFacts', () => {
			const statement = this.db.prepare('UPDATE memory_facts SET access_count = access_count + 1, last_access_at = ? WHERE id = ?');
			for (const id of ids) statement.run(now, id);
		});
	}

	/** 把一组蒸馏操作落库（一个事务；失败整体回滚）。 */
	applyOps(chatKey: string, ops: readonly DistillOp[], sourceTo: number): boolean {
		if (ops.length === 0) return true;
		const now = Date.now();
		const done = this.tx('applyOps', () => {
			for (const op of ops) {
				if (op.op === 'add') {
					this.db
						.prepare(
							`INSERT INTO memory_facts (chat_key, subject, predicate, object, confidence, source_from, source_to, created_at, updated_at, access_count, last_access_at, pinned, superseded_by)
							 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 0, 0, NULL)
							 ON CONFLICT(chat_key, subject, predicate) DO UPDATE SET
							   object = excluded.object, confidence = excluded.confidence, updated_at = excluded.updated_at,
							   source_to = excluded.source_to, superseded_by = NULL`,
						)
						.run(chatKey, op.subject, op.predicate, op.object, clamp01(op.confidence), Math.trunc(sourceTo), now, now);
					continue;
				}
				if (op.op === 'update') {
					this.db
						.prepare('UPDATE memory_facts SET object = ?, updated_at = ?, source_to = ? WHERE id = ? AND chat_key = ?')
						.run(op.object, now, Math.trunc(sourceTo), op.id, chatKey);
					continue;
				}
				this.db
					.prepare('UPDATE memory_facts SET superseded_by = 0, updated_at = ? WHERE id = ? AND chat_key = ? AND superseded_by IS NULL')
					.run(now, op.id, chatKey);
			}
			return true;
		});
		if (done !== true) return false;
		this.bump(chatKey);
		return true;
	}

	/** 超出条数上限时按「非置顶 → 置信度低 → 最久未更新」淘汰（软删除）。 */
	enforceFactLimit(chatKey: string, maxFacts: number): number {
		const limit = Math.max(1, Math.trunc(maxFacts));
		return (
			this.tx('enforceFactLimit', () => {
				// 按淘汰优先级从"最该淘汰"到"最该保留"排序，删掉前面多余的。
				const ranked = this.db
					.prepare(
						`SELECT id FROM memory_facts
						 WHERE chat_key = ? AND superseded_by IS NULL
						 ORDER BY pinned ASC, confidence ASC, updated_at ASC, id ASC`,
					)
					.all(chatKey) as Array<{ id?: unknown }>;
				if (ranked.length <= limit) return 0;
				const statement = this.db.prepare('UPDATE memory_facts SET superseded_by = 0, updated_at = ? WHERE id = ?');
				const now = Date.now();
				let count = 0;
				for (const row of ranked.slice(0, ranked.length - limit)) {
					if (typeof row.id !== 'number') continue;
					statement.run(now, row.id);
					count += 1;
				}
				return count;
			}) ?? 0
		);
	}

	// ── 维护 ─────────────────────────────────────────────────

	/** 裁剪：按保留天数删过期事件、按每会话上限删最旧事件（启动与定期调用）。 */
	prune(): { events: number } {
		const days = Math.max(1, Math.trunc(this.options.retentionDays));
		const perChat = Math.max(1, Math.trunc(this.options.maxEventsPerChat));
		const cutoff = Date.now() - days * 86_400_000;
		const removed = this.tx('prune', () => {
			const expired = this.db.prepare('DELETE FROM memory_events WHERE ts < ?').run(cutoff);
			let count = Number(expired.changes);
			const chats = this.db.prepare('SELECT DISTINCT chat_key FROM memory_events').all() as Array<{ chat_key?: unknown }>;
			const trim = this.db.prepare(
				'DELETE FROM memory_events WHERE chat_key = ? AND seq <= (SELECT seq FROM memory_events WHERE chat_key = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)',
			);
			for (const row of chats) {
				if (typeof row.chat_key !== 'string') continue;
				const result = trim.run(row.chat_key, row.chat_key, perChat);
				count += Number(result.changes);
			}
			return count;
		});
		return { events: removed ?? 0 };
	}

	stats(): MemoryStats {
		try {
			const chats = this.db.prepare('SELECT COUNT(DISTINCT chat_key) AS n FROM memory_events').get() as { n?: unknown };
			const facts = this.db
				.prepare('SELECT COUNT(*) AS n FROM memory_facts WHERE superseded_by IS NULL')
				.get() as { n?: unknown };
			const events = this.db.prepare('SELECT COUNT(*) AS n FROM memory_events').get() as { n?: unknown };
			return {
				enabled: true,
				chats: Number(chats.n ?? 0),
				facts: Number(facts.n ?? 0),
				events: Number(events.n ?? 0),
				rev: [...this.revisions.values()].reduce((total, value) => total + value, 0),
			};
		} catch {
			return { enabled: true, chats: 0, facts: 0, events: 0, rev: 0 };
		}
	}
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0.7;
	return Math.min(1, Math.max(0, value));
}

function normalizePredicate(value: string): string | undefined {
	const text = value.trim();
	if (text === '') return undefined;
	if ((PREDICATES as readonly string[]).includes(text)) return text;
	return undefined;
}

function rowToEvent(row: Record<string, unknown>): MemoryEvent {
	const event: MemoryEvent = {
		seq: Number(row.seq ?? 0),
		chatKey: String(row.chat_key ?? ''),
		generation: String(row.generation ?? ''),
		ts: Number(row.ts ?? 0),
		senderId: String(row.sender_id ?? ''),
		senderName: String(row.sender_name ?? ''),
		self: Number(row.self ?? 0) === 1,
		kind: row.kind === 'reply' ? 'reply' : 'chat',
		text: String(row.text ?? ''),
	};
	const msgId = row.msg_id;
	if (typeof msgId === 'string' && msgId !== '') event.msgId = msgId;
	return event;
}

function rowToFact(row: Record<string, unknown>): MemoryFact {
	const supersededBy = row.superseded_by;
	return {
		id: Number(row.id ?? 0),
		chatKey: String(row.chat_key ?? ''),
		subject: String(row.subject ?? ''),
		predicate: String(row.predicate ?? ''),
		object: String(row.object ?? ''),
		confidence: Number(row.confidence ?? 0),
		sourceFrom: Number(row.source_from ?? 0),
		sourceTo: Number(row.source_to ?? 0),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		accessCount: Number(row.access_count ?? 0),
		lastAccessAt: Number(row.last_access_at ?? 0),
		pinned: Number(row.pinned ?? 0) === 1,
		supersededBy: supersededBy === null || supersededBy === undefined ? null : Number(supersededBy),
	};
}

export { sanitizeMemoryText };
