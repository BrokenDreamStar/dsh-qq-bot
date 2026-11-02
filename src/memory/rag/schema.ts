/**
 * RAG 数据库 schema 与一次性迁移。
 *
 * 迁移策略（自用部署，不做画像数据保留）：
 *  - 旧 `memory_members` / `memory_facts` / `memory_facts_fts` / `memory_tombstones` /
 *    `memory_audit` 全部 drop；
 *  - 旧 `memory_events` 原文保留：重命名为 `rag_messages`，`generation` 列重命名为
 *    `session_id`，补 `created_at`；
 *  - 新表全部 `IF NOT EXISTS`，可重复执行。
 */

import { EMBEDDING_DIM } from './modelOptions.ts';

export interface SqliteLike {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	};
}

/** 当前 schema 版本（写入 rag_meta.schema_version）。 */
export const RAG_SCHEMA_VERSION = '2';

export const RAG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rag_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sender_id TEXT,
  sender_name TEXT NOT NULL,
  self INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  text_seg TEXT,
  msg_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rag_messages_msg
  ON rag_messages(chat_key, msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rag_messages_scope ON rag_messages(chat_key, seq);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_key TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_seg TEXT NOT NULL,
  hash TEXT NOT NULL,
  msg_count INTEGER NOT NULL,
  embed_status INTEGER NOT NULL DEFAULT 0,
  embed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rag_chunks_hash ON rag_chunks(chat_key, hash);
CREATE INDEX IF NOT EXISTS rag_chunks_scope ON rag_chunks(chat_key, ts);
CREATE INDEX IF NOT EXISTS rag_chunks_pending ON rag_chunks(embed_status, id);

CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
  text_seg,
  content='rag_chunks',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts(rowid, text_seg) VALUES (new.id, new.text_seg);
END;
CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text_seg) VALUES('delete', old.id, old.text_seg);
END;
CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text_seg) VALUES('delete', old.id, old.text_seg);
  INSERT INTO rag_chunks_fts(rowid, text_seg) VALUES (new.id, new.text_seg);
END;

CREATE TABLE IF NOT EXISTS rag_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'chat',
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.7,
  source_from INTEGER,
  source_to INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  content_hash TEXT NOT NULL,
  name_seg TEXT,
  description_seg TEXT,
  when_seg TEXT,
  body_seg TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rag_skills_name ON rag_skills(chat_key, name);
CREATE INDEX IF NOT EXISTS rag_skills_scope ON rag_skills(chat_key, status);

CREATE VIRTUAL TABLE IF NOT EXISTS rag_skills_fts USING fts5(
  name_seg,
  description_seg,
  when_seg,
  body_seg,
  content='rag_skills',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS rag_skills_ai AFTER INSERT ON rag_skills BEGIN
  INSERT INTO rag_skills_fts(rowid, name_seg, description_seg, when_seg, body_seg)
  VALUES (new.id, new.name_seg, new.description_seg, new.when_seg, new.body_seg);
END;
CREATE TRIGGER IF NOT EXISTS rag_skills_ad AFTER DELETE ON rag_skills BEGIN
  INSERT INTO rag_skills_fts(rag_skills_fts, rowid, name_seg, description_seg, when_seg, body_seg)
  VALUES('delete', old.id, old.name_seg, old.description_seg, old.when_seg, old.body_seg);
END;
CREATE TRIGGER IF NOT EXISTS rag_skills_au AFTER UPDATE ON rag_skills BEGIN
  INSERT INTO rag_skills_fts(rag_skills_fts, rowid, name_seg, description_seg, when_seg, body_seg)
  VALUES('delete', old.id, old.name_seg, old.description_seg, old.when_seg, old.body_seg);
  INSERT INTO rag_skills_fts(rowid, name_seg, description_seg, when_seg, body_seg)
  VALUES (new.id, new.name_seg, new.description_seg, new.when_seg, new.body_seg);
END;

CREATE TABLE IF NOT EXISTS rag_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rag_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_key TEXT NOT NULL,
  item_id INTEGER,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  before TEXT,
  after TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rag_skill_tombstones (
  content_hash TEXT PRIMARY KEY,
  chat_key TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  deleted_by TEXT NOT NULL
);
`;

/**
 * 向量表单独建：sqlite-vec 未加载时不能执行。
 * 维度来自 `EMBEDDING_DIM`——它必须与 `EMBEDDING_MODEL` 的输出维度一致（见 modelOptions.ts）。
 */
export const RAG_VEC_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunk_vec USING vec0(
  chat_key TEXT PARTITION KEY,
  chunk_id INTEGER PRIMARY KEY,
  embedding float[${EMBEDDING_DIM}] distance_metric=cosine
);
CREATE VIRTUAL TABLE IF NOT EXISTS rag_skill_vec USING vec0(
  skill_id INTEGER PRIMARY KEY,
  embedding float[${EMBEDDING_DIM}] distance_metric=cosine
);
`;

function tableExists(db: SqliteLike, name: string): boolean {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as
		| { name?: string }
		| undefined;
	return row?.name === name;
}

function columnsOf(db: SqliteLike, table: string): string[] {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
		return rows.map(row => String(row.name ?? ''));
	} catch {
		return [];
	}
}

/**
 * 一次性迁移旧记忆库。所有操作幂等；失败不抛出（由调用方决定是否继续）。
 */
export function migrateLegacyRagSchema(db: SqliteLike): { droppedProfileTables: string[]; renamedEvents: boolean } {
	const dropped: string[] = [];
	for (const trigger of ['memory_events_ai', 'memory_events_ad', 'memory_events_au']) {
		try {
			db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
		} catch {
			// ignore
		}
	}
	for (const table of ['memory_events_fts', 'memory_meta', 'memory_facts_fts', 'memory_facts', 'memory_members', 'memory_tombstones', 'memory_audit']) {
		if (!tableExists(db, table)) continue;
		try {
			db.exec(`DROP TABLE IF EXISTS ${table}`);
			dropped.push(table);
		} catch {
			// 旧表可能被触发器引用；忽略，schema 初始化会继续。
		}
	}

	let renamed = false;
	if (tableExists(db, 'memory_events') && !tableExists(db, 'rag_messages')) {
		db.exec('ALTER TABLE memory_events RENAME TO rag_messages');
		renamed = true;
	}
	if (tableExists(db, 'rag_messages')) {
		const columns = columnsOf(db, 'rag_messages');
		if (columns.includes('generation') && !columns.includes('session_id')) {
			try {
				db.exec('ALTER TABLE rag_messages RENAME COLUMN generation TO session_id');
			} catch {
				// SQLite < 3.25 不支持 RENAME COLUMN；退化为加列 + 回填。
				db.exec('ALTER TABLE rag_messages ADD COLUMN session_id TEXT');
				db.exec('UPDATE rag_messages SET session_id = generation WHERE session_id IS NULL');
			}
		} else if (!columns.includes('session_id')) {
			db.exec('ALTER TABLE rag_messages ADD COLUMN session_id TEXT');
			db.exec("UPDATE rag_messages SET session_id = '' WHERE session_id IS NULL");
		}
		if (!columns.includes('created_at')) {
			db.exec('ALTER TABLE rag_messages ADD COLUMN created_at INTEGER');
			db.exec('UPDATE rag_messages SET created_at = ts WHERE created_at IS NULL');
		}
	}

	return { droppedProfileTables: dropped, renamedEvents: renamed };
}
