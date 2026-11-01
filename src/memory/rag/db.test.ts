import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RagDatabase } from './db.ts';
import type { Logger } from '../../types.ts';

const dirs: string[] = [];
const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

async function open(): Promise<RagDatabase> {
	const dir = mkdtempSync(join(tmpdir(), 'dshqq-rag-'));
	dirs.push(dir);
	const result = await RagDatabase.open({ filePath: join(dir, 'memory.db'), logger });
	expect(result.ok).toBe(true);
	return result.db!;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('RagDatabase：node:sqlite + FTS5', () => {
	it('写入消息/ chunk 并做中文 FTS 检索', async () => {
		const db = await open();
		const seq = db.insertMessage({
			chatKey: 'g-1',
			sessionId: 's-1',
			ts: Date.now(),
			senderName: '张三',
			self: false,
			kind: 'chat',
			text: '备份方案还是用 restic 吧',
			msgId: 'm1',
		});
		expect(seq).toBeGreaterThan(0);
		const chunkId = db.insertChunk({
			chatKey: 'g-1',
			startSeq: seq!,
			endSeq: seq!,
			ts: Date.now(),
			text: '张三: 备份方案还是用 restic 吧',
			msgCount: 1,
			hash: 'h1',
		});
		expect(chunkId).toBeGreaterThan(0);
		const hits = db.searchChunksFts('g-1', '备份', 10);
		expect(hits.map(hit => hit.id)).toEqual([chunkId]);
		expect(db.chunksByIds([chunkId!])[0]?.text).toContain('restic');
		expect(db.recentChunks('g-1', 10)).toHaveLength(1);
		db.close();
	});

	it('重复 msg_id / chunk hash 不重复入库', async () => {
		const db = await open();
		const record = {
			chatKey: 'g-1',
			sessionId: 's-1',
			ts: Date.now(),
			senderName: '张三',
			self: false,
			kind: 'chat' as const,
			text: 'hello',
			msgId: 'm1',
		};
		expect(db.insertMessage(record)).toBeGreaterThan(0);
		expect(db.insertMessage(record)).toBeUndefined();
		const draft = { chatKey: 'g-1', startSeq: 1, endSeq: 1, ts: Date.now(), text: 'x', msgCount: 1, hash: 'h1' };
		expect(db.insertChunk(draft)).toBeGreaterThan(0);
		expect(db.insertChunk(draft)).toBeUndefined();
		db.close();
	});

	it('技能 upsert / 列表 / tombstone', async () => {
		const db = await open();
		const skill = db.upsertSkill({
			chatKey: 'g-1',
			name: '备份排查',
			description: '按日志、磁盘、快照顺序排查',
			whenToUse: '用户说备份失败时',
			body: '1. 先看快照',
		});
		expect(skill?.id).toBeGreaterThan(0);
		expect(db.getSkill('g-1', '备份排查')?.name).toBe('备份排查');
		expect(db.listSkills('g-1')).toHaveLength(1);
		const updated = db.upsertSkill({
			chatKey: 'g-1',
			name: '备份排查',
			description: '更新后的描述',
			whenToUse: '用户说备份失败时',
			body: '1. 先看快照\n2. 再看磁盘',
		});
		expect(updated?.version).toBe(2);
		expect(db.deleteSkill('g-1', skill!.id, 'admin')).toBe(true);
		expect(db.listSkills('g-1')).toHaveLength(0);
		expect(db.isSkillTombstoned('g-1', '备份排查', '更新后的描述', '用户说备份失败时', '1. 先看快照\n2. 再看磁盘')).toBe(true);
		db.close();
	});

	it('stats / prune / reindex', async () => {
		const db = await open();
		db.insertMessage({
			chatKey: 'g-1',
			sessionId: 's-1',
			ts: Date.now(),
			senderName: '张三',
			self: false,
			kind: 'chat',
			text: 'hello',
			msgId: 'm1',
		});
		db.insertChunk({ chatKey: 'g-1', startSeq: 1, endSeq: 1, ts: Date.now(), text: 'x', msgCount: 1, hash: 'h1' });
		expect(db.stats()).toMatchObject({ messages: 1, chunks: 1 });
		expect(db.prune(Date.now(), 1, 100, 100)).toBe(0);
		expect(db.reindex('g-1')).toBe(1);
		expect(db.stats()).toMatchObject({ chunks: 0 });
		db.close();
	});
});
