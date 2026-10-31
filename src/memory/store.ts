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
 *  - `memory_facts`：记忆条目（追加 + 失效，不按 subject/predicate 覆盖）。
 *    `subject_id` 非空 = 某个群成员的画像；NULL = 群级事实/规则。
 *    `source_member_id/source_seq` 保留“谁说的、来自哪条消息”，用于区分自述与转述。
 *  - `memory_members`：群成员身份表（匿名 member_ref ↔ QQ 号 ↔ 最新昵称）。
 *  - `memory_meta`：水位线（`watermark:<chatKey>`）与世代标记（`session:<chatKey>`）。
 *
 * 所有写操作都在事务里，失败只记日志、绝不抛给消息主链路（记忆不是关键路径）。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../types.ts';
import { normalizeFactText, sanitizeMemoryText, scanForThreats, scanSensitive, describeFindings } from './guard.ts';
import { contentHash, segmentText, stripQqNumbers, MAX_ITEM_CONTENT_CHARS } from './text.ts';
import { memberDisplayName, memberRefFor } from './member.ts';
import {
	MAX_EVENT_CHARS,
	MAX_FACT_SUBJECT_CHARS,
	MEMORY_KINDS,
	MEMORY_PROVENANCES,
	MEMORY_STATUSES,
	type MemoryEvent,
	type MemoryFact,
	type MemoryKind,
	type MemoryMember,
	type MemoryProvenance,
	type MemoryStats,
	type MemoryStatus,
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
	/** 一般事实/事件过期天数（默认 90）。 */
	factTtlDays?: number;
	/** 用户偏好过期天数（默认 180）。 */
	userPreferenceTtlDays?: number;
	/** 删除后 tombstone / 回收站保留天数（默认 30）。 */
	tombstoneDays?: number;
	/** 敏感信息过滤（默认 true）。 */
	sensitiveFilter?: boolean;
}

const META_WATERMARK = 'watermark:';
const META_SESSION = 'session:';
/** 已经给过世代交接的 sessionId（保证每个世代只交接一次）。 */
const META_HANDED = 'handed:';

/** 表的列名（迁移用；表名固定，不存在时返回空数组）。 */
function columnsOf(db: SqliteDatabase, table: string): string[] {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
		return rows
			.map((row) => (typeof row.name === 'string' ? row.name : ''))
			.filter((name) => name !== '');
	} catch {
		return [];
	}
}

/** 校验/规范化后的记忆条目（写入前一次性算好，避免 addFact 与 applyOps 两套逻辑漂移）。 */
interface PreparedFact {
	subject: string;
	predicate: string;
	object: string;
	content: string;
	contentHash: string;
	kind: MemoryKind;
	provenance: MemoryProvenance;
	importance: number;
	confidence: number;
	sourceFrom: number;
	sourceTo: number;
	validFrom: number | null;
	validTo: number | null;
	expiresAt: number | null;
	status: MemoryStatus;
	pinned: boolean;
	subjectId: string | null;
	subjectName: string;
	sourceMemberId: string | null;
	sourceSeq: number | null;
}

/** 事实的去重/tombstone 键：成员事实带上 subject，避免两个人同文互相去重。 */
export function factContentHash(subjectId: string | null | undefined, content: string): string {
	return contentHash(subjectId !== null && subjectId !== undefined && subjectId !== '' ? `${subjectId}\u0000${content}` : content);
}

function validKind(value: unknown): MemoryKind {
	return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : 'fact';
}

function validProvenance(value: unknown): MemoryProvenance {
	return typeof value === 'string' && (MEMORY_PROVENANCES as readonly string[]).includes(value)
		? (value as MemoryProvenance)
		: 'agent';
}

function validStatus(value: unknown): MemoryStatus {
	return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value)
		? (value as MemoryStatus)
		: 'active';
}

/** 按类型给默认过期时间；画像/偏好/规则不过期。 */
function defaultExpiry(kind: MemoryKind, now: number, ttl?: { fact?: number; preference?: number }): number | null {
	if (kind === 'profile' || kind === 'rule') return null;
	if (kind === 'preference') return now + Math.max(1, Math.trunc(ttl?.preference ?? 180)) * 86_400_000;
	if (kind === 'plan') return now + 30 * 86_400_000;
	return now + Math.max(1, Math.trunc(ttl?.fact ?? 90)) * 86_400_000;
}

