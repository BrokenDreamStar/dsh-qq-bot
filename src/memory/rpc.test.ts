import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService, type MemoryConfigView } from './service.ts';
import { openMemoryDatabase, type MemoryStore } from './store.ts';
import { handleMemoryRpc } from './rpc.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function config(): MemoryConfigView {
	return {
		memoryEnabled: true,
		memoryCardMaxChars: 600,
		memoryMaxFacts: 200,
		memoryMaxWriteFailuresPerTurn: 3,
		memoryRecallEnabled: true,
		memoryRecallTopK: 8,
		memoryRecallMaxChars: 1500,
		memoryRecallHalfLifeDays: 30,
		memoryPrefetch: true,
		memoryPrefetchMinScore: 0.35,
		memoryPrefetchMaxItems: 3,
		memoryDistillEvery: 10,
		memoryDistillMinChars: 800,
		memoryDistillIdleMs: 0,
		memoryDistillProvider: '',
		memoryDistillModel: '',
		memoryDistillMaxTokens: 800,
		memoryDistillRetryTokens: 16000,
		memoryDistillTimeoutMs: 15000,
		memoryHandoffTail: 10,
		memoryHandoffDistillWaitMs: 0,
		memoryRetentionDays: 90,
		memoryMaxEventsPerChat: 20000,
	};
}

let dir: string;
let store: MemoryStore | undefined;
let memory: MemoryService | undefined;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'dshqq-memory-rpc-'));
	const opened = await openMemoryDatabase({ filePath: join(dir, 'memory.db'), logger, maxEventsPerChat: 1000, retentionDays: 90 });
	if (!opened.ok) throw new Error(opened.reason);
	store = opened.store;
	memory = new MemoryService({
		config: config(),
		logger,
		getLlm: () => undefined,
		getDefaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
		labelOf: (chatKey) => `群 ${chatKey.slice(2)}`,
		createUserMessage: (text) => ({ role: 'user', content: [{ type: 'text', text }] }),
		idleSweepMs: 0,
	});
	memory.attach(store);
});

afterEach(() => {
	memory?.dispose();
	memory = undefined;
	store = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe('memory RPC', () => {
	it('save → list → preview → delete', async () => {
		if (memory === undefined) throw new Error('缺少 service');
		const saved = await handleMemoryRpc('memory/save', { chatKey: 'g-888', content: '本群偏好回复简短' }, { memory, logger });
		expect(saved?.ok).toBe(true);
		const listed = await handleMemoryRpc('memory/list', { chatKey: 'g-888' }, { memory, logger });
		expect(listed?.ok).toBe(true);
		if (!listed?.ok) return;
		const items = (listed.value as { items: Array<{ id: number; content: string }> }).items;
		expect(items).toHaveLength(1);
		expect(items[0]?.content).toBe('本群偏好回复简短');

		const preview = await handleMemoryRpc('memory/preview', { chatKey: 'g-888', query: '回复' }, { memory, logger });
		expect(preview?.ok).toBe(true);
		if (preview?.ok) expect((preview.value as { profile: string }).profile).toContain('回复简短');

		const removed = await handleMemoryRpc('memory/delete', { chatKey: 'g-888', id: items[0]?.id }, { memory, logger });
		expect(removed?.ok).toBe(true);
		const after = await handleMemoryRpc('memory/list', { chatKey: 'g-888' }, { memory, logger });
		if (after?.ok) expect((after.value as { items: unknown[] }).items).toHaveLength(0);
	});

	it('缺 chatKey 时给出可操作错误；未知端点返回 undefined', async () => {
		if (memory === undefined) throw new Error('缺少 service');
		const bad = await handleMemoryRpc('memory/list', {}, { memory, logger });
		expect(bad?.ok).toBe(false);
		expect(await handleMemoryRpc('memory/nope', {}, { memory, logger })).toBeUndefined();
	});
});
