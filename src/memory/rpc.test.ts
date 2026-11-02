import { describe, expect, it } from 'vitest';
import { handleMemoryRpc } from './rpc.ts';
import type { MemoryService } from './service.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('memory/models/download', () => {
	it('把 model 转给 MemoryService，并回 started', async () => {
		const calls: string[] = [];
		const memory = {
			downloadModel: async (model: 'embedding' | 'reranker') => {
				calls.push(model);
			},
		} as unknown as MemoryService;
		const result = await handleMemoryRpc('memory/models/download', { model: 'reranker' }, { memory, logger });
		expect(calls).toEqual(['reranker']);
		expect(result).toEqual({ ok: true, value: { started: true, model: 'reranker' } });
	});

	it('非法 model 返回 invalid，不触达下游', async () => {
		let called = false;
		const memory = {
			downloadModel: async () => {
				called = true;
			},
		} as unknown as MemoryService;
		const result = await handleMemoryRpc('memory/models/download', { model: 'nope' }, { memory, logger });
		expect(called).toBe(false);
		expect(result?.ok).toBe(false);
	});

	it('下游抛错（运行时尚不可用）转成 internal 并带原文', async () => {
		const memory = {
			downloadModel: async () => {
				throw new Error('本地推理运行时不可用：runtime 未安装');
			},
		} as unknown as MemoryService;
		const result = await handleMemoryRpc('memory/models/download', { model: 'embedding' }, { memory, logger });
		expect(result).toEqual({ ok: false, error: { code: 'internal', message: '本地推理运行时不可用：runtime 未安装' } });
	});
});