/** 把工具/蒸馏输入规范化为可落库条目。 */
function prepareFact(input: {
	chatKey: string;
	subject?: string;
	predicate?: string;
	object?: string;
	content?: string;
	kind?: MemoryKind;
	provenance?: MemoryProvenance;
	importance?: number;
	confidence?: number;
	sourceFrom?: number;
	sourceTo?: number;
	validFrom?: number | null;
	validTo?: number | null;
	expiresAt?: number | null;
	status?: MemoryStatus;
	pinned?: boolean;
	/** 成员画像主体（QQ 号，内部；null = 群级）。 */
	subjectId?: string | null;
	subjectName?: string;
	sourceMemberId?: string | null;
	sourceSeq?: number | null;
}, ttl?: { fact?: number; preference?: number }, sensitiveFilter = true): { fact: PreparedFact } | { error: string } {
	const rawContent =
		input.content !== undefined && input.content.trim() !== ''
			? input.content
			: [input.subject ?? '', input.predicate ?? '', input.object ?? ''].filter((part) => part.trim() !== '').join(' ');
	const content = normalizeFactText(stripQqNumbers(rawContent), MAX_ITEM_CONTENT_CHARS);
	if (content === undefined) return { error: '内容不能为空' };
	const verdict = scanForThreats(content);
	if (!verdict.ok) return { error: `内容命中安全扫描（${describeFindings(verdict.findings)}），已拒绝写入` };
	const sensitive = sensitiveFilter ? scanSensitive(content) : { ok: true, findings: [] };
	if (!sensitive.ok) return { error: `内容命中敏感信息过滤（${sensitive.findings.join(', ')}），默认不写入长期记忆` };
	const kind = validKind(input.kind);
	const now = Date.now();
	const subjectId = input.subjectId !== null && input.subjectId !== undefined && input.subjectId !== '' ? input.subjectId : null;
	const subjectName = subjectId === null ? '' : memberDisplayName(input.subjectName, '群友');
	return {
		fact: {
			subject: normalizeFactText(stripQqNumbers(input.subject ?? ''), MAX_FACT_SUBJECT_CHARS) ?? '',
			predicate: normalizePredicate(input.predicate ?? '') ?? '',
			object: normalizeFactText(stripQqNumbers(input.object ?? content), MAX_ITEM_CONTENT_CHARS) ?? content,
			content,
			contentHash: factContentHash(subjectId, content),
			kind,
			provenance: validProvenance(input.provenance),
			importance: clamp01(input.importance ?? 0.5),
			confidence: clamp01(input.confidence ?? 0.8),
			sourceFrom: Math.trunc(input.sourceFrom ?? 0),
			sourceTo: Math.trunc(input.sourceTo ?? 0),
			validFrom: input.validFrom ?? now,
			validTo: input.validTo ?? null,
			expiresAt: input.expiresAt !== undefined ? input.expiresAt : defaultExpiry(kind, now, ttl),
			status: validStatus(input.status ?? 'active'),
			pinned: input.pinned === true,
			subjectId,
			subjectName,
			sourceMemberId: input.sourceMemberId ?? null,
			sourceSeq: input.sourceSeq !== null && input.sourceSeq !== undefined ? Math.trunc(input.sourceSeq) : null,
		},
	};
}

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
		db.exec(`
			CREATE TABLE IF NOT EXISTS memory_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				chat_key TEXT NOT NULL,
				generation TEXT NOT NULL,
				ts INTEGER NOT NULL,
				sender_id TEXT NOT NULL,
				sender_name TEXT NOT NULL,
				self INTEGER NOT NULL,
				kind TEXT NOT NULL,
				text TEXT NOT NULL,
				text_seg TEXT,
				msg_id TEXT
			);
			CREATE INDEX IF NOT EXISTS memory_events_scope ON memory_events(chat_key, seq);
			CREATE INDEX IF NOT EXISTS memory_events_generation ON memory_events(chat_key, generation, seq);
			CREATE TABLE IF NOT EXISTS memory_facts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				chat_key TEXT NOT NULL,
				subject TEXT NOT NULL DEFAULT '',
				predicate TEXT NOT NULL DEFAULT '',
				object TEXT NOT NULL,
				content TEXT,
				content_seg TEXT,
				content_hash TEXT,
				kind TEXT NOT NULL DEFAULT 'fact',
				provenance TEXT NOT NULL DEFAULT 'agent',
				importance REAL NOT NULL DEFAULT 0.5,
				confidence REAL NOT NULL DEFAULT 0.7,
				source_from INTEGER NOT NULL DEFAULT 0,
				source_to INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				valid_from INTEGER,
				valid_to INTEGER,
				expires_at INTEGER,
				confirmed_at INTEGER,
				status TEXT NOT NULL DEFAULT 'active',
				access_count INTEGER NOT NULL DEFAULT 0,
				last_access_at INTEGER NOT NULL DEFAULT 0,
				pinned INTEGER NOT NULL DEFAULT 0,
				superseded_by INTEGER,
				subject_id TEXT,
				subject_name TEXT,
				source_member_id TEXT,
				source_seq INTEGER
			);
			CREATE INDEX IF NOT EXISTS memory_facts_time ON memory_facts(chat_key, updated_at);
			CREATE TABLE IF NOT EXISTS memory_members (
				chat_key TEXT NOT NULL,
				member_ref TEXT NOT NULL,
				member_id TEXT NOT NULL,
				display_name TEXT NOT NULL,
				first_seen INTEGER NOT NULL,
				last_seen INTEGER NOT NULL,
				PRIMARY KEY (chat_key, member_ref)
			);
			CREATE INDEX IF NOT EXISTS memory_members_id ON memory_members(chat_key, member_id);
			CREATE TABLE IF NOT EXISTS memory_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memory_tombstones (
				content_hash TEXT PRIMARY KEY,
				scope TEXT NOT NULL,
				deleted_at INTEGER NOT NULL,
				deleted_by TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memory_audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				scope TEXT NOT NULL,
				item_id INTEGER,
				action TEXT NOT NULL,
				actor TEXT NOT NULL,
				before TEXT,
				after TEXT,
				at INTEGER NOT NULL
			);
		`);

		// 旧库迁移：补列（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，先查）。
		const eventColumns = columnsOf(db, 'memory_events');
		if (!eventColumns.includes('text_seg')) db.exec('ALTER TABLE memory_events ADD COLUMN text_seg TEXT');
		const factColumns = columnsOf(db, 'memory_facts');
		const factAdditions: Array<[string, string]> = [
			['content', 'TEXT'],
			['content_seg', 'TEXT'],
			['content_hash', 'TEXT'],
			["kind", "TEXT NOT NULL DEFAULT 'fact'"],
			["provenance", "TEXT NOT NULL DEFAULT 'agent'"],
			['importance', 'REAL NOT NULL DEFAULT 0.5'],
			['valid_from', 'INTEGER'],
			['valid_to', 'INTEGER'],
			['expires_at', 'INTEGER'],
			['confirmed_at', 'INTEGER'],
			["status", "TEXT NOT NULL DEFAULT 'active'"],
		];
		for (const [name, type] of factAdditions) {
			if (!factColumns.includes(name)) db.exec(`ALTER TABLE memory_facts ADD COLUMN ${name} ${type}`);
		}
		// 本插件自用、不做记忆库迁移：旧库缺少成员列时明确失败，让用户删库重建。
		const requiredMemberColumns = ['subject_id', 'subject_name', 'source_member_id', 'source_seq'];
		const missingMemberColumns = requiredMemberColumns.filter((name) => !factColumns.includes(name));
		if (missingMemberColumns.length > 0) {
			throw new Error(
				`记忆库 schema 过旧（缺少 ${missingMemberColumns.join(', ')}）。本插件不做迁移，请删除 ${options.filePath} 后重启 dsh。`,
			);
		}
		// 旧的唯一键必须去掉：同一个人的第二条偏好不应该覆盖第一条。
		db.exec('DROP INDEX IF EXISTS memory_facts_key');
		db.exec('CREATE INDEX IF NOT EXISTS memory_facts_scope ON memory_facts(chat_key, status)');
		db.exec('CREATE INDEX IF NOT EXISTS memory_facts_member ON memory_facts(chat_key, subject_id, status)');

		// 旧行补 content / 分词列 / hash。
		db.exec(
			`UPDATE memory_facts
			 SET content = TRIM(COALESCE(subject, '') || ' ' || COALESCE(predicate, '') || ' ' || COALESCE(object, ''))
			 WHERE content IS NULL OR content = ''`,
		);
		const pendingEvents = db
			.prepare("SELECT seq, text FROM memory_events WHERE text_seg IS NULL OR text_seg = ''")
			.all() as Array<Record<string, unknown>>;
		const updateEventSeg = db.prepare('UPDATE memory_events SET text_seg = ? WHERE seq = ?');
		for (const row of pendingEvents) {
			updateEventSeg.run(segmentText(String(row.text ?? '')), Number(row.seq ?? 0));
		}
		const pendingFacts = db
			.prepare("SELECT id, content FROM memory_facts WHERE content_seg IS NULL OR content_seg = ''")
			.all() as Array<Record<string, unknown>>;
		const updateFactSeg = db.prepare('UPDATE memory_facts SET content_seg = ? WHERE id = ?');
		const updateFactHash = db.prepare('UPDATE memory_facts SET content_hash = ? WHERE id = ?');
		for (const row of pendingFacts) {
			const content = String(row.content ?? '');
			updateFactSeg.run(segmentText(content), Number(row.id ?? 0));
			updateFactHash.run(contentHash(content), Number(row.id ?? 0));
		}

		// 事件 FTS：旧表 tokenize 用的是 text，必须换成分词列 text_seg。
		const eventFtsColumns = columnsOf(db, 'memory_events_fts');
		const recreateEventFts = !eventFtsColumns.includes('text_seg');
		if (recreateEventFts) {
			db.exec(`
				DROP TRIGGER IF EXISTS memory_events_ai;
				DROP TRIGGER IF EXISTS memory_events_ad;
				DROP TRIGGER IF EXISTS memory_events_au;
				DROP TABLE IF EXISTS memory_events_fts;
				CREATE VIRTUAL TABLE memory_events_fts USING fts5(
					text_seg,
					content='memory_events',
					content_rowid='seq',
					tokenize='unicode61'
				);
				CREATE TRIGGER memory_events_ai AFTER INSERT ON memory_events BEGIN
					INSERT INTO memory_events_fts(rowid, text_seg) VALUES (new.seq, new.text_seg);
				END;
				CREATE TRIGGER memory_events_ad AFTER DELETE ON memory_events BEGIN
					INSERT INTO memory_events_fts(memory_events_fts, rowid, text_seg) VALUES('delete', old.seq, old.text_seg);
				END;
				CREATE TRIGGER memory_events_au AFTER UPDATE ON memory_events BEGIN
					INSERT INTO memory_events_fts(memory_events_fts, rowid, text_seg) VALUES('delete', old.seq, old.text_seg);
					INSERT INTO memory_events_fts(rowid, text_seg) VALUES (new.seq, new.text_seg);
				END;
				INSERT INTO memory_events_fts(memory_events_fts) VALUES('rebuild');
			`);
		} else if (pendingEvents.length > 0) {
			db.exec("INSERT INTO memory_events_fts(memory_events_fts) VALUES('rebuild')");
		}

		// 记忆条目 FTS：按 content_seg 检索。
		const factFtsColumns = columnsOf(db, 'memory_facts_fts');
		const recreateFactFts = !factFtsColumns.includes('content_seg');
		if (recreateFactFts) {
			db.exec(`
				DROP TRIGGER IF EXISTS memory_facts_ai;
				DROP TRIGGER IF EXISTS memory_facts_ad;
				DROP TRIGGER IF EXISTS memory_facts_au;
				DROP TABLE IF EXISTS memory_facts_fts;
				CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
					content_seg,
					content='memory_facts',
					content_rowid='id',
					tokenize='unicode61'
				);
				CREATE TRIGGER memory_facts_ai AFTER INSERT ON memory_facts BEGIN
					INSERT INTO memory_facts_fts(rowid, content_seg) VALUES (new.id, new.content_seg);
				END;
				CREATE TRIGGER memory_facts_ad AFTER DELETE ON memory_facts BEGIN
					INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content_seg) VALUES('delete', old.id, old.content_seg);
				END;
				CREATE TRIGGER memory_facts_au AFTER UPDATE ON memory_facts BEGIN
					INSERT INTO memory_facts_fts(memory_facts_fts, rowid, content_seg) VALUES('delete', old.id, old.content_seg);
					INSERT INTO memory_facts_fts(rowid, content_seg) VALUES (new.id, new.content_seg);
				END;
				INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild');
			`);
		} else if (pendingFacts.length > 0) {
			db.exec("INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild')");
		}
	} catch (error) {
		try {
			db.close();
		} catch {
			// 打不开就已经失败，关闭失败无所谓。
		}
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `初始化记忆表失败：${message}` };
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
					`INSERT INTO memory_events (chat_key, generation, ts, sender_id, sender_name, self, kind, text, text_seg, msg_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
					segmentText(text),
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
	searchEvents(
		chatKey: string,
		match: string,
		limit: number,
		senderId?: string,
	): Array<{ event: MemoryEvent; bm25: number }> {
		try {
			const sender = senderId !== undefined && senderId !== '' ? senderId : null;
			const rows = this.db
				.prepare(
					`SELECT e.seq, e.chat_key, e.generation, e.ts, e.sender_id, e.sender_name, e.self, e.kind, e.text, e.msg_id,
					        bm25(memory_events_fts) AS score
					 FROM memory_events_fts
					 JOIN memory_events e ON e.seq = memory_events_fts.rowid
					 WHERE memory_events_fts MATCH ? AND e.chat_key = ?
					   AND (? IS NULL OR e.sender_id = ?)
					 ORDER BY score
					 LIMIT ?`,
				)
				.all(match, chatKey, sender, sender, Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
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
	 * 记忆条目检索（FTS5，按 content_seg）。
	 *
	 * @returns 命中的条目 + BM25 原始分；只返回 active 条目。
	 */
	searchItems(
		chatKey: string,
		match: string,
		limit: number,
		subjectId?: string,
	): Array<{ fact: MemoryFact; bm25: number }> {
		try {
			const subject = subjectId !== undefined && subjectId !== '' ? subjectId : null;
			const rows = this.db
				.prepare(
					`SELECT f.*, bm25(memory_facts_fts) AS score
					 FROM memory_facts_fts
					 JOIN memory_facts f ON f.id = memory_facts_fts.rowid
					 WHERE memory_facts_fts MATCH ? AND f.chat_key = ? AND f.status = 'active'
					   AND (? IS NULL OR f.subject_id = ? OR f.subject_id IS NULL)
					 ORDER BY score
					 LIMIT ?`,
				)
				.all(match, chatKey, subject, subject, Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
			return rows.map((row) => ({
				fact: rowToFact(row),
				bm25: Number(row.score ?? 0),
			}));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 记忆条目检索失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 列某会话的记忆条目（WebUI / `/memory list` 用；query 走 LIKE，不追求语义）。 */
	listItems(
		chatKey: string,
		options: { query?: string; status?: MemoryStatus | 'all'; limit?: number; subjectId?: string | null } = {},
	): MemoryFact[] {
		try {
			const status = options.status ?? 'active';
			const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
			const params: unknown[] = [chatKey];
			let sql = 'SELECT * FROM memory_facts WHERE chat_key = ?';
			if (status !== 'all') {
				sql += ' AND status = ?';
				params.push(status);
			}
			const query = options.query?.trim();
			if (query !== undefined && query !== '') {
				sql += ' AND content LIKE ?';
				params.push(`%${query}%`);
			}
			if (options.subjectId !== undefined) {
				if (options.subjectId === null) {
					sql += ' AND subject_id IS NULL';
				} else {
					sql += ' AND subject_id = ?';
					params.push(options.subjectId);
				}
			}
			sql += ' ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?';
			params.push(limit);
			const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
			return rows.map(rowToFact);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取记忆条目失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 读一条（RPC 编辑前校验归属/状态）。 */
	getItem(chatKey: string, id: number): MemoryFact | undefined {
		try {
			const row = this.db.prepare('SELECT * FROM memory_facts WHERE id = ? AND chat_key = ?').get(id, chatKey);
			return row === undefined ? undefined : rowToFact(row as Record<string, unknown>);
		} catch {
			return undefined;
		}
	}

	/** 审计日志（WebUI 用；最近 N 条）。 */
	auditLog(chatKey: string, limit = 100): Array<Record<string, unknown>> {
		try {
			return this.db
				.prepare('SELECT * FROM memory_audit WHERE scope = ? ORDER BY id DESC LIMIT ?')
				.all(chatKey, Math.max(1, Math.min(500, Math.trunc(limit)))) as Array<Record<string, unknown>>;
		} catch {
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

	/** 只取群级事实（成员画像不参与 system prompt 的群卡片）。 */
	groupFacts(chatKey: string): MemoryFact[] {
		return this.facts(chatKey).filter((fact) => fact.subjectId === null || fact.subjectId === undefined);
	}

	/** 某个成员的画像条目（含 pending；调用方按 status 过滤）。 */
	memberFacts(chatKey: string, memberId: string): MemoryFact[] {
		try {
			const rows = this.db
				.prepare('SELECT * FROM memory_facts WHERE chat_key = ? AND subject_id = ? ORDER BY id')
				.all(chatKey, memberId) as Array<Record<string, unknown>>;
			return rows.map(rowToFact);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取成员画像失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 记录/更新一个群成员（昵称以最新一次非空发言为准；不覆盖成空）。 */
	upsertMember(chatKey: string, memberId: string, displayName: string, at = Date.now()): MemoryMember | undefined {
		const id = memberId.trim();
		if (id === '') return undefined;
		const ref = memberRefFor(chatKey, id);
		const rawName = displayName.trim();
		const name = rawName === '' ? '' : memberDisplayName(rawName, '群友');
		const ts = Math.trunc(at);
		const changed = this.tx('upsertMember', () => {
			const existing = this.db
				.prepare('SELECT first_seen, last_seen, display_name FROM memory_members WHERE chat_key = ? AND member_ref = ?')
				.get(chatKey, ref) as { first_seen?: unknown; last_seen?: unknown; display_name?: unknown } | undefined;
			if (existing === undefined) {
				this.db
					.prepare(
						`INSERT INTO memory_members (chat_key, member_ref, member_id, display_name, first_seen, last_seen)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(chatKey, ref, id, name === '' ? '群友' : name, ts, ts);
			} else {
				const firstSeen = Number(existing.first_seen ?? ts);
				const lastSeen = Math.max(Number(existing.last_seen ?? firstSeen), ts);
				const nextName = name === '' ? String(existing.display_name ?? '群友') : name;
				this.db
					.prepare(
						`UPDATE memory_members SET member_id = ?, display_name = ?, first_seen = ?, last_seen = ?
						 WHERE chat_key = ? AND member_ref = ?`,
					)
					.run(id, nextName, Math.min(firstSeen, ts), lastSeen, chatKey, ref);
			}
			return true;
		});
		if (changed !== true) return undefined;
		const stored = this.member(chatKey, id);
		return stored ?? { chatKey, memberRef: ref, memberId: id, displayName: name === '' ? '群友' : name, firstSeen: ts, lastSeen: ts };
	}

	/** 群成员列表（按最近发言排序）。 */
	members(chatKey: string): MemoryMember[] {
		try {
			const rows = this.db
				.prepare('SELECT * FROM memory_members WHERE chat_key = ? ORDER BY last_seen DESC, display_name ASC')
				.all(chatKey) as Array<Record<string, unknown>>;
			return rows.map(rowToMember);
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取群成员失败: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** 按内部 QQ 号找成员。 */
	member(chatKey: string, memberId: string): MemoryMember | undefined {
		try {
			const row = this.db
				.prepare('SELECT * FROM memory_members WHERE chat_key = ? AND member_id = ? LIMIT 1')
				.get(chatKey, memberId);
			return row === undefined ? undefined : rowToMember(row as Record<string, unknown>);
		} catch {
			return undefined;
		}
	}

	/** 删除成员身份行（“忘掉我”后不再出现在列表里；再次发言会重新建立）。 */
	deleteMember(chatKey: string, memberId: string): boolean {
		const changed = this.tx('deleteMember', () => {
			const result = this.db.prepare('DELETE FROM memory_members WHERE chat_key = ? AND member_id = ?').run(chatKey, memberId);
			return Number(result.changes);
		});
		return (changed ?? 0) > 0;
	}

	/** 按昵称找成员（重名时返回多个，由调用方决定是否要求更精确的称呼）。 */
	membersByName(chatKey: string, name: string): MemoryMember[] {
		const wanted = name.trim();
		if (wanted === '') return [];
		return this.members(chatKey).filter((member) => member.displayName === wanted);
	}

	/** 该会话事实条数与事件条数（统计用）。 */
	chatStats(chatKey: string): { facts: number; events: number } {
		try {
			const facts = this.db
				.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE chat_key = ? AND status = 'active'")
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
	 * 新增一条记忆条目（**追加**，不再按 subject/predicate 原地覆盖）。
	 *
	 * - `content` 是自然语言正文；旧结构化调用（subject/predicate/object）仍然兼容，
	 *   会被拼成 content；
	 * - 同一 chatKey 下内容 hash 相同的 active 条目只更新置信度/时间，不重复插入；
	 * - 来源分级 `provenance` 决定它能不能进画像（service 负责筛选）。
	 *
	 * @returns 落库后的 id；被威胁扫描拒绝返回 `{ error }`。
	 */
	addFact(input: {
		chatKey: string;
		subject?: string;
		predicate?: string;
		object?: string;
		content?: string;
		kind?: MemoryKind;
		provenance?: MemoryProvenance;
		importance?: number;
		confidence?: number;
		sourceFrom?: number;
		sourceTo?: number;
		validFrom?: number | null;
		validTo?: number | null;
		expiresAt?: number | null;
		status?: MemoryStatus;
		pinned?: boolean;
		actor?: string;
		subjectId?: string | null;
		subjectName?: string;
		sourceMemberId?: string | null;
		sourceSeq?: number | null;
	}): { id: number } | { error: string } {
		const prepared = prepareFact(input, { fact: this.options.factTtlDays, preference: this.options.userPreferenceTtlDays }, this.options.sensitiveFilter !== false);
		if ('error' in prepared) return prepared;
		if (this.isTombstoned(input.chatKey, prepared.fact.content, input.subjectId)) {
			return { error: '该内容已被用户删除（tombstone），不再写入长期记忆' };
		}
		const now = Date.now();
		const id = this.tx('addFact', () => this.insertFactRow(input.chatKey, prepared.fact, now, input.actor ?? 'agent'));
		if (id === undefined) return { error: '写入失败（详见日志）' };
		this.bump(input.chatKey);
		return { id };
	}

	/** 改写某条记忆条目的正文（工具与蒸馏共用）。 */
	updateFact(chatKey: string, id: number, content: string): { ok: true } | { error: string } {
		const verdict = scanForThreats(content);
		if (!verdict.ok) return { error: `内容命中安全扫描（${describeFindings(verdict.findings)}），已拒绝写入` };
		const normalized = normalizeFactText(stripQqNumbers(content), MAX_ITEM_CONTENT_CHARS);
		if (normalized === undefined) return { error: '内容不能为空' };
		const now = Date.now();
		const changed = this.tx('updateFact', () => {
			const before = this.db
				.prepare("SELECT content, subject_id FROM memory_facts WHERE id = ? AND chat_key = ? AND status IN ('active','pending')")
				.get(id, chatKey) as { content?: unknown; subject_id?: unknown } | undefined;
			if (before === undefined) return 0;
			const subjectId = typeof before.subject_id === 'string' && before.subject_id !== '' ? before.subject_id : null;
			const result = this.db
				.prepare(
					`UPDATE memory_facts
					 SET object = ?, content = ?, content_seg = ?, content_hash = ?, updated_at = ?, confirmed_at = ?,
					     status = 'active'
					 WHERE id = ? AND chat_key = ? AND status IN ('active','pending')`,
				)
				.run(normalized, normalized, segmentText(normalized), factContentHash(subjectId, normalized), now, now, id, chatKey);
			if (Number(result.changes) > 0) {
				this.audit(chatKey, id, 'update', 'agent', String(before.content ?? ''), normalized, now);
			}
			return Number(result.changes);
		});
		if (changed === undefined || changed === 0) return { error: `没有找到 id=${id} 的可改写条目` };
		this.bump(chatKey);
		return { ok: true };
	}

	/** 更新条目的元数据（WebUI 编辑 kind/importance/pinned/status 用）。 */
	updateItemMeta(chatKey: string, id: number, input: { kind?: MemoryKind; importance?: number; pinned?: boolean; status?: MemoryStatus }): boolean {
		const now = Date.now();
		const changed = this.tx('updateItemMeta', () => {
			const sets: string[] = ['updated_at = ?'];
			const params: unknown[] = [now];
			if (input.kind !== undefined) {
				sets.push('kind = ?');
				params.push(validKind(input.kind));
			}
			if (input.importance !== undefined) {
				sets.push('importance = ?');
				params.push(clamp01(input.importance));
			}
			if (input.pinned !== undefined) {
				sets.push('pinned = ?', 'confirmed_at = ?');
				params.push(input.pinned ? 1 : 0, input.pinned ? now : null);
			}
			if (input.status !== undefined) {
				sets.push('status = ?');
				params.push(validStatus(input.status));
				if (input.status === 'active') {
					sets.push('confirmed_at = ?');
					params.push(now);
				}
			}
			params.push(id, chatKey);
			const result = this.db
				.prepare(`UPDATE memory_facts SET ${sets.join(', ')} WHERE id = ? AND chat_key = ?`)
				.run(...params);
			return Number(result.changes);
		});
		if (changed === undefined || changed === 0) return false;
		this.bump(chatKey);
		return true;
	}

	/** 软删除（标记被取代）；`supersededBy` 传 0 表示"手动删除/失效"。 */
	supersedeFact(chatKey: string, id: number, supersededBy = 0): boolean {
		const now = Date.now();
		const changed = this.tx('supersedeFact', () => {
			const result = this.db
				.prepare(
					`UPDATE memory_facts
					 SET superseded_by = ?, status = 'superseded', valid_to = COALESCE(valid_to, ?), updated_at = ?
					 WHERE id = ? AND chat_key = ? AND status = 'active'`,
				)
				.run(Math.trunc(supersededBy), now, now, id, chatKey);
			if (Number(result.changes) > 0) this.audit(chatKey, id, 'invalidate', 'agent', null, null, now);
			return Number(result.changes);
		});
		if (changed === undefined || changed === 0) return false;
		this.bump(chatKey);
		return true;
	}

	/** 用户/管理员删除：软删 + tombstone，防止后台抽取把内容重新记回来。 */
	deleteFact(chatKey: string, id: number, actor: string): boolean {
		const now = Date.now();
		const removed = this.tx('deleteFact', () => {
			const row = this.db
				.prepare('SELECT content, content_hash, subject_id FROM memory_facts WHERE id = ? AND chat_key = ?')
				.get(id, chatKey) as { content?: unknown; content_hash?: unknown; subject_id?: unknown } | undefined;
			if (row === undefined) return false;
			const result = this.db
				.prepare(
					`UPDATE memory_facts
					 SET status = 'deleted', valid_to = COALESCE(valid_to, ?), updated_at = ?
					 WHERE id = ? AND chat_key = ? AND status <> 'deleted'`,
				)
				.run(now, now, id, chatKey);
			if (Number(result.changes) === 0) return false;
			const subjectId = typeof row.subject_id === 'string' && row.subject_id !== '' ? row.subject_id : null;
			const hash = String(row.content_hash ?? '') || factContentHash(subjectId, String(row.content ?? ''));
			this.db
				.prepare(
					`INSERT INTO memory_tombstones (content_hash, scope, deleted_at, deleted_by)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(content_hash) DO UPDATE SET deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by`,
				)
				.run(hash, chatKey, now, actor);
			this.audit(chatKey, id, 'delete', actor, String(row.content ?? ''), null, now);
			return true;
		});
		if (removed === true) this.bump(chatKey);
		return removed === true;
	}

	/** 某内容是否已被删除（抽取时先查 tombstone）。 */
	isTombstoned(chatKey: string, content: string, subjectId?: string | null): boolean {
		try {
			const hash = factContentHash(subjectId, content);
			const row = this.db
				.prepare('SELECT 1 AS hit FROM memory_tombstones WHERE content_hash = ? AND (scope = ? OR scope = ?) LIMIT 1')
				.get(hash, chatKey, '') as { hit?: unknown } | undefined;
			return row !== undefined;
		} catch {
			return false;
		}
	}

	setPinned(chatKey: string, id: number, pinned: boolean): boolean {
		const now = Date.now();
		const changed = this.tx('setPinned', () => {
			const result = this.db
				.prepare(
					`UPDATE memory_facts SET pinned = ?, updated_at = ?, confirmed_at = ?
					 WHERE id = ? AND chat_key = ? AND status = 'active'`,
				)
				.run(pinned ? 1 : 0, now, pinned ? now : null, id, chatKey);
			return Number(result.changes);
		});
		if (changed === undefined || changed === 0) return false;
		this.bump(chatKey);
		return true;
	}

	/** 记录一次命中（检索后异步调用）。 */
	touchFacts(ids: readonly number[]): void {
		if (ids.length === 0) return;
		const now = Date.now();
		this.tx('touchFacts', () => {
			const statement = this.db.prepare(
				'UPDATE memory_facts SET access_count = access_count + 1, last_access_at = ? WHERE id = ?',
			);
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
					const prepared = prepareFact({
						chatKey,
						subject: op.subject,
						predicate: op.predicate,
						object: op.object,
						...(op.content !== undefined ? { content: op.content } : {}),
						...(op.kind !== undefined ? { kind: op.kind } : {}),
						confidence: op.confidence,
						importance: op.importance,
						...(op.status !== undefined ? { status: op.status } : {}),
						...(op.provenance !== undefined ? { provenance: op.provenance } : {}),
						...(op.subjectId !== undefined ? { subjectId: op.subjectId } : {}),
						...(op.subjectName !== undefined ? { subjectName: op.subjectName } : {}),
						...(op.sourceMemberId !== undefined ? { sourceMemberId: op.sourceMemberId } : {}),
						...(op.sourceSeq !== undefined ? { sourceSeq: op.sourceSeq } : {}),
						sourceTo,
					}, { fact: this.options.factTtlDays, preference: this.options.userPreferenceTtlDays }, this.options.sensitiveFilter !== false);
					if ('error' in prepared) continue;
					if (this.isTombstoned(chatKey, prepared.fact.content, prepared.fact.subjectId)) continue;
					this.insertFactRow(chatKey, prepared.fact, now, 'agent');
					continue;
				}
				if (op.op === 'update') {
					const content = normalizeFactText(stripQqNumbers(op.content ?? op.object), MAX_ITEM_CONTENT_CHARS);
					if (content === undefined) continue;
					const target = this.db
						.prepare('SELECT subject_id FROM memory_facts WHERE id = ? AND chat_key = ?')
						.get(op.id, chatKey) as { subject_id?: unknown } | undefined;
					const subjectId = typeof target?.subject_id === 'string' && target.subject_id !== '' ? target.subject_id : null;
					this.db
						.prepare(
							`UPDATE memory_facts
							 SET object = ?, content = ?, content_seg = ?, content_hash = ?, updated_at = ?, confirmed_at = ?, source_to = ?
							 WHERE id = ? AND chat_key = ? AND status = 'active'`,
						)
						.run(content, content, segmentText(content), factContentHash(subjectId, content), now, now, Math.trunc(sourceTo), op.id, chatKey);
					continue;
				}
				this.db
					.prepare(
						`UPDATE memory_facts
						 SET status = 'superseded', valid_to = COALESCE(valid_to, ?), superseded_by = 0, updated_at = ?
						 WHERE id = ? AND chat_key = ? AND status = 'active'`,
					)
					.run(now, now, op.id, chatKey);
			}
			return true;
		});
		if (done !== true) return false;
		this.bump(chatKey);
		return true;
	}

	/** 插入一行（调用方负责事务；同内容 active 条目只更新，不重复插入）。 */
	private insertFactRow(chatKey: string, fact: PreparedFact, now: number, actor: string): number {
		const existing = this.db
			.prepare(
				`SELECT id, status FROM memory_facts
				 WHERE chat_key = ? AND content_hash = ? AND status IN ('active','pending')
				 LIMIT 1`,
			)
			.get(chatKey, fact.contentHash) as { id?: unknown; status?: unknown } | undefined;
		if (existing !== undefined && typeof existing.id === 'number') {
			const nextStatus = fact.status === 'active' ? 'active' : String(existing.status ?? 'pending');
			this.db
				.prepare(
					`UPDATE memory_facts
					 SET confidence = ?, importance = ?, updated_at = ?, confirmed_at = ?, source_to = ?, status = ?
					 WHERE id = ?`,
				)
				.run(fact.confidence, fact.importance, now, fact.provenance === 'untrusted' ? null : now, fact.sourceTo, nextStatus, existing.id);
			return existing.id;
		}
		const result = this.db
			.prepare(
				`INSERT INTO memory_facts
				 (chat_key, subject, predicate, object, content, content_seg, content_hash,
				  kind, provenance, importance, confidence, source_from, source_to,
				  created_at, updated_at, valid_from, valid_to, expires_at, confirmed_at,
				  status, access_count, last_access_at, pinned, superseded_by,
				  subject_id, subject_name, source_member_id, source_seq)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?, ?, ?, ?)`,
			)
			.run(
				chatKey,
				fact.subject,
				fact.predicate,
				fact.object,
				fact.content,
				segmentText(fact.content),
				fact.contentHash,
				fact.kind,
				fact.provenance,
				fact.importance,
				fact.confidence,
				fact.sourceFrom,
				fact.sourceTo,
				now,
				now,
				fact.validFrom,
				fact.validTo,
				fact.expiresAt,
				fact.provenance === 'untrusted' ? null : now,
				fact.status,
				fact.pinned ? 1 : 0,
				fact.subjectId,
				fact.subjectName,
				fact.sourceMemberId,
				fact.sourceSeq,
			);
		const id = Number(result.lastInsertRowid);
		this.audit(chatKey, id, 'add', actor, null, fact.content, now);
		return id;
	}

	/** 写审计（失败只吞掉：审计不是关键路径）。 */
	private audit(chatKey: string, itemId: number | null, action: string, actor: string, before: string | null, after: string | null, at: number): void {
		try {
			this.db
				.prepare('INSERT INTO memory_audit (scope, item_id, action, actor, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(chatKey, itemId, action, actor, before, after, at);
		} catch {
			// 审计写入失败不影响记忆本身。
		}
	}

	/** 单个成员画像的条数上限（防止一个活跃成员吃满整库预算）。 */
	enforceMemberFactLimit(chatKey: string, subjectId: string, maxFacts: number): number {
		const limit = Math.max(1, Math.trunc(maxFacts));
		return (
			this.tx('enforceMemberFactLimit', () => {
				const ranked = this.db
					.prepare(
						`SELECT id FROM memory_facts
						 WHERE chat_key = ? AND subject_id = ? AND status IN ('active','pending')
						 ORDER BY pinned ASC, status DESC, importance ASC, confidence ASC, updated_at ASC, id ASC`,
					)
					.all(chatKey, subjectId) as Array<{ id?: unknown }>;
				if (ranked.length <= limit) return 0;
				const statement = this.db.prepare(
					`UPDATE memory_facts SET status = 'superseded', superseded_by = 0, valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ?`,
				);
				const now = Date.now();
				let count = 0;
				for (const row of ranked.slice(0, ranked.length - limit)) {
					if (typeof row.id !== 'number') continue;
					statement.run(now, now, row.id);
					count += 1;
				}
				return count;
			}) ?? 0
		);
	}

	/** 超出条数上限时按「非置顶 → 低重要度 → 低置信 → 最久未更新」淘汰（软删除）。 */
	enforceFactLimit(chatKey: string, maxFacts: number, options: { groupOnly?: boolean } = {}): number {
		const limit = Math.max(1, Math.trunc(maxFacts));
		return (
			this.tx('enforceFactLimit', () => {
				// 按淘汰优先级从"最该淘汰"到"最该保留"排序，删掉前面多余的。
				// groupOnly = 只按群级事实计数，避免群卡片上限把成员画像挤掉。
				const ranked = this.db
					.prepare(
						`SELECT id FROM memory_facts
						 WHERE chat_key = ? AND status = 'active'${options.groupOnly === true ? ' AND subject_id IS NULL' : ''}
						 ORDER BY pinned ASC, importance ASC, confidence ASC, updated_at ASC, id ASC`,
					)
					.all(chatKey) as Array<{ id?: unknown }>;
				if (ranked.length <= limit) return 0;
				const statement = this.db.prepare(
					`UPDATE memory_facts SET status = 'superseded', superseded_by = 0, valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ?`,
				);
				const now = Date.now();
				let count = 0;
				for (const row of ranked.slice(0, ranked.length - limit)) {
					if (typeof row.id !== 'number') continue;
					statement.run(now, now, row.id);
					count += 1;
				}
				return count;
			}) ?? 0
		);
	}

	// ── 维护 ─────────────────────────────────────────────────

	/** 裁剪：按保留天数删过期事件、按每会话上限删最旧事件、归档过期条目（启动与定期调用）。 */
	prune(): { events: number } {
		const days = Math.max(1, Math.trunc(this.options.retentionDays));
		const perChat = Math.max(1, Math.trunc(this.options.maxEventsPerChat));
		const now = Date.now();
		const cutoff = now - days * 86_400_000;
		const removed = this.tx('prune', () => {
			// 过期条目：从 active 归档（不物理删除，仍可审计/恢复）。
			this.db
				.prepare(
					`UPDATE memory_facts SET status = 'archived', updated_at = ?
					 WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
				)
				.run(now, now);
			// 回收站：软删超过 30 天的条目物理清除（tombstone 保留，防止复活）。
			this.db
				.prepare("DELETE FROM memory_facts WHERE status = 'deleted' AND updated_at < ?")
				.run(now - Math.max(1, Math.trunc(this.options.tombstoneDays ?? 30)) * 86_400_000);
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
				.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE status = 'active'")
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

function nullableNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function rowToFact(row: Record<string, unknown>): MemoryFact {
	const supersededBy = row.superseded_by;
	const subject = String(row.subject ?? '');
	const predicate = String(row.predicate ?? '');
	const object = String(row.object ?? '');
	const content = String(row.content ?? '') || [subject, predicate, object].filter((part) => part !== '').join(' ');
	return {
		id: Number(row.id ?? 0),
		chatKey: String(row.chat_key ?? ''),
		subject,
		predicate,
		object,
		content,
		kind: validKind(row.kind),
		provenance: validProvenance(row.provenance),
		importance: Number(row.importance ?? 0.5),
		validFrom: nullableNumber(row.valid_from),
		validTo: nullableNumber(row.valid_to),
		expiresAt: nullableNumber(row.expires_at),
		confirmedAt: nullableNumber(row.confirmed_at),
		status: validStatus(row.status),
		contentHash: String(row.content_hash ?? '') || contentHash(content),
		confidence: Number(row.confidence ?? 0),
		sourceFrom: Number(row.source_from ?? 0),
		sourceTo: Number(row.source_to ?? 0),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		accessCount: Number(row.access_count ?? 0),
		lastAccessAt: Number(row.last_access_at ?? 0),
		pinned: Number(row.pinned ?? 0) === 1,
		supersededBy: supersededBy === null || supersededBy === undefined ? null : Number(supersededBy),
		subjectId: typeof row.subject_id === 'string' && row.subject_id !== '' ? row.subject_id : null,
		subjectName: String(row.subject_name ?? ''),
		sourceMemberId: typeof row.source_member_id === 'string' && row.source_member_id !== '' ? row.source_member_id : null,
		sourceSeq: nullableNumber(row.source_seq),
	};
}

function rowToMember(row: Record<string, unknown>): MemoryMember {
	return {
		chatKey: String(row.chat_key ?? ''),
		memberRef: String(row.member_ref ?? ''),
		memberId: String(row.member_id ?? ''),
		displayName: String(row.display_name ?? ''),
		firstSeen: Number(row.first_seen ?? 0),
		lastSeen: Number(row.last_seen ?? 0),
	};
}

export { sanitizeMemoryText };
