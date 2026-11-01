/**
 * /memory 命令的行为测试（RAG 版）。
 *
 * 命令依赖 CommandContext 注入的 memory 服务；未启用时是 ready=false 的空实现。
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './index.ts';
import type { CommandContext } from './index.ts';
import type { MemoryLike } from '../memory/index.ts';

interface Captured {
	replies: string[];
}

function context(memory: MemoryLike | undefined): { ctx: CommandContext; captured: Captured } {
	const captured: Captured = { replies: [] };
	const ctx = {
		arg: '',
		bridge: { key: 'g-888', label: '群 888' },
		memory,
		admins: { isAdmin: () => true },
		msg: { senderId: '1001' },
		reply: async (text: string) => {
			captured.replies.push(text);
		},
	} as unknown as CommandContext;
	return { ctx, captured };
}

function fakeMemory(overrides: Partial<MemoryLike> = {}): MemoryLike {
	const base: MemoryLike = {
		ready: true,
		record: () => undefined,
		prefetch: async () => '',
		recall: async () => ({ text: '（没有找到相关的历史聊天记录）', count: 0, candidates: 0 }),
		skills: async () => '',
		useSkill: async () => undefined,
		listSkills: async () => [],
		recent: async () => [],
		deleteChunk: async () => true,
		reindex: async () => 3,
		prune: async () => 1,
		setup: async () => ({ installed: true, runtimeDir: '/tmp/rt' }),
		stats: async () => ({
			ready: true,
			db: true,
			fts: true,
			vec: true,
			embed: true,
			rerank: false,
			runtime: 'ready',
			model: 'ready',
			messages: 10,
			chunks: 3,
			skills: 1,
		}),
		reconfigure: () => undefined,
		dispose: async () => undefined,
	};
	return { ...base, ...overrides };
}

describe('/memory 命令', () => {
	it('未启用时给出可操作的提示', async () => {
		const { ctx, captured } = context(fakeMemory({ ready: false }));
		await COMMANDS.memory!.run(ctx);
		expect(captured.replies[0]).toContain('未启用');
		expect(captured.replies[0]).toContain('长期记忆');
	});

	it('缺少 memory 依赖时同样降级（不抛错）', async () => {
		const { ctx, captured } = context(undefined);
		await COMMANDS.memory!.run(ctx);
		expect(captured.replies[0]).toContain('未启用');
	});

	it('默认展示状态、统计与组件状态', async () => {
		const { ctx, captured } = context(fakeMemory());
		await COMMANDS.memory!.run(ctx);
		const text = captured.replies.join('\n');
		expect(text).toContain('【长期记忆】群 888');
		expect(text).toContain('10 条消息');
		expect(text).toContain('3 个片段');
		expect(text).toContain('DB=✓');
		expect(text).toContain('向量=✓');
	});

	it('search 调 recall 并把结果回给用户', async () => {
		const calls: Array<{ chatKey: string; query: string; count?: number }> = [];
		const { ctx, captured } = context(
			fakeMemory({
				recall: async (chatKey, query, count) => {
					calls.push({ chatKey, query, ...(count !== undefined ? { count } : {}) });
					return { text: '【会话档案】备份方案', count: 1, candidates: 3 };
				},
			}),
		);
		ctx.arg = 'search 备份';
		await COMMANDS.memory!.run(ctx);
		expect(calls).toEqual([{ chatKey: 'g-888', query: '备份', count: 8 }]);
		expect(captured.replies.join('\n')).toContain('备份方案');
	});

	it('recent 展示最近片段', async () => {
		const { ctx, captured } = context(
			fakeMemory({
				recent: async () => [
					{ id: 7, chatKey: 'g-888', startSeq: 1, endSeq: 2, ts: Date.now(), text: '张三: 我用 restic 试了', score: 0.9, rrf: 0.8 },
				],
			}),
		);
		ctx.arg = 'recent';
		await COMMANDS.memory!.run(ctx);
		const text = captured.replies.join('\n');
		expect(text).toContain('#7');
		expect(text).toContain('restic');
	});

	it('forget 删除片段', async () => {
		const deleted: number[] = [];
		const { ctx, captured } = context(
			fakeMemory({
				deleteChunk: async id => {
					deleted.push(id);
					return true;
				},
			}),
		);
		ctx.arg = 'forget 3';
		await COMMANDS.memory!.run(ctx);
		expect(deleted).toEqual([3]);
		expect(captured.replies.join('\n')).toContain('已删除片段 #3');
	});

	it('reindex 重建索引', async () => {
		const reindexed: string[] = [];
		const { ctx, captured } = context(
			fakeMemory({
				reindex: async chatKey => {
					if (chatKey !== undefined) reindexed.push(chatKey);
					return 3;
				},
			}),
		);
		ctx.arg = 'reindex';
		await COMMANDS.memory!.run(ctx);
		expect(reindexed).toEqual(['g-888']);
		expect(captured.replies.join('\n')).toContain('删除 3 个旧片段');
	});

	it('prune 清理', async () => {
		const { ctx, captured } = context(fakeMemory());
		ctx.arg = 'prune';
		await COMMANDS.memory!.run(ctx);
		expect(captured.replies.join('\n')).toContain('已清理 1 条');
	});

	it('setup 安装运行时', async () => {
		const { ctx, captured } = context(fakeMemory());
		ctx.arg = 'setup';
		await COMMANDS.memory!.run(ctx);
		expect(captured.replies.join('\n')).toContain('运行时已就绪');
	});
});
