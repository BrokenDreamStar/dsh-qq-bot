/**
 * /memory 命令的行为测试（含"未启用时的降级提示"）。
 *
 * 命令是最容易被误改坏的一环：它依赖 CommandContext 注入的 memory 服务，
 * 而该服务在未启用时是一个 ready=false 的空实现 —— 这里把两条路径都钉住。
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './index.ts';
import type { CommandContext } from './index.ts';
import type { MemoryLike } from '../memory/index.ts';

interface Captured {
	replies: string[];
	distilled: Array<{ chatKey: string; force?: boolean }>;
	unfrozen: string[];
}

function context(memory: MemoryLike | undefined): { ctx: CommandContext; captured: Captured } {
	const captured: Captured = { replies: [], distilled: [], unfrozen: [] };
	const ctx = {
		arg: '',
		bridge: { key: 'g-888', label: '群 888' },
		memory,
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
		cardSection: () => '【长期记忆】1. 本群 偏好 回复简短',
		guidanceSection: () => '',
		unfreeze: (chatKey) => {
			(base as unknown as { _u?: string[] })._u?.push(chatKey);
		},
		takeHandoff: async () => '',
		prefetch: () => '',
		onGenerationEnd: async () => {},
		resetTurnWriteFailures: () => {},
		distill: async () => true,
		chatStats: () => ({ facts: 1, events: 3 }),
		recall: () => ({ text: '', count: 0, candidates: 0 }),
		memorize: () => ({ ok: true, text: '' }),
		reconfigure: () => {},
		stats: () => ({ enabled: true, chats: 1, facts: 1, events: 3, rev: 1 }),
		dispose: () => {},
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

	it('默认展示卡片、本会话统计与全库统计', async () => {
		const { ctx, captured } = context(fakeMemory());
		await COMMANDS.memory!.run(ctx);
		const text = captured.replies.join('\n');
		expect(text).toContain('【长期记忆】群 888');
		expect(text).toContain('卡片：1 条事实；档案：3 条消息');
		expect(text).toContain('全库 1 条事实 / 3 条消息 / 1 个会话');
		expect(text).toContain('本群 偏好 回复简短');
	});

	it('卡片为空时给出明确文案而不是空白', async () => {
		const { ctx, captured } = context(fakeMemory({ cardSection: () => '' }));
		await COMMANDS.memory!.run(ctx);
		expect(captured.replies.join('\n')).toContain('还没有记忆条目');
	});

	it('distill 子命令强制蒸馏并回报结果', async () => {
		const calls: Array<{ chatKey: string; force?: boolean }> = [];
		const { ctx, captured } = context(
			fakeMemory({
				distill: async (chatKey, options) => {
					calls.push({ chatKey, ...(options ?? {}) });
					return true;
				},
			}),
		);
		ctx.arg = 'distill';
		await COMMANDS.memory!.run(ctx);
		expect(calls).toEqual([{ chatKey: 'g-888', force: true }]);
		expect(captured.replies.join('\n')).toContain('长期记忆已更新');
	});

	it('distill 没有可蒸馏内容时如实说明', async () => {
		const { ctx, captured } = context(fakeMemory({ distill: async () => false }));
		ctx.arg = 'distill';
		await COMMANDS.memory!.run(ctx);
		expect(captured.replies.join('\n')).toContain('没有可蒸馏的新内容');
	});

	it('distill 失败时把失败原因回给用户（不让用户去翻看不到的日志）', async () => {
		const { ctx, captured } = context(
			fakeMemory({
				distill: async () => false,
				lastDistillError: () => '蒸馏调用失败：no adapter for provider deepseek-official',
			}),
		);
		ctx.arg = 'distill';
		await COMMANDS.memory!.run(ctx);
		const text = captured.replies.join('\n');
		expect(text).toContain('蒸馏失败');
		expect(text).toContain('no adapter for provider');
	});

	it('reload 解冻卡片缓存', async () => {
		const unfrozen: string[] = [];
		const { ctx, captured } = context(
			fakeMemory({
				unfreeze: (chatKey) => {
					unfrozen.push(chatKey);
				},
			}),
		);
		ctx.arg = 'reload';
		await COMMANDS.memory!.run(ctx);
		expect(unfrozen).toEqual(['g-888']);
		expect(captured.replies.join('\n')).toContain('解冻');
	});
});
